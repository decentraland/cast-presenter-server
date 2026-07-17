/** Result of a successful LiveKit token verification. */
export interface VerifiedLiveKitToken {
  /** The room the token is granted access to (from the `video.room` grant). */
  roomId: string
  /** The identity the token is issued for (the JWT `sub` claim). */
  identity: string
}

/**
 * Verifies LiveKit JWTs server-side against the configured API secret.
 *
 * Ensures clients cannot forge tokens and lets the server derive the target
 * room from a trusted source (the token's `video.room` claim) instead of
 * trusting client-supplied parameters.
 */
export interface ILiveKitTokenVerifier {
  /**
   * Verifies the JWT signature and standard claims.
   *
   * @param token - The JWT string (`HS256`) presented by the client
   * @returns The room and identity extracted from the token
   * @throws {InvalidTokenError} When signature, claims, or grants are invalid
   */
  verify(token: string): Promise<VerifiedLiveKitToken>
}
