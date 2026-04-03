import type { IBaseComponent, ILoggerComponent } from '@well-known-components/interfaces'

/**
 * A LiveKit publisher instance bound to a single presentation session.
 *
 * Manages the room connection, video track publishing, data channel
 * handling, and metadata updates for one presentation.
 */
export interface ILiveKitPublisher {
  connect(url: string, token: string): Promise<void>
  startPublishing(width: number, height: number): Promise<void>
  pushFrame(rgbaBuffer: Buffer, width: number, height: number): void
  forceEncoderQuality(rgbaBuffer: Buffer, width: number, height: number): void
  startHeartbeat(rgbaBuffer: Buffer, width: number, height: number): void
  stopHeartbeat(): void
  setDataHandler(handler: (data: Record<string, unknown>) => void): void
  updateMetadataState(state: Record<string, unknown>): Promise<void>
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
