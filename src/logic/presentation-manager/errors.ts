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
