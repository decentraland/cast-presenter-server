export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

export class RequestTooLargeError extends Error {
  constructor(maxMb: number) {
    super(`Request exceeds maximum size of ${maxMb}MB`)
    this.name = 'RequestTooLargeError'
  }
}

export class FileNotAllowedError extends Error {
  constructor() {
    super('Not allowed to access this file')
    this.name = 'FileNotAllowedError'
  }
}
