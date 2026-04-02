import {
  LocalVideoTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoFrame,
  VideoSource
} from '@livekit/rtc-node'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import type { ILiveKitPublisher, ILiveKitPublisherComponent } from './types'

function createPublisher(
  presentationId: string,
  logger: ILoggerComponent.ILogger,
  allowedRoles?: Set<string>
): ILiveKitPublisher {
  let room: Room | null = null
  let videoSource: VideoSource | null = null
  let videoTrack: LocalVideoTrack | null = null
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null
  let dataHandler: ((data: Record<string, unknown>) => void) | null = null
  const roles = allowedRoles || new Set(['streamer', 'presenter', 'presentation'])

  function parseExistingMetadata(participant: { metadata?: string }): Record<string, unknown> {
    try {
      return participant.metadata ? JSON.parse(participant.metadata) : {}
    } catch {
      return {}
    }
  }

  return {
    async connect(url: string, token: string): Promise<void> {
      room = new Room()
      await room.connect(url, token)

      const localParticipant = room.localParticipant
      if (localParticipant) {
        const existing = parseExistingMetadata(localParticipant)
        await localParticipant.updateMetadata(JSON.stringify({ ...existing, role: 'presentation', presentationId }))
      }

      room.on(
        RoomEvent.DataReceived,
        (
          payload: Uint8Array,
          participant?: { identity?: string; metadata?: string },
          _kind?: unknown,
          topic?: string
        ) => {
          const identity = participant?.identity || 'unknown'
          let senderRole = 'unknown'
          try {
            const meta = participant?.metadata ? JSON.parse(participant.metadata) : null
            senderRole = meta?.role || 'none'
          } catch {
            /* ignored */
          }

          let message: Record<string, unknown> | undefined
          let isJson = false
          try {
            message = JSON.parse(new TextDecoder().decode(payload))
            isJson = true
          } catch {
            /* ignored */
          }

          logger.info(
            `[DataReceived] from=${identity} role=${senderRole} topic=${topic || 'none'} json=${isJson} type=${message?.type || 'n/a'}`
          )

          if (!dataHandler) return
          if (!isJson || !message) return

          const msgType = typeof message.type === 'string' ? message.type : ''
          if (topic !== 'presentation' && !msgType.startsWith('presentation:')) return

          if (!roles.has(senderRole)) {
            logger.warn(`[DataReceived] Role '${senderRole}' from ${identity} not authorized, ignoring`)
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
        source: TrackSource.SOURCE_CAMERA,
        videoEncoding: {
          maxBitrate: BigInt(5_000_000),
          maxFramerate: 30
        },
        simulcast: false
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

    forceEncoderQuality(rgbaBuffer: Buffer, width: number, height: number): void {
      const noisy = Buffer.from(rgbaBuffer)
      for (let i = 0; i < 30; i++) {
        if (i % 2 === 0) {
          for (let p = 2; p < noisy.length && p < 4000; p += 4) {
            noisy[p] = rgbaBuffer[p] > 0 ? rgbaBuffer[p] - 1 : 1
          }
          this.pushFrame(noisy, width, height)
        } else {
          this.pushFrame(rgbaBuffer, width, height)
        }
      }
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

    setDataHandler(handler: (data: Record<string, unknown>) => void): void {
      dataHandler = handler
    },

    async updateMetadataState(state: Record<string, unknown>): Promise<void> {
      if (!room?.localParticipant) return
      const existing = parseExistingMetadata(room.localParticipant)
      await room.localParticipant.updateMetadata(
        JSON.stringify({ ...existing, role: 'presentation', presentationId, ...state })
      )
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
