import { Packet } from '@dcl/protocol/out-js/decentraland/kernel/comms/rfc4/comms.gen'
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteParticipant,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoSource
} from '@livekit/rtc-node'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import type { ILiveKitPublisher, ILiveKitPublisherComponent, PresenterCameraTrackHandler } from './types'
import type { RemoteTrack } from '@livekit/rtc-node'

const PROTOCOL_VERSION = 100
const MSG_TYPE_COMMS_DATA = 3
const PRESENTATION_TOPIC = 'presentation'

/**
 * Encodes topic + JSON data into the CommsData wire format.
 * Wire format after MsgType byte: [topicLen 2 bytes LE][topic UTF-8][data UTF-8].
 */
function encodeCommsPayload(topic: string, jsonData: string): Uint8Array {
  const topicBytes = new TextEncoder().encode(topic)
  const dataBytes = new TextEncoder().encode(jsonData)
  // [MsgType 1 byte][topicLen 2 bytes LE][topic][data]
  const payload = new Uint8Array(1 + 2 + topicBytes.length + dataBytes.length)
  payload[0] = MSG_TYPE_COMMS_DATA
  payload[1] = topicBytes.length & 0xff
  payload[2] = (topicBytes.length >> 8) & 0xff
  payload.set(topicBytes, 3)
  payload.set(dataBytes, 3 + topicBytes.length)
  return payload
}

/**
 * Decodes CommsData wire format from Scene.data.
 * Expects the full payload including the leading MsgType byte.
 * Returns { topic, data } or null if malformed.
 */
function decodeCommsPayload(sceneData: Uint8Array): { topic: string; data: string } | null {
  // sceneData[0] is MsgType — check it, then skip it.
  if (sceneData.length < 1 || sceneData[0] !== MSG_TYPE_COMMS_DATA) return null
  const inner = sceneData.subarray(1)
  if (inner.length < 2) return null
  const topicLen = inner[0] | (inner[1] << 8)
  if (inner.length < 2 + topicLen) return null
  const topic = new TextDecoder().decode(inner.subarray(2, 2 + topicLen))
  const data = new TextDecoder().decode(inner.subarray(2 + topicLen))
  return { topic, data }
}

function parsePresentersFromRoomMetadata(metadata: string | undefined): Set<string> {
  try {
    if (!metadata) return new Set()
    const parsed = JSON.parse(metadata)
    if (!Array.isArray(parsed?.presenters)) return new Set()
    return new Set(
      parsed.presenters
        .filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
        .map((p: string) => p.toLowerCase())
    )
  } catch {
    return new Set()
  }
}

