/**
 * A LiveKit publisher instance bound to a single presentation session.
 *
 * Manages the room connection, data channel handling, and metadata updates
 * for one presentation.
 */
export interface ILiveKitPublisher {
  connect(url: string, token: string): Promise<void>
  /** `senderIdentity` is the authorized presenter's LiveKit identity, original case. */
  setDataHandler(handler: (data: Record<string, unknown>, senderIdentity: string) => void): void
  updateMetadataState(state: object): Promise<void>
  publishData(message: Record<string, unknown>): Promise<void>
  getRemoteParticipantCount(): number
  disconnect(): Promise<void>
}
