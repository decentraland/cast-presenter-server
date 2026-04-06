import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  LocalVideoTrack,
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
import type { ILiveKitPublisher, ILiveKitPublisherComponent } from './types'

function parsePresentersFromRoomMetadata(metadata: string | undefined): Set<string> {
  try {
    if (!metadata) return new Set()
    const parsed = JSON.parse(metadata)
    return Array.isArray(parsed?.presenters)
      ? new Set(parsed.presenters.map((p: string) => p.toLowerCase()))
      : new Set()
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

  return {
    async connect(url: string, token: string): Promise<void> {
      room = new Room()
      await room.connect(url, token)

      const localParticipant = room.localParticipant
      if (localParticipant) {
        await localParticipant.updateMetadata(JSON.stringify({ role: 'presentation', presentationId }))
      }

      presenters = parsePresentersFromRoomMetadata(room.metadata)
      logger.info(`[connect] Initial presenters: ${[...presenters].join(', ') || 'none'}`)

      room.on(RoomEvent.RoomMetadataChanged, (metadata: string) => {
        presenters = parsePresentersFromRoomMetadata(metadata)
        logger.info(`[RoomMetadataChanged] Presenters updated: ${[...presenters].join(', ') || 'none'}`)
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
          let isJson = false
          try {
            message = JSON.parse(new TextDecoder().decode(payload))
            isJson = true
          } catch {
            /* ignored */
          }

          if (!dataHandler) return
          if (!isJson || !message) return

          const msgType = typeof message.type === 'string' ? message.type : ''
          if (topic !== 'presentation' && !msgType.startsWith('presentation:')) return

          logger.info(
            `[DataReceived] from=${identity} presenter=${isPresenter} topic=${topic || 'none'} type=${msgType}`
          )

          if (!isPresenter) {
            logger.warn(`[DataReceived] Identity '${identity}' not in presenters list, ignoring`)
            return
          }

          logger.info(`[DataReceived] Processing command: ${msgType}`)
          dataHandler(message)
        }
      )
    },

    async startPublishing(width: number, height: number): Promise<void> {
      if (!room) throw new Error('Not connected')

      videoSource = new VideoSource(width, height)
      videoTrack = LocalVideoTrack.createVideoTrack('presentation', videoSource)
      const publishOptions = new TrackPublishOptions({
        source: TrackSource.SOURCE_SCREENSHARE,
        videoCodec: VideoCodec.H264,
        videoEncoding: {
          maxBitrate: BigInt(8_000_000),
          maxFramerate: 15
        },
        simulcast: false,
        stream: 'presentation'
      })
      const localParticipant = room.localParticipant
      if (!localParticipant) throw new Error('No local participant')
      await localParticipant.publishTrack(videoTrack, publishOptions)
    },

    pushFrame(rgbaBuffer: Buffer, width: number, height: number): void {
      if (!videoSource) return
      const frame = new VideoFrame(rgbaBuffer, width, height, VideoBufferType.RGBA)
      videoSource.captureFrame(frame)
    },

    startHeartbeat(rgbaBuffer: Buffer, width: number, height: number): void {
      this.stopHeartbeat()
      heartbeatInterval = setInterval(() => {
        this.pushFrame(rgbaBuffer, width, height)
      }, 33)
    },

    stopHeartbeat(): void {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
      }
    },

    async startAudioPublishing(sampleRate: number, channels: number): Promise<void> {
      if (!room) throw new Error('Not connected')
      audioSource = new AudioSource(sampleRate, channels, 5)
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
      void audioSource.captureFrame(frame)
    },

    async stopAudioPublishing(): Promise<void> {
      if (audioTrack) {
        try {
          await audioTrack.close(true)
        } catch (err) {
          logger.warn(`Failed to close audio track: ${err instanceof Error ? err.message : String(err)}`)
        }
        audioTrack = null
        audioSource = null
      } else if (audioSource) {
        try {
          await audioSource.close()
        } catch (err) {
          logger.warn(`Failed to close audio source: ${err instanceof Error ? err.message : String(err)}`)
        }
        audioSource = null
      }
    },

    setDataHandler(handler: (data: Record<string, unknown>) => void): void {
      dataHandler = handler
    },

    async updateMetadataState(state: Record<string, unknown>): Promise<void> {
      if (!room?.localParticipant) return
      await room.localParticipant.updateMetadata(JSON.stringify({ role: 'presentation', presentationId, ...state }))
    },

    async publishData(message: Record<string, unknown>): Promise<void> {
      if (!room) return
      const data = new TextEncoder().encode(JSON.stringify(message))
      const localParticipant = room.localParticipant
      if (!localParticipant) return
      await localParticipant.publishData(data, {
        topic: 'presentation',
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
