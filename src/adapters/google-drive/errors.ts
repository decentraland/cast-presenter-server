export class FileNotFoundError extends Error {
  constructor(fileId: string) {
    super(`File not found or not accessible: ${fileId}`)
    this.name = 'FileNotFoundError'
  }
}

export class UnknownFileRetrievalError extends Error {
  constructor(fileId: string, status: number) {
    super(`Drive returned ${status} for file ${fileId}`)
    this.name = 'UnknownFileRetrievalError'
  }
}
