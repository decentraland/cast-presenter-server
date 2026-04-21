import type { IBaseComponent } from '@well-known-components/interfaces'

/** Result of resolving and validating a URL, including pinned IP addresses. */
export interface ResolvedUrl {
  url: string
  hostname: string
  addresses: string[]
}

/**
 * Network validation component for SSRF protection.
 *
 * Provides URL validation including HTTPS enforcement,
 * DNS resolution checks against private IP ranges, and
 * domain allowlisting for video URLs.
 */
export interface INetworkValidatorComponent extends IBaseComponent {
  /**
   * Checks whether an IP address falls within a private/reserved range.
   *
   * @param ip - IPv4 address string (e.g. "10.0.0.1")
   * @returns true if the IP is private, link-local, or loopback
   */
  isPrivateIP(ip: string): boolean

  /**
   * Validates that a URL uses HTTPS and does not resolve to a private IP.
   *
   * @param url - The URL to validate
   * @throws {Error} If the URL is invalid, non-HTTPS, or resolves to a private IP
   */
  validateHttpsUrl(url: string): Promise<void>

  /**
   * Validates a URL and returns resolved IP addresses for DNS-pinned connections.
   *
   * Use this instead of validateHttpsUrl when you need to make an HTTP request
   * after validation — the returned addresses prevent DNS rebinding attacks.
   *
   * @param url - The URL to validate
   * @returns Parsed URL with validated, pinned IP addresses
   * @throws {Error} If the URL is invalid, non-HTTPS, or resolves to a private IP
   */
  resolveAndValidateUrl(url: string): Promise<ResolvedUrl>

  /**
   * Validates a video URL against the HTTPS/private-IP checks
   * plus a domain allowlist for known video providers.
   *
   * Upgrades http:// to https:// for allowlisted domains automatically.
   *
   * @param url - The video URL to validate
   * @returns The validated (and possibly https-upgraded) URL
   * @throws {Error} If the URL fails HTTPS, domain, or private IP checks
   */
  validateVideoUrl(url: string): Promise<string>
}
