import type { IBaseComponent } from '@well-known-components/interfaces'

/** Result of acquiring a file from multipart upload or URL download. */
export interface FileProviderResult {
  buffer: Buffer
  filename: string
  fields: Record<string, string>
}

/**
 * File acquisition adapter for multipart uploads and URL downloads.
 *
 * Abstracts the two ways a presentation file can be provided:
 * multipart form upload or download from a public HTTPS URL.
 */
export interface IFileProviderComponent extends IBaseComponent {
  /**
   * Parses a multipart/form-data request body and extracts the file.
   *
   * @param contentType - The Content-Type header value
   * @param body - Raw request body buffer
   * @returns Parsed file buffer, filename, and form fields
   * @throws {MissingFileError} If no file is present in the upload
   * @throws {FileTooLargeError} If the file exceeds the size limit
   */
  fromMultipart(contentType: string, body: Buffer): Promise<FileProviderResult>

  /**
   * Downloads a file from a public HTTPS URL with SSRF protection.
   *
   * @param url - Public HTTPS URL to download from
   * @returns Downloaded file buffer and extracted filename
   * @throws {InvalidUrlError} If the URL is malformed, non-HTTPS, or resolves to a private IP
   * @throws {DownloadError} If the download fails or times out
   * @throws {FileTooLargeError} If the download exceeds the size limit
   */
  fromUrl(url: string): Promise<FileProviderResult>
}
