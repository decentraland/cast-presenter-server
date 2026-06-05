import type { IHttpServerComponent } from '@dcl/core-commons'
import { DownloadError, FileTooLargeError, InvalidUrlError, MissingFileError } from '../../adapters/file-provider'
import { getFileTypeFromName, sanitizeFilename, validateMagicBytes } from '../../logic/file-validator'
import { InvalidLivekitCredentialsError, MaxConcurrentPresentationsError } from '../../logic/presentation-manager'
import { RequestTooLargeError, ValidationError } from '../errors'
import type { OverlayConfig, OverlayCorner, OverlaySize } from '../../logic/presentation-manager/types'
import type { HandlerContextWithPath } from '../../types'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB
const MAX_JSON_BODY_SIZE = 1 * 1024 * 1024 // 1 MB — JSON body only contains URLs and tokens

function validateLivekitUrl(lkUrl: string): void {
  try {
    const parsed = new URL(lkUrl)
    if (parsed.protocol !== 'wss:') {
      throw new ValidationError('livekitUrl must use wss:// protocol')
    }
    if (!parsed.hostname) {
      throw new ValidationError('livekitUrl must specify a host')
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err
    throw new ValidationError('livekitUrl is not a valid URL')
  }
}

const VALID_CORNERS: ReadonlySet<string> = new Set(['TL', 'TR', 'BL', 'BR'])
const VALID_SIZES: ReadonlySet<string> = new Set(['small', 'medium', 'large'])

function parseOverlayConfigFromBody(body: Record<string, unknown>): OverlayConfig | undefined {
  const corner = typeof body.overlayCorner === 'string' ? body.overlayCorner : undefined
  const size = typeof body.overlaySize === 'string' ? body.overlaySize : undefined
  if (!corner && !size) return undefined
  if (!corner || !size) {
    throw new ValidationError('overlayCorner and overlaySize must both be set, or both omitted')
  }
  if (!VALID_CORNERS.has(corner)) {
    throw new ValidationError(`overlayCorner must be one of TL, TR, BL, BR (got ${corner})`)
  }
  if (!VALID_SIZES.has(size)) {
    throw new ValidationError(`overlaySize must be one of small, medium, large (got ${size})`)
  }
  return { corner: corner as OverlayCorner, size: size as OverlaySize }
}

function parseOverlayConfigFromFields(fields: Record<string, string>): OverlayConfig | undefined {
  return parseOverlayConfigFromBody(fields as unknown as Record<string, unknown>)
}

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

    let fileBuffer: Buffer
    let fileName: string
    let livekitToken: string
    let livekitUrl: string
    let overlayConfig: OverlayConfig | undefined

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
      const lkUrl = typeof body.livekitUrl === 'string' ? body.livekitUrl : undefined
      overlayConfig = parseOverlayConfigFromBody(body)

      if (!url) {
        throw new ValidationError('Missing url')
      }
      if (!token || !lkUrl) {
        throw new ValidationError('Missing livekitToken or livekitUrl')
      }
      validateLivekitUrl(lkUrl)

      livekitToken = token
      livekitUrl = lkUrl

      // Pre-validate LiveKit credentials BEFORE the expensive URL download
      // so bogus tokens can't amplify a 1 KB request into a 100 MB outbound fetch.
      await presentationManager.validateCredentials(livekitUrl, livekitToken)

      const downloaded = await fileProvider.fromUrl(url)
      fileBuffer = downloaded.buffer
      fileName = downloaded.filename
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

      const token = result.fields.livekitToken || null
      const lkUrl = result.fields.livekitUrl || null
      overlayConfig = parseOverlayConfigFromFields(result.fields)
      if (!token || !lkUrl) {
        throw new ValidationError('Missing livekitToken or livekitUrl')
      }
      validateLivekitUrl(lkUrl)

      livekitToken = token
      livekitUrl = lkUrl
      fileBuffer = result.buffer
      fileName = result.filename
    } else {
      throw new ValidationError('Content-Type must be multipart/form-data or application/json')
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

    const info = await presentationManager.createPresentation(
      fileBuffer,
      fileType,
      livekitToken,
      livekitUrl,
      rawFileName,
      overlayConfig
    )

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
    if (error instanceof InvalidLivekitCredentialsError) {
      return { status: 401, body: { error: 'Invalid LiveKit credentials' } }
    }
    logger.error(`Failed to create presentation: ${error instanceof Error ? error.message : String(error)}`)
    return { status: 500, body: { error: 'Internal error' } }
  }
}
