import { Readable } from 'stream'
import type { IConfigComponent, IFetchComponent } from '@well-known-components/interfaces'
import { FileNotFoundError, UnknownFileRetrievalError } from './errors'
import type { DriveStreamResult, IGoogleDriveComponent } from './types'

/** Allow only Drive file ID characters: alphanumeric, hyphen, underscore */
const FILE_ID_REGEX = /^[a-zA-Z0-9_-]+$/

const VIDEO_MIME_PREFIX = 'video/'

export function getPublicDriveDownloadUrl(fileId: string): string {
  return `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&authuser=0`
}

function isNodeReadable(value: unknown): value is Readable {
  return typeof value === 'object' && value !== null && typeof (value as Readable).pipe === 'function'
}

function toNodeStream(webStream: ReadableStream): Readable {
  if (typeof (Readable as { fromWeb?: (s: ReadableStream) => Readable }).fromWeb === 'function') {
    return (Readable as { fromWeb: (s: ReadableStream) => Readable }).fromWeb(webStream)
  }
  // Fallback: buffer everything (shouldn't happen on Node 18+)
  return new Readable({
    async read() {
      const reader = webStream.getReader()
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          this.push(value)
        }
        this.push(null)
      } catch (err) {
        this.destroy(err instanceof Error ? err : new Error(String(err)))
      }
    }
  })
}

export async function createGoogleDriveComponent(components: {
  config: IConfigComponent
  fetcher: IFetchComponent
}): Promise<IGoogleDriveComponent> {
  const { config, fetcher } = components

  // Resolve config at component creation
  const allowedIdsRaw = await config.getString('DRIVE_VIDEO_ALLOWED_FILE_IDS')
  let allowedFileIds: Set<string> | null = null
  if (allowedIdsRaw && allowedIdsRaw.trim() !== '') {
    const ids = allowedIdsRaw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    allowedFileIds = ids.length > 0 ? new Set(ids) : null
  }

  return {
    async streamFile(fileId: string, range?: { start: number; end?: number }): Promise<DriveStreamResult> {
      const url = getPublicDriveDownloadUrl(fileId)
      const headers: Record<string, string> = {}
      if (range !== undefined) {
        headers.Range = range.end !== undefined ? `bytes=${range.start}-${range.end}` : `bytes=${range.start}-`
      }

      const res = await fetcher.fetch(url, { headers })
      if (!res.ok) {
        if (res.status === 404 || res.status === 403) {
          throw new FileNotFoundError(fileId)
        }
        throw new UnknownFileRetrievalError(fileId, res.status)
      }

      const body = res.body
      if (!body) throw new UnknownFileRetrievalError(fileId, 0)

      const stream = isNodeReadable(body) ? body : toNodeStream(body as unknown as ReadableStream)
      const contentLength = res.headers.get('content-length')
      const contentRange = res.headers.get('content-range')
      const contentType = res.headers.get('content-type') ?? 'application/octet-stream'

      return {
        stream,
        contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
        contentRange: contentRange ?? undefined,
        contentType
      }
    },

    isFileAllowed(fileId: string): boolean {
      if (allowedFileIds === null) return false
      return allowedFileIds.has(fileId)
    },

    isValidFileId(fileId: string): boolean {
      return FILE_ID_REGEX.test(fileId)
    },

    isVideoMime(mimeType: string): boolean {
      return mimeType.toLowerCase().startsWith(VIDEO_MIME_PREFIX)
    }
  }
}
