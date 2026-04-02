import * as path from 'path'
import type { IHttpServerComponent } from '@well-known-components/interfaces'
import { DownloadError, FileTooLargeError, InvalidUrlError, MissingFileError } from '../../adapters/file-provider'
import { MaxConcurrentPresentationsError } from '../../adapters/presentation-manager'
import type { HandlerContextWithPath } from '../../types'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB

// PDF starts with %PDF, PPTX is a ZIP starting with PK\x03\x04
const PDF_MAGIC = Buffer.from('%PDF')
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

export function validateMagicBytes(buffer: Buffer, fileType: 'pdf' | 'pptx'): boolean {
  if (buffer.length < 4) return false
  if (fileType === 'pdf') return buffer.subarray(0, 4).equals(PDF_MAGIC)
  if (fileType === 'pptx') return buffer.subarray(0, 4).equals(ZIP_MAGIC)
  return false
}

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename)
  return base.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getFileTypeFromName(filename: string): 'pdf' | 'pptx' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.pptx')) return 'pptx'
  return null
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

    if (contentType.includes('application/json')) {
      const body = (await request.json()) as Record<string, unknown>
      const url = body.url as string | undefined
      const token = body.livekitToken as string | undefined
      const lkUrl = body.livekitUrl as string | undefined

      if (!url) {
        return { status: 400, body: { error: 'Missing url' } }
      }
      if (!token || !lkUrl) {
        return { status: 400, body: { error: 'Missing livekitToken or livekitUrl' } }
      }

      livekitToken = token
      livekitUrl = lkUrl

      const downloaded = await fileProvider.fromUrl(url)
      fileBuffer = downloaded.buffer
      fileName = downloaded.filename
    } else if (contentType.includes('multipart/form-data')) {
      const contentLength = request.headers.get('content-length')
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        return {
          status: 413,
          body: { error: `Request exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)}MB` }
        }
      }

      const rawBody = Buffer.from(await request.arrayBuffer())
      const result = await fileProvider.fromMultipart(contentType, rawBody)

      const token = result.fields.livekitToken || null
      const lkUrl = result.fields.livekitUrl || null
      if (!token || !lkUrl) {
        return { status: 400, body: { error: 'Missing livekitToken or livekitUrl' } }
      }

      livekitToken = token
      livekitUrl = lkUrl
      fileBuffer = result.buffer
      fileName = result.filename
    } else {
      return {
        status: 400,
        body: { error: 'Content-Type must be multipart/form-data or application/json' }
      }
    }

    // Common validation for both paths
    const rawFileName = sanitizeFilename(fileName)
    const fileType = getFileTypeFromName(rawFileName)
    if (!fileType) {
      return { status: 400, body: { error: 'Unsupported file type. Only .pdf and .pptx files are supported.' } }
    }

    if (!validateMagicBytes(fileBuffer, fileType)) {
      return { status: 400, body: { error: `File content does not match expected ${fileType.toUpperCase()} format` } }
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
      rawFileName
    )

    return { status: 201, body: info }
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      return { status: 413, body: { error: error.message } }
    }
    if (error instanceof InvalidUrlError || error instanceof MissingFileError) {
      return { status: 400, body: { error: error.message } }
    }
    if (error instanceof DownloadError) {
      return { status: 400, body: { error: `Failed to download file: ${error.message}` } }
    }
    if (error instanceof MaxConcurrentPresentationsError) {
      return { status: 429, body: { error: error.message } }
    }
    logger.error(`Failed to create presentation: ${error instanceof Error ? error.message : String(error)}`)
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : 'Internal error' }
    }
  }
}
