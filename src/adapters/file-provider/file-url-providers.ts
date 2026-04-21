/**
 * File URL provider abstraction for resolving sharing URLs into direct download URLs.
 *
 * Mirrors the pattern in video-providers.ts. To add a new provider:
 * 1. Create a class extending FileUrlProvider
 * 2. Implement matches() and resolve()
 * 3. Register it in the PROVIDERS array (before DirectUrlProvider)
 */

export interface ResolvedFileUrl {
  url: string
  filename?: string
}

export abstract class FileUrlProvider {
  abstract readonly name: string

  /** Returns true if this provider can handle the given URL. */
  abstract matches(url: string): boolean

  /** Transforms a sharing URL into a direct download URL. */
  abstract resolve(url: string): ResolvedFileUrl
}

// --- Google Docs (Slides + Drive) ---

const GSLIDES_RE = /^https:\/\/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/
const GDRIVE_RE = /^https:\/\/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/

export class GoogleDocsProvider extends FileUrlProvider {
  readonly name = 'google-docs'

  matches(url: string): boolean {
    return GSLIDES_RE.test(url) || GDRIVE_RE.test(url)
  }

  resolve(url: string): ResolvedFileUrl {
    const slidesMatch = url.match(GSLIDES_RE)
    if (slidesMatch) {
      const id = slidesMatch[1]
      return {
        url: `https://docs.google.com/presentation/d/${id}/export?format=pdf`,
        filename: `${id}.pdf`
      }
    }

    const driveMatch = url.match(GDRIVE_RE)
    if (driveMatch) {
      return {
        url: `https://drive.usercontent.google.com/download?id=${driveMatch[1]}&export=download&confirm=t`
      }
    }

    return { url }
  }
}

// --- Direct URL (fallback) ---

export class DirectUrlProvider extends FileUrlProvider {
  readonly name = 'direct'

  matches(): boolean {
    return true
  }

  resolve(url: string): ResolvedFileUrl {
    return { url }
  }
}

// --- Provider registry ---
// Order matters: first match wins. DirectUrlProvider must be last (catch-all).

const PROVIDERS: FileUrlProvider[] = [new GoogleDocsProvider(), new DirectUrlProvider()]

export function resolveFileUrl(url: string): ResolvedFileUrl {
  const provider = PROVIDERS.find((p) => p.matches(url))
  if (!provider) {
    return { url }
  }
  return provider.resolve(url)
}
