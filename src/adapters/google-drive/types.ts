import type { IBaseComponent } from '@well-known-components/interfaces'
import type { Readable } from 'stream'

/** Result of streaming a file from Google Drive. */
export interface DriveStreamResult {
  stream: Readable
  contentLength: number | undefined
  contentRange: string | undefined
  contentType: string
}

/**
 * Google Drive adapter for streaming public files.
 *
 * Handles allowlist-based access control and file ID validation
 * for the Drive video proxy endpoint.
 */
export interface IGoogleDriveComponent extends IBaseComponent {
  /**
   * Streams a public Drive file, optionally with a byte range.
   *
   * @param fileId - Google Drive file ID
   * @param range - Optional byte range for seek support
   * @returns Stream result with content metadata
   * @throws {FileNotFoundError} If the file is not found or not accessible
   * @throws {UnknownFileRetrievalError} If Drive returns an unexpected status
   */
  streamFile(fileId: string, range?: { start: number; end?: number }): Promise<DriveStreamResult>

  /**
   * Checks if a file ID is in the configured allowlist.
   *
   * @param fileId - Google Drive file ID to check
   * @returns true if the file is allowed
   */
  isFileAllowed(fileId: string): boolean

  /**
   * Validates that a file ID contains only safe characters.
   *
   * @param fileId - File ID string to validate
   * @returns true if the ID format is valid
   */
  isValidFileId(fileId: string): boolean
}
