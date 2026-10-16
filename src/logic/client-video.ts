import { ALLOWED_VIDEO_DOMAINS } from './network-validator'

/** Provider of a video that clients play from its URL. */
export type ClientVideoProvider = 'youtube' | 'drive' | 'vimeo-hls'

/** A video clients play themselves, with its canonical URL. */
export interface ClientVideo {
  provider: ClientVideoProvider
  id: string
  url: string
}

/** Patterns that capture a Google Drive file id from a sharing or download URL. */
export const GOOGLE_DRIVE_ID_PATTERNS = [
  /\/file\/d\/([a-zA-Z0-9_-]+)/,
  /[?&]id=([a-zA-Z0-9_-]+)/,
  /\/uc\?.*id=([a-zA-Z0-9_-]+)/
]

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'youtu.be'])
const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'])
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
const YOUTUBE_PATH_ID = /^\/(?:shorts|live|embed)\/([^/]+)$/
const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/
const VIMEO_HLS_PATH = /^\/external\/(\d+)\.m3u8$/

function parseAllowedUrl(url: string): URL | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol === 'http:') parsed.protocol = 'https:'
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null
  return ALLOWED_VIDEO_DOMAINS.has(parsed.hostname) ? parsed : null
}

function youtubeId(parsed: URL): string | null {
  if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1)
  if (parsed.pathname === '/watch') return parsed.searchParams.get('v')
  return parsed.pathname.match(YOUTUBE_PATH_ID)?.[1] ?? null
}

function driveId(parsed: URL): string | null {
  const target = parsed.pathname + parsed.search
  for (const pattern of GOOGLE_DRIVE_ID_PATTERNS) {
    const match = target.match(pattern)
    if (match) return match[1]
  }
  return null
}

/**
 * Classifies a slide video URL as client-played.
 *
 * @param url - Slide video URL as extracted by a renderer.
 * @returns The provider, id and canonical URL, or `null` when clients cannot play it.
 */
export function classifyClientVideo(url: string): ClientVideo | null {
  const parsed = parseAllowedUrl(url)
  if (!parsed) return null

  if (YOUTUBE_HOSTS.has(parsed.hostname)) {
    const id = youtubeId(parsed)
    return id && YOUTUBE_ID.test(id) ? { provider: 'youtube', id, url: `https://www.youtube.com/watch?v=${id}` } : null
  }

  if (DRIVE_HOSTS.has(parsed.hostname)) {
    const id = driveId(parsed)
    return id && DRIVE_ID.test(id) ? { provider: 'drive', id, url: `https://drive.google.com/file/d/${id}/view` } : null
  }

  const vimeoId = parsed.hostname === 'player.vimeo.com' ? parsed.pathname.match(VIMEO_HLS_PATH)?.[1] : undefined
  if (!vimeoId) return null
  parsed.hash = ''
  return { provider: 'vimeo-hls', id: vimeoId, url: parsed.href }
}
