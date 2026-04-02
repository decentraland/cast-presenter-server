import type { Readable } from 'stream'

export interface DriveStreamResult {
  stream: Readable
  contentLength: number | undefined
  contentRange: string | undefined
  contentType: string
}

export interface IGoogleDriveComponent {
  streamFile(fileId: string, range?: { start: number; end?: number }): Promise<DriveStreamResult>
  isFileAllowed(fileId: string): boolean
  isValidFileId(fileId: string): boolean
  isVideoMime(mimeType: string): boolean
}
