import * as dns from 'dns/promises'
import * as path from 'path'
import { Readable } from 'stream'
import Busboy = require('busboy')
import type { IHttpServerComponent } from '@well-known-components/interfaces'
import { isPrivateIP } from '../../adapters/video-compositor'
import type { HandlerContextWithPath } from '../../types'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB
const DOWNLOAD_TIMEOUT_MS = 60_000 // 60 seconds

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
  const base = path.basename(filename)
  return base.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function getFileTypeFromName(filename: string): 'pdf' | 'pptx' | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.pdf')) return 'pdf'
  if (lower.endsWith('.pptx')) return 'pptx'
  return null
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
      stream.on('limit', () => {
        fileLimitHit = true
      })
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

/**
 * Download a file from a public HTTPS URL with size limit and timeout.
 * Blocks private IPs to prevent SSRF.
 */
async function downloadFromUrl(url: string): Promise<{ buffer: Buffer; filename: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('URL must use HTTPS')
  }

  // Block private IPs
  try {
    const addresses = await dns.resolve4(parsed.hostname)
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`URL resolves to private IP: ${parsed.hostname}`)
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) throw err
    // DNS failure — let fetch fail naturally
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow', signal: controller.signal })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`)
    }
    throw err
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeout)
    throw new Error(`HTTP ${response.status} downloading ${url}`)
  }

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytesRead = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > MAX_FILE_SIZE) {
        throw new Error(`Download exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)}MB`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    clearTimeout(timeout)
  }

  // Extract filename from URL path
  const urlPath = parsed.pathname
  const filename = urlPath.split('/').pop() || 'presentation'

  return { buffer: Buffer.concat(chunks), filename }
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

    let fileBuffer: Buffer
    let fileName: string
    let livekitToken: string
    let livekitUrl: string

    if (contentType.includes('application/json')) {
      // URL-based creation
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

      try {
        const downloaded = await downloadFromUrl(url)
        fileBuffer = downloaded.buffer
        fileName = downloaded.filename
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('maximum size')) {
          return { status: 413, body: { error: message } }
        }
        return { status: 400, body: { error: `Failed to download file: ${message}` } }
      }
    } else if (contentType.includes('multipart/form-data')) {
      // File upload (existing)
      const contentLength = request.headers.get('content-length')
      if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
        return {
          status: 413,
          body: { error: `Request exceeds maximum size of ${MAX_FILE_SIZE / (1024 * 1024)}MB` }
        }
      }

      let file: ParsedFormData['file']
      let fields: ParsedFormData['fields']
      try {
        const rawBody = Buffer.from(await request.arrayBuffer())
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

      const token = fields.livekitToken || null
      const lkUrl = fields.livekitUrl || null
      if (!token || !lkUrl) {
        return { status: 400, body: { error: 'Missing livekitToken or livekitUrl' } }
      }

      livekitToken = token
      livekitUrl = lkUrl
      fileBuffer = file.buffer
      fileName = file.filename
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
