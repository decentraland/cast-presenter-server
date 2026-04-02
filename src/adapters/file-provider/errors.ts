export class FileTooLargeError extends Error {
  constructor(maxMb: number) {
    super(`File exceeds maximum size of ${maxMb}MB`)
    this.name = 'FileTooLargeError'
  }
}

export class MissingFileError extends Error {
  constructor() {
    super('Missing file in multipart upload')
    this.name = 'MissingFileError'
  }
}

export class DownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DownloadError'
  }
}

export class InvalidUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidUrlError'
  }
}
