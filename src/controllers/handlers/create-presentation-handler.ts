import type { IHttpServerComponent } from '@well-known-components/interfaces'
import { DownloadError, FileTooLargeError, InvalidUrlError, MissingFileError } from '../../adapters/file-provider'
import { getFileTypeFromName, sanitizeFilename, validateMagicBytes } from '../../logic/file-validator'
import { InvalidTokenError } from '../../logic/livekit-token-verifier'
import {
  InvalidLivekitCredentialsError,
  MaxConcurrentPresentationsError,
  RoomAlreadyPresentingError
} from '../../logic/presentation-manager'
import { RequestTooLargeError, ValidationError } from '../errors'
import type { HandlerContextWithPath } from '../../types'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB
const MAX_JSON_BODY_SIZE = 1 * 1024 * 1024 // 1 MB — JSON body only contains URLs and tokens

export async function createPresentationHandler(
  context: HandlerContextWithPath<'logs' | 'presentationManager' | 'fileProvider', '/presentations'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { logs, presentationManager, fileProvider },
    request
  } = context

  const logger = logs.getLogger('create-presentation-handler')

  try {
    const contentType = request.headers.get('content-type') || ''

    type ParsedSource =
      | { kind: 'url'; livekitToken: string; url: string }
      | { kind: 'multipart'; livekitToken: string; buffer: Buffer; filename: string }

    let source: ParsedSource

    if (contentType.includes('application/json')) {
      // Buffer the full body and check actual size — Content-Length is client-supplied
      // and may be absent (chunked encoding) or lie about the real size
      const rawBody = Buffer.from(await request.arrayBuffer())
      if (rawBody.length > MAX_JSON_BODY_SIZE) {
        throw new RequestTooLargeError(MAX_JSON_BODY_SIZE / (1024 * 1024))
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody.toString('utf-8'))
      } catch {
        throw new ValidationError('Request body must be valid JSON')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ValidationError('Request body must be a JSON object')
      }
      const body = parsed as Record<string, unknown>
      const url = typeof body.url === 'string' ? body.url : undefined
      const token = typeof body.livekitToken === 'string' ? body.livekitToken : undefined

      if (!url) {
        throw new ValidationError('Missing url')
      }
      if (!token) {
        throw new ValidationError('Missing livekitToken')
      }

      source = { kind: 'url', livekitToken: token, url }
    } else if (contentType.includes('multipart/form-data')) {
      const contentLength = request.headers.get('content-length')
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        throw new RequestTooLargeError(MAX_FILE_SIZE / (1024 * 1024))
      }

      // Note: request.arrayBuffer() buffers the full body into memory.
      // Content-Length is client-supplied and may be absent (chunked encoding).
      // The reverse proxy MUST enforce a request body size limit (see .env.default).
      const rawBody = Buffer.from(await request.arrayBuffer())
      if (rawBody.length > MAX_FILE_SIZE) {
        throw new RequestTooLargeError(MAX_FILE_SIZE / (1024 * 1024))
      }
      const result = await fileProvider.fromMultipart(contentType, rawBody)

      const token = result.fields.livekitToken
      if (!token) {
        throw new ValidationError('Missing livekitToken')
      }

      source = { kind: 'multipart', livekitToken: token, buffer: result.buffer, filename: result.filename }
    } else {
      throw new ValidationError('Content-Type must be multipart/form-data or application/json')
    }

    // Pre-validate LiveKit credentials once for both paths — rejects bogus tokens
    // before the expensive URL download (JSON path), and gives multipart uploads
    // the same defense-in-depth check the JSON path has always had.
    await presentationManager.validateCredentials(source.livekitToken)

    let fileBuffer: Buffer
    let fileName: string
    if (source.kind === 'url') {
      const downloaded = await fileProvider.fromUrl(source.url)
      fileBuffer = downloaded.buffer
      fileName = downloaded.filename
    } else {
      fileBuffer = source.buffer
      fileName = source.filename
    }

    // Common validation for both paths
    const rawFileName = sanitizeFilename(fileName)
    const fileType = getFileTypeFromName(rawFileName)
    if (!fileType) {
      throw new ValidationError('Unsupported file type. Only .pdf and .pptx files are supported.')
    }

    if (!validateMagicBytes(fileBuffer, fileType)) {
      throw new ValidationError(`File content does not match expected ${fileType.toUpperCase()} format`)
    }

    logger.info(`Creating presentation from ${fileType} file`, {
      fileName: rawFileName,
      fileSize: fileBuffer.length
    })

    const info = await presentationManager.createPresentation(fileBuffer, fileType, source.livekitToken, rawFileName)

    return { status: 201, body: info }
  } catch (error) {
    if (error instanceof ValidationError || error instanceof InvalidUrlError || error instanceof MissingFileError) {
      return { status: 400, body: { error: error.message } }
    }
    if (error instanceof DownloadError) {
      return { status: 400, body: { error: `Failed to download file: ${error.message}` } }
    }
    if (error instanceof RequestTooLargeError || error instanceof FileTooLargeError) {
      return { status: 413, body: { error: error.message } }
    }
    if (error instanceof MaxConcurrentPresentationsError) {
      return { status: 429, body: { error: error.message } }
    }
    if (error instanceof RoomAlreadyPresentingError) {
      return { status: 409, body: { error: error.message } }
    }
    if (error instanceof InvalidTokenError) {
      return { status: 401, body: { error: 'Invalid LiveKit token' } }
    }
    if (error instanceof InvalidLivekitCredentialsError) {
      return { status: 401, body: { error: 'Invalid LiveKit credentials' } }
    }
    logger.error(`Failed to create presentation: ${error instanceof Error ? error.message : String(error)}`)
    return { status: 500, body: { error: 'Internal error' } }
  }
}
