import * as dns from 'dns/promises'
import type { INetworkValidatorComponent, ResolvedUrl } from './types'

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
 * link-local / cloud metadata (169.254/16), CGNAT (100.64/10, RFC 6598),
 * benchmarking (198.18/15, RFC 2544), multicast (224/4),
 * reserved (240/4), broadcast (255.255.255.255), and the zero address.
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
  if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true // CGNAT (RFC 6598)
  if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true // benchmarking (RFC 2544)
  if (parts[0] >= 240) return true // reserved
  return false
}

/**
 * Expands a compressed IPv6 address to 8 full hex groups.
 * e.g. "::ffff:7f00:1" → ["0000","0000","0000","0000","0000","ffff","7f00","0001"]
 */
function expandIPv6(ip: string): string[] {
  const normalized = ip.toLowerCase().trim()

  // Handle IPv4-compatible/mapped with dotted notation (e.g. ::ffff:127.0.0.1, ::127.0.0.1)
  const v4Suffix = normalized.match(/:(\d+\.\d+\.\d+\.\d+)$/)
  let hex: string
  if (v4Suffix) {
    const parts = v4Suffix[1].split('.').map(Number)
    const hi = ((parts[0] << 8) | parts[1]).toString(16).padStart(4, '0')
    const lo = ((parts[2] << 8) | parts[3]).toString(16).padStart(4, '0')
    hex = normalized.replace(/:(\d+\.\d+\.\d+\.\d+)$/, `:${hi}:${lo}`)
  } else {
    hex = normalized
  }

  const halves = hex.split('::')
  // Malformed: multiple '::' — treat as unresolvable (fail-safe to "private")
  if (halves.length > 2) {
    return ['0000', '0000', '0000', '0000', '0000', '0000', '0000', '0000']
  }
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves[1] ? halves[1].split(':') : []
    const missing = 8 - left.length - right.length
    const middle = Array(Math.max(0, missing)).fill('0000')
    return [...left, ...middle, ...right].map((g) => g.padStart(4, '0')).slice(0, 8)
  }
  const groups = hex.split(':').map((g) => g.padStart(4, '0'))
  // Ensure we always return exactly 8 groups
  while (groups.length < 8) groups.push('0000')
  return groups.slice(0, 8)
}

/**
 * Checks whether an IPv6 address is private or reserved.
 *
 * Covers loopback (::1), unspecified (::), link-local (fe80::/10),
 * unique local (fc00::/7), IPv6-mapped IPv4 in both dotted and hex form
 * (::ffff:x.x.x.x, ::ffff:7f00:1), IPv4-compatible (::x.x.x.x),
 * 6to4 addresses (2002::/16 with embedded private IPv4),
 * and NAT64 (64:ff9b::/96, RFC 6052) with embedded private IPv4.
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim()

  // Malformed: multiple '::' — fail-closed (treat as private/blocked)
  if ((normalized.match(/::/g) || []).length > 1) return true

  // Dotted-notation IPv6-mapped IPv4 — e.g. ::ffff:127.0.0.1
  const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mappedDotted) return isPrivateIPv4(mappedDotted[1])

  // Dotted-notation IPv4-compatible — e.g. ::127.0.0.1
  const compatDotted = normalized.match(/^::(\d+\.\d+\.\d+\.\d+)$/)
  if (compatDotted) return isPrivateIPv4(compatDotted[1])

  if (normalized === '::1') return true // loopback
  if (normalized === '::') return true // unspecified

  const groups = expandIPv6(normalized)
  const g = groups.map((s) => parseInt(s, 16))

  // Hex-form IPv6-mapped IPv4 — ::ffff:XXYY:ZZWW
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    const ipv4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
    return isPrivateIPv4(ipv4)
  }

  // IPv4-compatible — ::XXYY:ZZWW (groups 0-5 are zero, not ffff-mapped)
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && (g[6] !== 0 || g[7] > 1)) {
    const ipv4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
    return isPrivateIPv4(ipv4)
  }

  // 6to4 — 2002:XXYY:ZZWW::/48 embeds the IPv4 in groups 1-2
  if (g[0] === 0x2002) {
    const ipv4 = `${g[1] >> 8}.${g[1] & 0xff}.${g[2] >> 8}.${g[2] & 0xff}`
    return isPrivateIPv4(ipv4)
  }

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) — embeds IPv4 in last 32 bits
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
    const ipv4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
    return isPrivateIPv4(ipv4)
  }

  // Link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfe80) return true
  // Unique local fc00::/7
  if ((g[0] & 0xfe00) === 0xfc00) return true

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
 * Resolves DNS for a hostname and validates that no address is private.
 *
 * Returns the validated addresses so callers can pin TCP connections
 * to them, preventing DNS rebinding (TOCTOU) attacks.
 */
async function resolveDnsAndValidate(hostname: string): Promise<string[]> {
  const addresses: string[] = []

  try {
    const v4 = await dns.resolve4(hostname)
    for (const addr of v4) {
      if (isPrivateIP(addr)) {
        throw new Error(`URL resolves to private IP: ${hostname} → ${addr}`)
      }
    }
    addresses.push(...v4)
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) throw err
  }

  try {
    const v6 = await dns.resolve6(hostname)
    for (const addr of v6) {
      if (isPrivateIP(addr)) {
        throw new Error(`URL resolves to private IP: ${hostname} → ${addr}`)
      }
    }
    addresses.push(...v6)
  } catch (err) {
    if (err instanceof Error && err.message.includes('private IP')) throw err
  }

  if (addresses.length === 0) {
    throw new Error(`Could not resolve any addresses for ${hostname}`)
  }

  return addresses
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
  await resolveAndValidateUrl(url)
}

/**
 * Validates a URL and returns the parsed URL with resolved, validated IP addresses.
 *
 * This prevents DNS rebinding (TOCTOU) attacks: callers use the returned
 * addresses to pin the TCP connection instead of re-resolving DNS.
 *
 * @param url - Absolute URL string to validate
 * @returns Parsed URL and its validated IP addresses
 * @throws {Error} If the URL is malformed, uses non-HTTPS, or resolves to a private IP
 */
export async function resolveAndValidateUrl(url: string): Promise<ResolvedUrl> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid URL: ${url}`)
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`URL must use HTTPS, got ${parsed.protocol} for ${url}`)
  }

  const addresses = await resolveDnsAndValidate(parsed.hostname)
  return { url: parsed.href, hostname: parsed.hostname, addresses }
}

/**
 * Validates a video URL against HTTPS, private-IP, and domain-allowlist checks.
 *
 * @param url - The video URL to validate
 * @throws {Error} If the URL is invalid, non-HTTPS, resolves to private IP, or domain not allowed
 */
export async function validateVideoUrl(url: string): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`Invalid video URL: ${url}`)
  }

  // Upgrade http → https for allowlisted domains (e.g., PPTX embeds http:// Google Drive links)
  if (parsed.protocol === 'http:' && ALLOWED_VIDEO_DOMAINS.has(parsed.hostname)) {
    parsed.protocol = 'https:'
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Video URL must use HTTPS, got ${parsed.protocol} for ${url}`)
  }

  if (!ALLOWED_VIDEO_DOMAINS.has(parsed.hostname)) {
    throw new Error(`Video URL domain not allowed: ${parsed.hostname}`)
  }

  await resolveDnsAndValidate(parsed.hostname)
  return parsed.href
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
    resolveAndValidateUrl,
    validateVideoUrl
  }
}
