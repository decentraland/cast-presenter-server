import type { IBaseComponent } from '@well-known-components/interfaces'

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
   * Validates a video URL against the HTTPS/private-IP checks
   * plus a domain allowlist for known video providers.
   *
   * @param url - The video URL to validate
   * @throws {Error} If the URL fails HTTPS, domain, or private IP checks
   */
  validateVideoUrl(url: string): Promise<void>
}
