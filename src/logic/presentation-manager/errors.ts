export class PresentationNotFoundError extends Error {
  constructor(id: string) {
    super(`Presentation ${id} not found`)
    this.name = 'PresentationNotFoundError'
  }
}

export class MaxConcurrentPresentationsError extends Error {
  constructor(max: number) {
    super(`Maximum concurrent presentations reached (${max})`)
    this.name = 'MaxConcurrentPresentationsError'
  }
}

export class InvalidLivekitCredentialsError extends Error {
  constructor(message = 'Invalid LiveKit credentials') {
    super(message)
    this.name = 'InvalidLivekitCredentialsError'
  }
}

export class RoomAlreadyPresentingError extends Error {
  constructor() {
    super('Room already has an active presentation')
    this.name = 'RoomAlreadyPresentingError'
  }
}
