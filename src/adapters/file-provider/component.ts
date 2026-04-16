import { Readable } from 'stream'
import Busboy = require('busboy')
import { DownloadError, FileTooLargeError, InvalidUrlError, MissingFileError } from './errors'
import { resolveFileUrl } from './file-url-providers'
import { pinnedHttpsRequest } from '../../logic/network-validator'
import type { FileProviderResult, IFileProviderComponent } from './types'
import type { AppComponents } from '../../types'

const MAX_FILE_SIZE = 100 * 1024 * 1024 // 100 MB
const MAX_FILE_SIZE_MB = MAX_FILE_SIZE / (1024 * 1024)
const DOWNLOAD_TIMEOUT_MS = 60_000 // 60 seconds
const MAX_REDIRECTS = 5

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
  let currentUrl = url
  // eslint-disable-next-line prefer-const -- assigned synchronously inside the Promise constructor
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const activeConnection: { destroy: (() => void) | null } = { destroy: null }

  const timeoutSignal = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      // Abort the in-flight HTTPS connection so it stops accumulating data
      if (activeConnection.destroy) activeConnection.destroy()
      reject(new DownloadError(`Download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s`))
    }, DOWNLOAD_TIMEOUT_MS)
  })

  async function doDownload(): Promise<{ buffer: Buffer; filename: string }> {
    // Manual redirect loop — each hop is validated for SSRF
    for (let redirects = 0; redirects < MAX_REDIRECTS; redirects++) {
      let resolved
      try {
        resolved = await networkValidator.resolveAndValidateUrl(currentUrl)
      } catch (err) {
        throw new InvalidUrlError(err instanceof Error ? err.message : String(err))
      }

      const { response, destroy } = await pinnedHttpsRequest(resolved.url, resolved.hostname, resolved.addresses)
      activeConnection.destroy = destroy

      const status = response.statusCode ?? 0

      // Handle redirects manually — validate each target
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume() // drain the redirect body
        destroy()
        const location = response.headers.location
        currentUrl = new URL(location, currentUrl).href
        continue
      }

      if (status < 200 || status >= 300 || !response.readable) {
        response.resume()
        destroy()
        throw new DownloadError(`HTTP ${status} downloading ${currentUrl}`)
      }

      // Read the response body with size limit
      const chunks: Buffer[] = []
      let bytesRead = 0

      const buffer = await new Promise<Buffer>((resolve, reject) => {
        response.on('data', (chunk: Buffer) => {
          bytesRead += chunk.length
          if (bytesRead > MAX_FILE_SIZE) {
            response.destroy()
            destroy()
            reject(new FileTooLargeError(MAX_FILE_SIZE_MB))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => resolve(Buffer.concat(chunks)))
        response.on('error', reject)
      })

      // Prefer filename from Content-Disposition header (Google Drive, S3, etc.)
      const disposition = response.headers['content-disposition'] || ''
      const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)"?/)
      const parsed = new URL(currentUrl)
      let filename: string
      try {
        filename = filenameMatch
          ? decodeURIComponent(filenameMatch[1])
          : parsed.pathname.split('/').pop() || 'presentation'
      } catch {
        filename = filenameMatch ? filenameMatch[1] : 'presentation'
      }

      return { buffer, filename }
    }

    throw new DownloadError(`Too many redirects (>${MAX_REDIRECTS})`)
  }

  try {
    const download = doDownload()
    // Suppress unhandled rejection if timeout wins the race and doDownload rejects later
    download.catch(() => {
      /* suppressed — timeout won the race */
    })
    return await Promise.race([download, timeoutSignal])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
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
      const resolved = resolveFileUrl(url)
      if (resolved.url !== url) {
        logger.info('Resolved URL to direct download', { original: url, resolved: resolved.url })
      }
      logger.info('Downloading file from URL', { url: resolved.url })
      const { buffer, filename: downloadedFilename } = await downloadFromUrl(resolved.url, networkValidator)
      const filename = resolved.filename ?? downloadedFilename
      logger.info('Downloaded file from URL', { url, size: buffer.length, filename })
      return {
        buffer,
        filename,
        fields: {}
      }
    }
  }
}
