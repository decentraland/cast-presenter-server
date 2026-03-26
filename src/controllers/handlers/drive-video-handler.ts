import { getAllowedFileIds, isFileAllowed, isValidFileId, streamPublicDriveFile } from '../../adapters/google-drive'
import type { HandlerContextWithPath } from '../../types'
import type { Readable } from 'stream'

const RANGE_REGEX = /^bytes=(\d+)-(\d*)$/

function parseRange(rangeHeader: string | null): { start: number; end?: number } | null {
  if (!rangeHeader?.trim()) return null
  const m = rangeHeader.trim().match(RANGE_REGEX)
  if (!m) return null
  const start = parseInt(m[1], 10)
  const end = m[2] === '' ? undefined : parseInt(m[2], 10)
  if (Number.isNaN(start) || (end !== undefined && (Number.isNaN(end) || end < start))) return null
  return { start, end }
}

function getCorsHeaders(corsOrigin: string | undefined): Record<string, string> {
  if (!corsOrigin || corsOrigin.trim() === '') return {}
  return {
    'Access-Control-Allow-Origin': corsOrigin.trim(),
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
  }
}

export async function driveVideoHandler(
  context: Pick<
    HandlerContextWithPath<'config' | 'fetcher' | 'logs', '/api/drive-video'>,
    'url' | 'components' | 'request'
  >
): Promise<
  | { status: number; headers: Record<string, string>; body?: string }
  | { status: number; headers: Record<string, string>; body: Readable }
> {
  const {
    url,
    components: { config, fetcher, logs },
    request
  } = context

  const getConfig = (key: string) => config.getString(key)
  const corsOrigin = await getConfig('DRIVE_VIDEO_CORS_ORIGIN')
  const cors = getCorsHeaders(corsOrigin)

  const fileId = url.searchParams.get('fileId')
  if (!fileId || !isValidFileId(fileId)) {
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Missing or invalid fileId' })
    }
  }

  const allowedList = await getAllowedFileIds(getConfig)
  if (!isFileAllowed(fileId, allowedList)) {
    return {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Not allowed to access this file' })
    }
  }

  const rangeHeader = request?.headers?.get?.('Range') ?? null
  const range = parseRange(rangeHeader)

  try {
    const fetchAdapter = async (url: string, init?: { headers?: Record<string, string> }) => {
      const res = await fetcher.fetch(url, init)
      return {
        ok: res.ok,
        status: res.status,
        headers: { get: (name: string) => res.headers.get(name) },
        body: res.body
      }
    }
    const result = await streamPublicDriveFile(fileId, fetchAdapter, range ?? undefined)
    const isPartial = range !== null && (result.contentRange !== undefined || range.end !== undefined)
    const status = isPartial ? 206 : 200
    const headers: Record<string, string> = {
      'Content-Type': result.contentType,
      'Accept-Ranges': 'bytes',
      ...cors
    }
    if (result.contentLength !== undefined) headers['Content-Length'] = String(result.contentLength)
    if (result.contentRange) headers['Content-Range'] = result.contentRange
    return { status, headers, body: result.stream }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    logs.getLogger('drive-video').warn('Drive video proxy failed', { fileId, message })
    if (message.includes('not found') || message.includes('not accessible')) {
      return {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: 'File not found or not accessible' })
      }
    }
    return {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...cors },
      body: JSON.stringify({ error: 'Failed to stream file' })
    }
  }
}
