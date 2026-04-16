import { FileNotFoundError } from '../../adapters/google-drive'
import { FileNotAllowedError, ValidationError } from '../errors'
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
    HandlerContextWithPath<'config' | 'googleDrive' | 'logs', '/api/drive-video'>,
    'url' | 'components' | 'request'
  >
): Promise<
  | { status: number; headers: Record<string, string>; body?: string }
  | { status: number; headers: Record<string, string>; body: Readable }
> {
  const {
    url,
    components: { config, googleDrive, logs },
    request
  } = context

  const corsOrigin = await config.getString('DRIVE_VIDEO_CORS_ORIGIN')
  const cors = getCorsHeaders(corsOrigin)
  let fileId: string | null = null

  try {
    fileId = url.searchParams.get('fileId')
    if (!fileId || !googleDrive.isValidFileId(fileId)) {
      throw new ValidationError('Missing or invalid fileId')
    }

    if (!googleDrive.isFileAllowed(fileId)) {
      throw new FileNotAllowedError()
    }

    const rangeHeader = request?.headers?.get?.('Range') ?? null
    const range = parseRange(rangeHeader)

    const result = await googleDrive.streamFile(fileId, range ?? undefined)
    const isPartial = result.contentRange !== undefined
    const status = isPartial ? 206 : 200
    const headers: Record<string, string> = {
      'Content-Type': result.contentType,
      'Accept-Ranges': 'bytes',
      ...cors
    }
    if (result.contentLength !== undefined) headers['Content-Length'] = String(result.contentLength)
    if (result.contentRange) headers['Content-Range'] = result.contentRange.replace(/[\r\n\0]/g, '')
    return { status, headers, body: result.stream }
  } catch (err) {
    if (err instanceof ValidationError) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: err.message })
      }
    }
    if (err instanceof FileNotAllowedError) {
      return {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...cors },
        body: JSON.stringify({ error: err.message })
      }
    }

    const message = err instanceof Error ? err.message : 'Unknown error'
    logs.getLogger('drive-video').warn('Drive video proxy failed', { fileId: fileId ?? 'unknown', message })

    if (err instanceof FileNotFoundError) {
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
