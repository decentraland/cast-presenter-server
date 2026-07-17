import { errors as joseErrors, jwtVerify } from 'jose'
import { InvalidTokenError } from './errors'
import type { ILiveKitTokenVerifier, VerifiedLiveKitToken } from './types'
import type { AppComponents } from '../../types'

/** LiveKit tokens are signed with HMAC-SHA256 by the LiveKit SDKs. */
const ACCEPTED_ALGORITHMS = ['HS256']

interface LiveKitVideoGrant {
  room?: unknown
}

interface LiveKitJwtPayload {
  sub?: unknown
  video?: LiveKitVideoGrant
}

/**
 * Creates the LiveKit token verifier component.
 *
 * Validates HMAC-SHA256 JWTs against `LIVEKIT_API_SECRET`, enforces that the
 * issuer matches `LIVEKIT_API_KEY`, and extracts the target room and identity
 * from the `video.room` grant and the `sub` claim respectively.
 *
 * `jose.jwtVerify` uses Web Crypto's constant-time HMAC comparison, so
 * signature checks are not vulnerable to timing attacks.
 *
 * @param components - Required: config (API key + secret), logs (for verify failures)
 * @returns ILiveKitTokenVerifier implementation
 */
export async function createLiveKitTokenVerifier(
  components: Pick<AppComponents, 'config' | 'logs'>
): Promise<ILiveKitTokenVerifier> {
  const { config, logs } = components
  const logger = logs.getLogger('livekit-token-verifier')

  const apiKey = await config.requireString('LIVEKIT_API_KEY')
  const apiSecret = await config.requireString('LIVEKIT_API_SECRET')
  const secretKey = new TextEncoder().encode(apiSecret)

  return {
    async verify(token: string): Promise<VerifiedLiveKitToken> {
      if (typeof token !== 'string' || token.length === 0) {
        throw new InvalidTokenError('Missing token')
      }

      let payload: LiveKitJwtPayload
      try {
        const result = await jwtVerify(token, secretKey, {
          algorithms: ACCEPTED_ALGORITHMS,
          issuer: apiKey
        })
        payload = result.payload as LiveKitJwtPayload
      } catch (err) {
        // Log the specific reason for observability, but don't leak it to callers.
        const reason =
          err instanceof joseErrors.JOSEError
            ? `${err.code}: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err)
        logger.warn(`Token verification failed: ${reason}`)
        throw new InvalidTokenError()
      }

      const roomId = payload.video?.room
      if (typeof roomId !== 'string' || roomId.length === 0) {
        throw new InvalidTokenError('Token is missing video.room grant')
      }

      const identity = payload.sub
      if (typeof identity !== 'string' || identity.length === 0) {
        throw new InvalidTokenError('Token is missing identity (sub)')
      }

      return { roomId, identity }
    }
  }
}
