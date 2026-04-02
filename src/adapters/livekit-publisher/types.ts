import type { ILoggerComponent } from '@well-known-components/interfaces'

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

export interface ILiveKitPublisherComponent {
  createPublisher(
    presentationId: string,
    logger: ILoggerComponent.ILogger,
    allowedRoles?: Set<string>
  ): ILiveKitPublisher
}
