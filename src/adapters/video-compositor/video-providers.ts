/**
 * Video provider abstraction for resolving sharing URLs into direct download/stream URLs.
 *
 * To add a new provider:
 * 1. Create a class extending VideoProvider
 * 2. Implement matches() and resolve()
 * 3. Register it in the PROVIDERS array (before DirectUrlProvider)
 */

export interface ResolvedVideoUrls {
  downloadUrls: string[]
  streamUrl: string
}

export abstract class VideoProvider {
  abstract readonly name: string

  /** Returns true if this provider can handle the given URL. */
  abstract matches(url: string): boolean

  /** Transforms a sharing URL into direct download and streaming URLs. */
  abstract resolve(url: string): ResolvedVideoUrls
}

// --- Google Drive ---

const GOOGLE_DRIVE_ENDPOINTS = {
  USERCONTENT: 'https://drive.usercontent.google.com/download',
  LEGACY: 'https://drive.google.com/uc'
} as const

const GOOGLE_DRIVE_ID_PATTERNS = [
  /\/file\/d\/([a-zA-Z0-9_-]+)/,
  /[?&]id=([a-zA-Z0-9_-]+)/,
  /\/uc\?.*id=([a-zA-Z0-9_-]+)/
]

export class GoogleDriveProvider extends VideoProvider {
  readonly name = 'google-drive'

  matches(url: string): boolean {
    return this.extractFileId(url) !== null
  }

  resolve(url: string): ResolvedVideoUrls {
    const fileId = this.extractFileId(url)
    if (!fileId) throw new Error(`Not a Google Drive URL: ${url}`)

    const usercontent = `${GOOGLE_DRIVE_ENDPOINTS.USERCONTENT}?id=${fileId}&export=download&confirm=t`
    const legacy = `${GOOGLE_DRIVE_ENDPOINTS.LEGACY}?export=download&id=${fileId}`

    return {
      downloadUrls: [usercontent, legacy],
      streamUrl: usercontent
    }
  }

  private extractFileId(url: string): string | null {
    for (const pattern of GOOGLE_DRIVE_ID_PATTERNS) {
      const match = url.match(pattern)
      if (match) return match[1]
    }
    return null
  }
}

// --- Dropbox ---

const DROPBOX_DOMAINS = ['dropbox.com', 'dl.dropboxusercontent.com']

export class DropboxProvider extends VideoProvider {
  readonly name = 'dropbox'

  matches(url: string): boolean {
    return DROPBOX_DOMAINS.some((domain) => url.includes(domain))
  }

  resolve(url: string): ResolvedVideoUrls {
    const directUrl = url.replace(/dl=0/, 'dl=1').replace(/\?.*$/, '?dl=1')
    return { downloadUrls: [directUrl], streamUrl: directUrl }
  }
}

// --- Direct URL (fallback) ---

export class DirectUrlProvider extends VideoProvider {
  readonly name = 'direct'

  matches(): boolean {
    return true
  }

  resolve(url: string): ResolvedVideoUrls {
    return { downloadUrls: [url], streamUrl: url }
  }
}

// --- Provider registry ---
// Order matters: first match wins. DirectUrlProvider must be last (catch-all).

const PROVIDERS: VideoProvider[] = [new GoogleDriveProvider(), new DropboxProvider(), new DirectUrlProvider()]

export function resolveVideoUrls(url: string): ResolvedVideoUrls {
  const provider = PROVIDERS.find((p) => p.matches(url))
  if (!provider) {
    return { downloadUrls: [url], streamUrl: url }
  }
  return provider.resolve(url)
}
