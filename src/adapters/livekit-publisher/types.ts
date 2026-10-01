import type { IBaseComponent, ILoggerComponent } from '@well-known-components/interfaces'
import type { RemoteParticipant, RemoteVideoTrack } from '@livekit/rtc-node'

/** Lifecycle event for the presenter's camera track. */
export type PresenterCameraEvent =
  | { kind: 'active'; track: RemoteVideoTrack; participant: RemoteParticipant }
  | { kind: 'inactive' }

export type PresenterCameraTrackHandler = (event: PresenterCameraEvent) => void

/**
 * A LiveKit publisher instance bound to a single presentation session.
 *
 * Manages the room connection, video track publishing, data channel
 * handling, and metadata updates for one presentation.
 */
export interface ILiveKitPublisher {
  connect(url: string, token: string): Promise<void>
  startPublishing(width: number, height: number): Promise<void>
  pushFrame(buffer: Buffer, width: number, height: number, bufferType?: number, timestampUs?: bigint): void
  startHeartbeat(buffer: Buffer, width: number, height: number, bufferType?: number): void
  stopHeartbeat(): void
  startAudioPublishing(sampleRate: number, channels: number): Promise<void>
  pushAudioFrame(pcmData: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number): void
  stopAudioPublishing(): Promise<void>
  setDataHandler(handler: (data: Record<string, unknown>) => void): void
  /**
   * Registers a handler that fires whenever the presenter's camera track becomes
   * active (subscribed + unmuted) or inactive (muted, unsubscribed, or presenter
   * left the room). The handler is invoked with the latest event; missed events
   * are not replayed if a previous handler unregistered.
   */
  setPresenterCameraTrackHandler(handler: PresenterCameraTrackHandler | null): void
  updateMetadataState(state: object): Promise<void>
  publishData(message: Record<string, unknown>): Promise<void>
  getRemoteParticipantCount(): number
  disconnect(): Promise<void>
}

/**
 * Factory component for creating per-session LiveKit publishers.
 */
export interface ILiveKitPublisherComponent extends IBaseComponent {
  /**
   * Creates a new publisher instance for a presentation session.
   *
   * @param presentationId - Unique ID for the presentation
   * @param logger - Scoped logger for this publisher
   * @returns A new ILiveKitPublisher instance
   */
  createPublisher(presentationId: string, logger: ILoggerComponent.ILogger): ILiveKitPublisher
}
