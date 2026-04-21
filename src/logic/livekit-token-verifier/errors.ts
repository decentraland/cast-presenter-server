export class InvalidTokenError extends Error {
  constructor(message = 'Invalid LiveKit token') {
    super(message)
    this.name = 'InvalidTokenError'
  }
}
