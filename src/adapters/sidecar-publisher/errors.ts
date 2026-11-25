/** Thrown by `connect` when the sidecar reports that joining the LiveKit room failed. */
export class LivekitConnectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LivekitConnectError'
  }
}
