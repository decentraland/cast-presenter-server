import { Readable } from 'stream'
import Busboy = require('busboy')
import { DownloadError, FileTooLargeError, InvalidUrlError, MissingFileError } from './errors'
import type { FileProviderResult, IFileProviderComponent } from './types'
import type { AppComponents } from '../../types'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB
const MAX_FILE_SIZE_MB = MAX_FILE_SIZE / (1024 * 1024)
const DOWNLOAD_TIMEOUT_MS = 60_000 // 60 seconds

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
        reject(new FileTooLargeError(MAX_FILE_SIZE_MB))
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

async function downloadFromUrl(
  url: string,
  networkValidator: AppComponents['networkValidator']
): Promise<{ buffer: Buffer; filename: string }> {
  // Validate URL (HTTPS + private IP check) via centralized network validator
  try {
    await networkValidator.validateHttpsUrl(url)
  } catch (err) {
    throw new InvalidUrlError(err instanceof Error ? err.message : String(err))
  }

  const parsed = new URL(url) // safe — validateHttpsUrl already parsed it
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(url, { redirect: 'follow', signal: controller.signal })
  } catch (err) {
    clearTimeout(timeout)
    if (err instanceof Error && err.name === 'AbortError') {
      throw new DownloadError(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`)
    }
    throw err
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeout)
    throw new DownloadError(`HTTP ${response.status} downloading ${url}`)
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
        throw new FileTooLargeError(MAX_FILE_SIZE_MB)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    clearTimeout(timeout)
  }

  const urlPath = parsed.pathname
  const filename = urlPath.split('/').pop() || 'presentation'

  return { buffer: Buffer.concat(chunks), filename }
}

/**
 * Creates the file provider adapter component.
 *
 * Handles file acquisition from two sources:
 * 1. Multipart form uploads (parsed via busboy)
 * 2. HTTPS URL downloads (with SSRF protection via networkValidator)
 *
 * @param components - Required: logs, networkValidator
 * @returns IFileProviderComponent implementation
 */
export function createFileProviderComponent(
  components: Pick<AppComponents, 'logs' | 'networkValidator'>
): IFileProviderComponent {
  const { networkValidator } = components
  const logger = components.logs.getLogger('file-provider')

  return {
    async fromMultipart(contentType: string, body: Buffer): Promise<FileProviderResult> {
      const parsed = await parseMultipart(contentType, body)
      if (!parsed.file) {
        throw new MissingFileError()
      }
      logger.info('Parsed multipart upload', { filename: parsed.file.filename, size: parsed.file.buffer.length })
      return {
        buffer: parsed.file.buffer,
        filename: parsed.file.filename,
        fields: parsed.fields
      }
    },

    async fromUrl(url: string): Promise<FileProviderResult> {
      logger.info('Downloading file from URL', { url })
      const { buffer, filename } = await downloadFromUrl(url, networkValidator)
      logger.info('Downloaded file from URL', { url, size: buffer.length })
      return {
        buffer,
        filename,
        fields: {}
      }
    }
  }
}
