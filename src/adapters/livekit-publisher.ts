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

export class LiveKitPublisher {
  private room: Room | null = null
  private videoSource: VideoSource | null = null
  private videoTrack: LocalVideoTrack | null = null
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private presentationId: string
  private dataHandler: ((data: Record<string, unknown>) => void) | null = null
  private allowedRoles: Set<string>
  private logger: { info: (msg: string) => void; warn: (msg: string) => void }

  constructor(
    presentationId: string,
    logger: { info: (msg: string) => void; warn: (msg: string) => void },
    allowedRoles?: Set<string>
  ) {
    this.presentationId = presentationId
    this.logger = logger
    this.allowedRoles = allowedRoles || new Set(['streamer', 'presenter', 'presentation'])
  }

  async connect(url: string, token: string): Promise<void> {
    this.room = new Room()
    await this.room.connect(url, token)

    // Set metadata after connecting
    const localParticipant = this.room.localParticipant
    if (localParticipant) {
      await localParticipant.updateMetadata(
        JSON.stringify({ role: 'presentation', presentationId: this.presentationId })
      )
    }

    // Listen for data channel messages for presentation control
    // Accept messages with topic 'presentation' OR topicless messages with 'presentation:' type prefix
    // (supports both cast2 web app and Unity clients that may not set topics)
    this.room.on(
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

        // Try to parse as JSON
        let message: Record<string, unknown> | undefined
        let isJson = false
        try {
          message = JSON.parse(new TextDecoder().decode(payload))
          isJson = true
        } catch {
          /* ignored */
        }

        this.logger.info(
          `[DataReceived] from=${identity} role=${senderRole} topic=${topic || 'none'} json=${isJson} type=${message?.type || 'n/a'}`
        )

        if (!this.dataHandler) return
        if (!isJson || !message) return

        // Only handle presentation commands (by topic or message type prefix)
        const msgType = typeof message.type === 'string' ? message.type : ''
        if (topic !== 'presentation' && !msgType.startsWith('presentation:')) return

        // Auth: check sender's metadata.role against allowed roles
        if (!this.allowedRoles.has(senderRole)) {
          this.logger.warn(`[DataReceived] Role '${senderRole}' from ${identity} not authorized, ignoring`)
          return
        }

        this.logger.info(`[DataReceived] Processing command: ${msgType}`)
        this.dataHandler(message)
      }
    )
  }

  async startPublishing(width: number, height: number): Promise<void> {
    if (!this.room) throw new Error('Not connected')

    this.videoSource = new VideoSource(width, height)
    this.videoTrack = LocalVideoTrack.createVideoTrack('presentation', this.videoSource)
    const publishOptions = new TrackPublishOptions({
      source: TrackSource.SOURCE_CAMERA,
      videoEncoding: {
        maxBitrate: BigInt(5_000_000), // 5 Mbps — high quality for sharp text/slides at 1280x720
        maxFramerate: 30
      },
      simulcast: false
    })
    const localParticipant = this.room.localParticipant
    if (!localParticipant) throw new Error('No local participant')
    await localParticipant.publishTrack(this.videoTrack, publishOptions)
  }

  pushFrame(rgbaBuffer: Buffer, width: number, height: number): void {
    if (!this.videoSource) return

    const frame = new VideoFrame(rgbaBuffer, width, height, VideoBufferType.RGBA)
    this.videoSource.captureFrame(frame)
  }

  /**
   * Force the encoder to produce high-quality keyframes by pushing frames with
   * subtle per-pixel noise. Creates enough inter-frame difference to trigger
   * quality allocation without visible artifacts (no black flash).
   */
  forceEncoderQuality(rgbaBuffer: Buffer, width: number, height: number): void {
    // Push alternating frames with slightly modified pixels to force encoder activity
    const noisy = Buffer.from(rgbaBuffer)
    for (let i = 0; i < 30; i++) {
      if (i % 2 === 0) {
        // Flip a few hundred pixels' blue channel by ±1 (imperceptible)
        for (let p = 2; p < noisy.length && p < 4000; p += 4) {
          noisy[p] = rgbaBuffer[p] > 0 ? rgbaBuffer[p] - 1 : 1
        }
        this.pushFrame(noisy, width, height)
      } else {
        this.pushFrame(rgbaBuffer, width, height)
      }
    }
  }

  startHeartbeat(rgbaBuffer: Buffer, width: number, height: number): void {
    this.stopHeartbeat()
    // 30 FPS heartbeat — consistent frame rate keeps encoder quality stable.
    this.heartbeatInterval = setInterval(() => {
      this.pushFrame(rgbaBuffer, width, height)
    }, 33)
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
  }

  // TODO: Implement audio track for videos
  async startAudio(): Promise<void> {
    /* noop */
  }

  // TODO: Implement audio track for videos
  async pushAudioFrame(): Promise<void> {
    /* noop */
  }

  // TODO: Implement audio track for videos
  async stopAudio(): Promise<void> {
    /* noop */
  }

  setDataHandler(handler: (data: Record<string, unknown>) => void): void {
    this.dataHandler = handler
  }

  async updateMetadataState(state: Record<string, unknown>): Promise<void> {
    if (!this.room?.localParticipant) return
    await this.room.localParticipant.updateMetadata(
      JSON.stringify({ role: 'presentation', presentationId: this.presentationId, ...state })
    )
  }

  async publishData(message: Record<string, unknown>): Promise<void> {
    if (!this.room) return
    const data = new TextEncoder().encode(JSON.stringify(message))
    const localParticipant = this.room.localParticipant
    if (!localParticipant) return
    await localParticipant.publishData(data, {
      topic: 'presentation',
      reliable: true
    })
  }

  getRemoteParticipantCount(): number {
    if (!this.room) return 0
    return this.room.remoteParticipants.size
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat()
    if (this.room) {
      await this.room.disconnect()
      this.room = null
    }
    this.videoSource = null
    this.videoTrack = null
  }
}
