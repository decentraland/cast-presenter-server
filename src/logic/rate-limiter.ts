import type { IHttpServerComponent } from '@well-known-components/interfaces'

interface RateLimitEntry {
  count: number
  resetAt: number
}

/**
 * Simple in-memory per-IP rate limiter.
 * Tracks request counts in a sliding window and returns 429 when exceeded.
 */
export function createRateLimiter(maxRequests: number, windowMs: number) {
  const store = new Map<string, RateLimitEntry>()

  // Periodically clean up expired entries to prevent memory leaks
  const cleanupInterval = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) store.delete(key)
    }
  }, windowMs)
  cleanupInterval.unref()

  return function checkRateLimit(ip: string): IHttpServerComponent.IResponse | null {
    const now = Date.now()
    const entry = store.get(ip)

    if (!entry || now >= entry.resetAt) {
      store.set(ip, { count: 1, resetAt: now + windowMs })
      return null
    }

    entry.count++
    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000)
      return {
        status: 429,
        headers: { 'Retry-After': String(retryAfter) },
        body: { error: 'Too many requests, please try again later' }
      }
    }

    return null
  }
}
