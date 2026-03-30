import { Readable } from 'stream'
import * as path from 'path'
import Busboy = require('busboy')
import type { IHttpServerComponent } from '@well-known-components/interfaces'
import type { HandlerContextWithPath } from '../../types'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB

// PDF starts with %PDF, PPTX is a ZIP starting with PK\x03\x04
const PDF_MAGIC = Buffer.from('%PDF')
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]) // PK\x03\x04

export function validateMagicBytes(buffer: Buffer, fileType: 'pdf' | 'pptx'): boolean {
  if (buffer.length < 4) return false
  if (fileType === 'pdf') return buffer.subarray(0, 4).equals(PDF_MAGIC)
  if (fileType === 'pptx') return buffer.subarray(0, 4).equals(ZIP_MAGIC)
  return false
}

export function sanitizeFilename(filename: string): string {
  // Extract basename to prevent path traversal, strip non-safe characters
  const base = path.basename(filename)
  return base.replace(/[^a-zA-Z0-9._-]/g, '_')
}

interface ParsedFormData {
  file: { buffer: Buffer; filename: string } | null
  fields: Record<string, string>
}

function parseMultipart(contentType: string, body: Buffer): Promise<ParsedFormData> {
  return new Promise((resolve, reject) => {
    const result: ParsedFormData = { file: null, fields: {} }
    const busboy = Busboy({
      headers: { 'content-type': contentType },
      limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 10 }
    })

    let fileLimitHit = false

    busboy.on('file', (_fieldname: string, stream: Readable, info: { filename: string }) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('limit', () => { fileLimitHit = true })
      stream.on('end', () => {
        result.file = { buffer: Buffer.concat(chunks), filename: info.filename }
      })
    })

    busboy.on('field', (name: string, value: string) => {
      result.fields[name] = value
    })

    busboy.on('finish', () => {
      if (fileLimitHit) {
        reject(new Error(`File exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)}MB`))
      } else {
        resolve(result)
      }
    })
    busboy.on('error', reject)

    const readable = new Readable()
    readable.push(body)
    readable.push(null)
    readable.pipe(busboy)
  })
}

export async function createPresentationHandler(
  context: HandlerContextWithPath<'logs' | 'presentationManager', '/presentations'>
): Promise<IHttpServerComponent.IResponse> {
  const {
    components: { logs, presentationManager },
    request
  } = context

  const logger = logs.getLogger('create-presentation-handler')

  try {
    const contentType = request.headers.get('content-type') || ''

    if (!contentType.includes('multipart/form-data')) {
      return { status: 400, body: { error: 'Content-Type must be multipart/form-data' } }
    }

    // Reject oversized requests before reading the body into memory
    const contentLength = request.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
      return { status: 413, body: { error: `Request exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)}MB` } }
    }

    let rawBody: Buffer
    let file: ParsedFormData['file']
    let fields: ParsedFormData['fields']
    try {
      rawBody = Buffer.from(await request.arrayBuffer())
      const parsed = await parseMultipart(contentType, rawBody)
      file = parsed.file
      fields = parsed.fields
    } catch (err) {
      if (err instanceof Error && err.message.includes('maximum size')) {
        return { status: 413, body: { error: err.message } }
      }
      throw err
    }

    if (!file) {
      return { status: 400, body: { error: 'Missing file' } }
    }

    const livekitToken = fields.livekitToken || null
    const livekitUrl = fields.livekitUrl || null

    if (!livekitToken || !livekitUrl) {
      return { status: 400, body: { error: 'Missing livekitToken or livekitUrl' } }
    }

    // Determine file type from extension
    const rawFileName = sanitizeFilename(file.filename)
    const fileNameLower = rawFileName.toLowerCase()
    let fileType: 'pdf' | 'pptx'
    if (fileNameLower.endsWith('.pdf')) {
      fileType = 'pdf'
    } else if (fileNameLower.endsWith('.pptx')) {
      fileType = 'pptx'
    } else {
      return { status: 400, body: { error: 'Unsupported file type. Only .pdf and .pptx files are supported.' } }
    }

    // Validate file magic bytes to prevent disguised files
    if (!validateMagicBytes(file.buffer, fileType)) {
      return { status: 400, body: { error: `File content does not match expected ${fileType.toUpperCase()} format` } }
    }

    logger.info(`Creating presentation from ${fileType} file`, {
      fileName: rawFileName,
      fileSize: file.buffer.length
    })

    const info = await presentationManager.createPresentation(file.buffer, fileType, livekitToken, livekitUrl, rawFileName)

    return {
      status: 201,
      body: info
    }
  } catch (error) {
    logger.error(`Failed to create presentation: ${error instanceof Error ? error.message : String(error)}`)
    return {
      status: 500,
      body: { error: error instanceof Error ? error.message : 'Internal error' }
    }
  }
}