function createPublisher(presentationId: string, logger: ILoggerComponent.ILogger): ILiveKitPublisher {
  let room: Room | null = null
  let videoSource: VideoSource | null = null
  let videoTrack: LocalVideoTrack | null = null
  let audioSource: AudioSource | null = null
  let audioTrack: LocalAudioTrack | null = null
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null
  let dataHandler: ((data: Record<string, unknown>) => void) | null = null
  let presenters: Set<string> = new Set()
  let lastSceneId = ''
  let presenterCameraHandler: PresenterCameraTrackHandler | null = null
  // Tracks the currently-active presenter camera so we don't fire 'active' twice
  // for the same publication if multiple presenters race to enable their cameras.
  let activePresenterCameraSid: string | null = null

  function maybeActivatePresenterCamera(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void {
    if (!(track instanceof RemoteVideoTrack)) return
    if (publication.source !== TrackSource.SOURCE_CAMERA) return
    if (publication.muted) return
    const identity = (participant.identity || '').toLowerCase()
    if (!identity) return // never trust an anonymous participant against the presenters set
    if (!presenters.has(identity)) return
    // First-wins: if another presenter already has an active camera, ignore.
    if (activePresenterCameraSid && activePresenterCameraSid !== track.sid) return
    activePresenterCameraSid = track.sid ?? null
    logger.info(`[presenter-camera] active: ${participant.identity} sid=${track.sid}`)
    presenterCameraHandler?.({ kind: 'active', track, participant })
  }

  function deactivatePresenterCamera(): void {
    if (!activePresenterCameraSid) return
    logger.info(`[presenter-camera] inactive (sid was ${activePresenterCameraSid})`)
    activePresenterCameraSid = null
    presenterCameraHandler?.({ kind: 'inactive' })
  }

  /**
   * Sub/unsub every SOURCE_CAMERA publication on a participant based on whether
   * they're a presenter. Idempotent (setSubscribed is a no-op when state matches).
   * setSubscribed's TS signature returns void but the runtime call may throw or
   * reject — both paths are caught and logged.
   */
  function applyPresenterSubscription(participant: RemoteParticipant, isPresenter: boolean): void {
    for (const publication of participant.trackPublications.values()) {
      if (publication.source !== TrackSource.SOURCE_CAMERA) continue
      try {
        const maybe = publication.setSubscribed(isPresenter) as unknown
        if (maybe && typeof (maybe as Promise<unknown>).catch === 'function') {
          ;(maybe as Promise<unknown>).catch((err: unknown) => {
            logger.warn(
              `Failed to ${isPresenter ? 'subscribe to' : 'unsubscribe from'} camera publication: ${err instanceof Error ? err.message : String(err)}`
            )
          })
        }
      } catch (err) {
        logger.warn(
          `Failed to ${isPresenter ? 'subscribe to' : 'unsubscribe from'} camera publication: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      const track = publication.track
      if (isPresenter && track instanceof RemoteVideoTrack) {
        maybeActivatePresenterCamera(track, publication, participant)
      }
    }
  }

  return {
    async connect(url: string, token: string): Promise<void> {
      room = new Room()
      const CONNECT_TIMEOUT_MS = 20_000
      let connectTimer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          room.connect(url, token),
          new Promise<never>((_, reject) => {
            connectTimer = setTimeout(
              () => reject(new Error(`LiveKit connect timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
              CONNECT_TIMEOUT_MS
            )
          })
        ])
      } catch (err) {
        try {
          await room.disconnect()
        } catch {
          /* noop — best-effort cleanup of partial connection */
        }
        room = null
        throw err
      } finally {
        if (connectTimer) clearTimeout(connectTimer)
      }

      const localParticipant = room.localParticipant
      if (localParticipant) {
        await localParticipant.updateMetadata(JSON.stringify({ role: 'presentation', presentationId }))
      }

      presenters = parsePresentersFromRoomMetadata(room.metadata)
      logger.info(`[connect] Initial presenters: ${[...presenters].join(', ') || 'none'}`)

      room.on(RoomEvent.RoomMetadataChanged, (metadata: string) => {
        const prev = presenters
        const next = parsePresentersFromRoomMetadata(metadata)
        presenters = next

        // Only act on identities whose presenter status flipped — avoids re-touching
        // every camera publication in the room on every metadata change.
        const flipped = new Map<string, boolean>() // identity -> isPresenter (after)
        for (const id of next) if (!prev.has(id)) flipped.set(id, true)
        for (const id of prev) if (!next.has(id)) flipped.set(id, false)

        if (flipped.size === 0) return

        const added = [...flipped].filter(([, v]) => v).map(([k]) => k)
        const removed = [...flipped].filter(([, v]) => !v).map(([k]) => k)
        logger.info(`[RoomMetadataChanged] presenters Δ +[${added.join(',') || '-'}] -[${removed.join(',') || '-'}]`, {
          rawMetadata: metadata
        })

        for (const participant of room?.remoteParticipants.values() ?? []) {
          const identity = (participant.identity || '').toLowerCase()
          const isPresenter = flipped.get(identity)
          if (isPresenter === undefined) continue
          applyPresenterSubscription(participant, isPresenter)
        }
      })

      room.on(
        RoomEvent.DataReceived,
        (
          payload: Uint8Array,
          participant?: { identity?: string; metadata?: string },
          _kind?: unknown,
          topic?: string
        ) => {
          const identity = participant?.identity || 'unknown'
          const isPresenter = presenters.has(identity.toLowerCase())

          let message: Record<string, unknown> | undefined
          let incomingSceneId: string | undefined

          // Try protobuf decode first (Packet { Scene { data: [MsgType.CommsData][topicLen][topic][json] } }).
          try {
            const packet = Packet.decode(payload)
            if (packet.message?.$case === 'scene') {
              if (packet.message.scene.sceneId) {
                incomingSceneId = packet.message.scene.sceneId
              }
              const decoded = decodeCommsPayload(packet.message.scene.data)
              if (decoded && decoded.topic === PRESENTATION_TOPIC) {
                message = JSON.parse(decoded.data)
              }
            }
          } catch {
            // Fallback: raw JSON for backward compatibility during migration.
            try {
              message = JSON.parse(new TextDecoder().decode(payload))
            } catch {
              /* ignored */
            }
          }

          if (!message) return

          const msgType = typeof message.type === 'string' ? message.type : ''
          logger.debug(`[DataReceived] from=${identity} topic=${topic || 'none'} type=${msgType}`)

          if (!dataHandler) return
          if (!msgType.startsWith('presentation:')) return

          logger.info(
            `[DataReceived] from=${identity} presenter=${isPresenter} topic=${topic || 'none'} type=${msgType}`
          )

          if (!isPresenter) {
            logger.warn(
              `[DataReceived] Identity '${identity}' not in presenters list [${[...presenters].join(', ')}], ignoring`
            )
            return
          }

          // Only update sceneId from authorized presenter messages
          if (incomingSceneId) {
            lastSceneId = incomingSceneId
          }

          logger.info(`[DataReceived] Processing command: ${msgType}`)
          dataHandler(message)
        }
      )

      room.on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          maybeActivatePresenterCamera(track, publication, participant)
        }
      )

      room.on(
        RoomEvent.TrackUnsubscribed,
        (track: RemoteTrack, _publication: RemoteTrackPublication, _participant: RemoteParticipant) => {
          if (activePresenterCameraSid && track.sid === activePresenterCameraSid) {
            deactivatePresenterCamera()
          }
        }
      )

      room.on(RoomEvent.TrackMuted, (publication, _participant) => {
        if (activePresenterCameraSid && publication.sid === activePresenterCameraSid) {
          deactivatePresenterCamera()
        }
      })

      room.on(RoomEvent.TrackUnmuted, (publication, participant) => {
        if (!(publication instanceof RemoteTrackPublication)) return
        if (!(participant instanceof RemoteParticipant)) return
        if (!presenters.has((participant.identity || '').toLowerCase())) return
        if (publication.source !== TrackSource.SOURCE_CAMERA) return
        const track = publication.track
        if (track instanceof RemoteVideoTrack) {
          maybeActivatePresenterCamera(track, publication, participant)
        }
      })

      // Explicit subscription fallback: @livekit/rtc-node may not auto-subscribe to
      // remote tracks depending on room/server config. We can't verify the live
      // behaviour from this environment, so we eagerly call setSubscribed(true) on
      // every PRESENTER camera publication present at connect time. Non-presenter
      // cameras are intentionally skipped — subscribing to them wastes bandwidth
      // and the application would never use the decoded frames (see security-review.md
      // Medium — Eager setSubscribed(true) on every camera publication).
      for (const participant of room.remoteParticipants.values()) {
        const identity = (participant.identity || '').toLowerCase()
        if (!presenters.has(identity)) continue
        applyPresenterSubscription(participant, true)
      }
    },

    async startPublishing(width: number, height: number): Promise<void> {
      if (!room) throw new Error('Not connected')

      videoSource = new VideoSource(width, height)
      videoTrack = LocalVideoTrack.createVideoTrack('presentation', videoSource)
      const publishOptions = new TrackPublishOptions({
        source: TrackSource.SOURCE_SCREENSHARE,
        videoCodec: VideoCodec.VP8,
        videoEncoding: {
          maxBitrate: BigInt(6_000_000),
          maxFramerate: 30
        },
        simulcast: false,
        stream: 'presentation'
      })
      const localParticipant = room.localParticipant
      if (!localParticipant) throw new Error('No local participant')
      await localParticipant.publishTrack(videoTrack, publishOptions)
    },

    pushFrame(buffer: Buffer, width: number, height: number, bufferType?: number, timestampUs?: bigint): void {
      if (!videoSource) return
      const frame = new VideoFrame(buffer, width, height, bufferType ?? VideoBufferType.RGBA)
      videoSource.captureFrame(frame, timestampUs)
    },

    startHeartbeat(buffer: Buffer, width: number, height: number, bufferType?: number): void {
      this.stopHeartbeat()
      heartbeatInterval = setInterval(() => {
        this.pushFrame(buffer, width, height, bufferType)
      }, 500)
    },

    stopHeartbeat(): void {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
      }
    },

    async startAudioPublishing(sampleRate: number, channels: number): Promise<void> {
      if (!room) throw new Error('Not connected')
      audioSource = new AudioSource(sampleRate, channels, 200)
      audioTrack = LocalAudioTrack.createAudioTrack('presentation-audio', audioSource)
      const options = new TrackPublishOptions({
        source: TrackSource.SOURCE_SCREENSHARE_AUDIO,
        stream: 'presentation'
      })
      const localParticipant = room.localParticipant
      if (!localParticipant) throw new Error('No local participant')
      await localParticipant.publishTrack(audioTrack, options)
    },

    pushAudioFrame(pcmData: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number): void {
      if (!audioSource) return
      const frame = new AudioFrame(pcmData, sampleRate, channels, samplesPerChannel)
      audioSource.captureFrame(frame).catch(() => {
        /* track not ready yet, drop frame */
      })
    },

    async stopAudioPublishing(): Promise<void> {
      // Null the closure refs synchronously before awaiting close(). If a
      // concurrent startAudioPublishing runs during the await, it rebinds
      // audioTrack/audioSource to its new refs — and nulling them after
      // the await would silently wipe out the new track.
      const track = audioTrack
      const source = audioSource
      audioTrack = null
      audioSource = null
      if (track) {
        try {
          await track.close(true)
        } catch (err) {
          logger.warn(`Failed to close audio track: ${err instanceof Error ? err.message : String(err)}`)
        }
      } else if (source) {
        try {
          await source.close()
        } catch (err) {
          logger.warn(`Failed to close audio source: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    },

    setDataHandler(handler: (data: Record<string, unknown>) => void): void {
      dataHandler = handler
    },

    setPresenterCameraTrackHandler(handler: PresenterCameraTrackHandler | null): void {
      presenterCameraHandler = handler
    },

    async updateMetadataState(state: object): Promise<void> {
      if (!room?.localParticipant) return
      await room.localParticipant.updateMetadata(JSON.stringify({ role: 'presentation', presentationId, ...state }))
    },

    async publishData(message: Record<string, unknown>): Promise<void> {
      if (!room) return
      const localParticipant = room.localParticipant
      if (!localParticipant) return

      const sceneData = encodeCommsPayload(PRESENTATION_TOPIC, JSON.stringify(message))

      const packet = Packet.encode({
        message: { $case: 'scene', scene: { sceneId: lastSceneId, data: sceneData } },
        protocolVersion: PROTOCOL_VERSION
      }).finish()

      await localParticipant.publishData(packet, {
        reliable: true
      })
    },

    getRemoteParticipantCount(): number {
      if (!room) return 0
      return room.remoteParticipants.size
    },

    async disconnect(): Promise<void> {
      this.stopHeartbeat()
      await this.stopAudioPublishing()
      presenters = new Set()
      activePresenterCameraSid = null
      presenterCameraHandler = null

      // WORKAROUND: @livekit/rtc-node leaks file descriptors and memory on disconnect
      // because Room.disconnect() never disposes its native FFI handle. We manually
      // close tracks/sources and dispose handles below. The true fix belongs in the
      // SDK itself — see https://github.com/livekit/node-sdks for upstream status.

      // Close video track + source FIRST (disposes their native FFI handles)
      // LocalVideoTrack.close(true) also closes the underlying VideoSource
      if (videoTrack) {
        try {
          await videoTrack.close(true)
        } catch (err) {
          logger.warn(`Failed to close video track: ${err instanceof Error ? err.message : String(err)}`)
        }
        videoTrack = null
        videoSource = null
      } else if (videoSource) {
        try {
          await videoSource.close()
        } catch (err) {
          logger.warn(`Failed to close video source: ${err instanceof Error ? err.message : String(err)}`)
        }
        videoSource = null
      }

      // Disconnect room (cleans up JS listeners, sends FFI disconnect request)
      if (room) {
        await room.disconnect()

        // Room.disconnect() does NOT dispose its native FFI handle — known SDK leak.
        // Manually dispose to free the Rust-side Room struct and its file descriptors.
        try {
          const roomAny = room as unknown as { ffiHandle?: { dispose(): void } }
          roomAny.ffiHandle?.dispose()
        } catch {
          // Best-effort — if SDK changes internals, we just skip
        }
        room = null
      }
    }
  }
}

export function createLiveKitPublisherComponent(): ILiveKitPublisherComponent {
  return {
    createPublisher
  }
}
