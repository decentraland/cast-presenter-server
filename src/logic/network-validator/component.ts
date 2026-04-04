import * as dns from 'dns/promises'
import type { INetworkValidatorComponent } from './types'

/** Allowed domains for video downloads extracted from PDF annotations. */
const ALLOWED_VIDEO_DOMAINS = new Set([
  'drive.google.com',
  'drive.usercontent.google.com',
  'docs.google.com',
  'youtube.com',
  'www.youtube.com',
  'youtu.be',
  'vimeo.com',
  'player.vimeo.com'
])

/**
 * Checks whether an IPv4 address falls within a private or reserved range.
 *
 * Covers RFC 1918 (10/8, 172.16/12, 192.168/16), loopback (127/8),
 * link-local / cloud metadata (169.254/16), multicast (224/4),
 * broadcast (255.255.255.255), and the zero address.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return false
  if (parts[0] === 127) return true
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 169 && parts[1] === 254) return true
  if (parts[0] >= 224 && parts[0] <= 239) return true // multicast
  if (parts.every((p) => p === 255)) return true // broadcast
  if (parts.every((p) => p === 0)) return true
  return false
}

/**
 * Checks whether an IPv6 address is private or reserved.
 *
 * Covers loopback (::1), unspecified (::), link-local (fe80::/10),
 * unique local (fc00::/7), and IPv6-mapped IPv4 (::ffff:x.x.x.x).
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim()

  // IPv6-mapped IPv4 — e.g. ::ffff:127.0.0.1 or ::ffff:10.0.0.1
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedMatch) return isPrivateIPv4(mappedMatch[1])

  if (normalized === '::1') return true // loopback
  if (normalized === '::') return true // unspecified

  // Expand compressed IPv6 to check prefix ranges
  const firstGroup = normalized.split(':')[0]
  const prefix = parseInt(firstGroup, 16)
  if (!Number.isNaN(prefix)) {
    if ((prefix & 0xffc0) === 0xfe80) return true // link-local fe80::/10
    if ((prefix & 0xfe00) === 0xfc00) return true // unique local fc00::/7
  }

  return false
}

/**
 * Checks whether an IP address (IPv4 or IPv6) is private or reserved.
 *
 * @param ip - IPv4 dotted-decimal or IPv6 string
 * @returns true when the address is private or reserved
 */
export function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIPv6(ip)
  return isPrivateIPv4(ip)
}

/**
 * Validates that a URL uses HTTPS and does not resolve to a private IP.
 *
 * Performs DNS resolution on the hostname and checks every returned
 * A-record against the private IP list. DNS failures are silently
 * ignored (the downstream fetch will fail naturally).
 *
 * @param url - Absolute URL string to validate
 * @throws {Error} If the URL is malformed, uses non-HTTPS, or resolves to a private IP
 */
export async function validateHttpsUrl(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`URL must use HTTPS, got ${parsed.protocol} for ${url}`)
  }

  try {
    const addresses = await dns.resolve4(parsed.hostname)
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`URL resolves to private IP: ${parsed.hostname} → ${addr}`)
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) throw err
  }

  try {
    const addresses = await dns.resolve6(parsed.hostname)
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`URL resolves to private IP: ${parsed.hostname} → ${addr}`)
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) throw err
  }
}

/**
 * Validates a video URL against HTTPS, private-IP, and domain-allowlist checks.
 *
 * @param url - The video URL to validate
 * @throws {Error} If the URL is invalid, non-HTTPS, resolves to private IP, or domain not allowed
 */
export async function validateVideoUrl(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid video URL: ${url}`)
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Video URL must use HTTPS, got ${parsed.protocol} for ${url}`)
  }

  if (!ALLOWED_VIDEO_DOMAINS.has(parsed.hostname)) {
    throw new Error(`Video URL domain not allowed: ${parsed.hostname}`)
  }

  try {
    const addresses = await dns.resolve4(parsed.hostname)
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`Video URL resolves to private IP: ${parsed.hostname} → ${addr}`)
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) throw err
  }

  try {
    const addresses = await dns.resolve6(parsed.hostname)
    for (const addr of addresses) {
      if (isPrivateIP(addr)) {
        throw new Error(`Video URL resolves to private IP: ${parsed.hostname} → ${addr}`)
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) throw err
  }
}

/**
 * Creates the network validator component.
 *
 * Provides SSRF protection utilities for validating URLs
 * before making outbound HTTP requests.
 *
 * @returns INetworkValidatorComponent implementation
 */
export function createNetworkValidatorComponent(): INetworkValidatorComponent {
  return {
    isPrivateIP,
    validateHttpsUrl,
    validateVideoUrl
  }
}
