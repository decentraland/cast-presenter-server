import { SignJWT } from 'jose'
import type { IConfigComponent } from '@well-known-components/interfaces'
import { InvalidTokenError, createLiveKitTokenVerifier } from '../../src/logic/livekit-token-verifier'
import { createMockLogger } from '../mocks/context'

const TEST_API_KEY = 'test-api-key'
const TEST_API_SECRET = 'super-secret-shared-key-with-enough-entropy'
const TEST_ROOM = 'lobby-42'
const TEST_IDENTITY = 'alice'

function createMockConfig(overrides?: Partial<Record<string, string>>): IConfigComponent {
  const values: Record<string, string> = {
    LIVEKIT_API_KEY: TEST_API_KEY,
    LIVEKIT_API_SECRET: TEST_API_SECRET,
    ...overrides
  }
  return {
    getString: jest.fn(async (name: string) => values[name]),
    requireString: jest.fn(async (name: string) => {
      const v = values[name]
      if (v === undefined) throw new Error(`Missing required config: ${name}`)
      return v
    }),
    getNumber: jest.fn(async () => undefined),
    requireNumber: jest.fn(async () => {
      throw new Error('not used')
    })
  }
}

interface TokenOverrides {
  issuer?: string
  subject?: string
  room?: string | null
  expiresIn?: string
  notBefore?: string
  secret?: string
  omitVideo?: boolean
}

async function signToken(overrides: TokenOverrides = {}): Promise<string> {
  const secret = new TextEncoder().encode(overrides.secret ?? TEST_API_SECRET)
  const video = overrides.omitVideo
    ? undefined
    : overrides.room === null
      ? {}
      : { room: overrides.room ?? TEST_ROOM, roomJoin: true }

  const builder = new SignJWT(video ? { video } : {}).setProtectedHeader({ alg: 'HS256' })
  builder.setIssuer(overrides.issuer ?? TEST_API_KEY)
  builder.setSubject(overrides.subject ?? TEST_IDENTITY)
  builder.setIssuedAt()
  if (overrides.notBefore !== undefined) builder.setNotBefore(overrides.notBefore)
  builder.setExpirationTime(overrides.expiresIn ?? '5m')
  return builder.sign(secret)
}

describe('when verifying a LiveKit token', () => {
  describe('and the token is signed with the correct secret and has a video.room grant', () => {
    let token: string
    let result: { roomId: string; identity: string }

    beforeEach(async () => {
      const verifier = await createLiveKitTokenVerifier({ config: createMockConfig(), logs: createMockLogger() })
      token = await signToken()
      result = await verifier.verify(token)
    })

    it('should return the roomId from the video.room grant', () => {
      expect(result.roomId).toBe(TEST_ROOM)
    })

    it('should return the identity from the sub claim', () => {
      expect(result.identity).toBe(TEST_IDENTITY)
    })
  })

  describe('and the token is signed with the wrong secret', () => {
    let error: unknown

    beforeEach(async () => {
      const verifier = await createLiveKitTokenVerifier({ config: createMockConfig(), logs: createMockLogger() })
      const token = await signToken({ secret: 'a-different-secret-that-is-not-the-configured-one' })
      try {
        await verifier.verify(token)
      } catch (err) {
        error = err
      }
    })

    it('should throw InvalidTokenError', () => {
      expect(error).toBeInstanceOf(InvalidTokenError)
    })
  })

  describe('and the token is expired', () => {
    let error: unknown

    beforeEach(async () => {
      const verifier = await createLiveKitTokenVerifier({ config: createMockConfig(), logs: createMockLogger() })
      const token = await signToken({ expiresIn: '-1s' })
      try {
        await verifier.verify(token)
      } catch (err) {
        error = err
      }
    })

    it('should throw InvalidTokenError', () => {
      expect(error).toBeInstanceOf(InvalidTokenError)
    })
  })

  describe('and the token issuer does not match LIVEKIT_API_KEY', () => {
    let error: unknown

    beforeEach(async () => {
      const verifier = await createLiveKitTokenVerifier({ config: createMockConfig(), logs: createMockLogger() })
      const token = await signToken({ issuer: 'some-other-api-key' })
      try {
        await verifier.verify(token)
      } catch (err) {
        error = err
      }
    })

    it('should throw InvalidTokenError', () => {
      expect(error).toBeInstanceOf(InvalidTokenError)
    })
  })

  describe('and the token has no video grant', () => {
    let error: unknown

    beforeEach(async () => {
      const verifier = await createLiveKitTokenVerifier({ config: createMockConfig(), logs: createMockLogger() })
      const token = await signToken({ omitVideo: true })
      try {
        await verifier.verify(token)
      } catch (err) {
        error = err
      }
    })

    it('should throw InvalidTokenError', () => {
      expect(error).toBeInstanceOf(InvalidTokenError)
    })
  })

  describe('and the token has a video grant without a room', () => {
    let error: unknown

    beforeEach(async () => {
      const verifier = await createLiveKitTokenVerifier({ config: createMockConfig(), logs: createMockLogger() })
      const token = await signToken({ room: null })
      try {
        await verifier.verify(token)
      } catch (err) {
        error = err
      }
    })

    it('should throw InvalidTokenError', () => {
      expect(error).toBeInstanceOf(InvalidTokenError)
    })
  })

  describe('and the token is an empty string', () => {
    let error: unknown

    beforeEach(async () => {
      const verifier = await createLiveKitTokenVerifier({ config: createMockConfig(), logs: createMockLogger() })
      try {
        await verifier.verify('')
      } catch (err) {
        error = err
      }
    })

    it('should throw InvalidTokenError', () => {
      expect(error).toBeInstanceOf(InvalidTokenError)
    })
  })

  describe('and the token is structurally invalid', () => {
    let error: unknown

    beforeEach(async () => {
      const verifier = await createLiveKitTokenVerifier({ config: createMockConfig(), logs: createMockLogger() })
      try {
        await verifier.verify('not.a.jwt')
      } catch (err) {
        error = err
      }
    })

    it('should throw InvalidTokenError', () => {
      expect(error).toBeInstanceOf(InvalidTokenError)
    })
  })
})
