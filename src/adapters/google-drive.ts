import type { Readable } from 'stream'

/** Allow only Drive file ID characters: alphanumeric, hyphen, underscore */
export const FILE_ID_REGEX = /^[a-zA-Z0-9_-]+$/

const VIDEO_MIME_PREFIX = 'video/'

/** Public Drive download URL (no auth). Works for files shared as "Anyone with the link". */
export const PUBLIC_DRIVE_DOWNLOAD_URL = (fileId: string): string =>
  `https://drive.usercontent.google.com/download?id=${encodeURIComponent(fileId)}&export=download&authuser=0`

export interface DriveStreamResult {
  stream: Readable
  contentLength: number | undefined
  contentRange: string | undefined
  contentType: string
}

export type GetConfig = (key: string) => Promise<string | undefined>

/** Minimal response shape from fetch (compatible with node-fetch and global fetch). */
export interface FetchResponseLike {
  ok: boolean
  status: number
  headers: { get: (name: string) => string | null }
  body: Readable | ReadableStream | NodeJS.ReadableStream | null
}

export type FetchFn = (url: string, init?: { headers?: Record<string, string> }) => Promise<FetchResponseLike>

/**
 * Stream a **public** Drive file by fetching the direct download URL.
 * No Google credentials required. Use for files shared as "Anyone with the link".
 * Forwards Range for seek support; returns stream and response headers.
 */
export async function streamPublicDriveFile(
  fileId: string,
  fetchFn: FetchFn,
  range?: { start: number; end?: number }
): Promise<DriveStreamResult> {
  const url = PUBLIC_DRIVE_DOWNLOAD_URL(fileId)
  const headers: Record<string, string> = {}
  if (range !== undefined) {
    headers.Range = range.end !== undefined ? `bytes=${range.start}-${range.end}` : `bytes=${range.start}-`
  }
  const res = await fetchFn(url, { headers })
  if (!res.ok) {
    if (res.status === 404 || res.status === 403) throw new Error('File not found or not accessible')
    throw new Error(`Drive returned ${res.status}`)
  }
  const body = res.body
  if (!body) throw new Error('Empty response body')
  const stream = isNodeReadable(body) ? body : ((await toNodeStream(body as ReadableStream)) as Readable)
  const contentLength = res.headers.get('content-length')
  const contentRange = res.headers.get('content-range')
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
  return {
    stream,
    contentLength: contentLength ? parseInt(contentLength, 10) : undefined,
    contentRange: contentRange ?? undefined,
    contentType
  }
}

function isNodeReadable(value: unknown): value is Readable {
  return typeof value === 'object' && value !== null && typeof (value as Readable).pipe === 'function'
}

async function toNodeStream(webStream: ReadableStream): Promise<Readable> {
  const { Readable } = await import('stream')
  if (typeof (Readable as { fromWeb?: (s: ReadableStream) => Readable }).fromWeb === 'function') {
    return (Readable as { fromWeb: (s: ReadableStream) => Readable }).fromWeb(webStream)
  }
  const reader = webStream.getReader()
  const chunks: Uint8Array[] = []
  let done = false
  while (!done) {
    const { value, done: d } = await reader.read()
    done = d
    if (value) chunks.push(value)
  }
  const buffer = Buffer.concat(chunks)
  const r = new Readable()
  r.push(buffer)
  r.push(null)
  return r
}

/**
 * Check if the file MIME type is a supported video type.
 */
export function isVideoMime(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith(VIDEO_MIME_PREFIX)
}

/**
 * Parse allowed file IDs from config (comma-separated).
 * Empty or missing = deny all (default-deny security posture).
 */
export function getAllowedFileIds(getConfig: GetConfig): Promise<Set<string> | null> {
  return getConfig('DRIVE_VIDEO_ALLOWED_FILE_IDS').then((raw) => {
    if (!raw || raw.trim() === '') return null
    const ids = raw
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    return ids.length > 0 ? new Set(ids) : null
  })
}

/**
 * Check if fileId is allowed. If allowedList is null (no config), deny all.
 */
export function isFileAllowed(fileId: string, allowedList: Set<string> | null): boolean {
  if (allowedList === null) return false
  return allowedList.has(fileId)
}

/**
 * Validate fileId format. Returns true if valid.
 */
export function isValidFileId(fileId: string): boolean {
  return FILE_ID_REGEX.test(fileId)
}
