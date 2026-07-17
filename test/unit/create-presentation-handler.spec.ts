import type { IHttpServerComponent } from '@dcl/core-commons'
import { InvalidUrlError } from '../../src/adapters/file-provider'
import { createPresentationHandler } from '../../src/controllers/handlers/create-presentation-handler'
import { InvalidTokenError } from '../../src/logic/livekit-token-verifier'
import {
  InvalidLivekitCredentialsError,
  MaxConcurrentPresentationsError,
  RoomAlreadyPresentingError
} from '../../src/logic/presentation-manager'
import { createMockLogger } from '../mocks/context'

function createMockFileProvider(overrides?: { fromUrlError?: Error }) {
  return {
    fromUrl: jest.fn().mockImplementation(async () => {
      if (overrides?.fromUrlError) throw overrides.fromUrlError
      return { buffer: Buffer.from('%PDF-1.7'), filename: 'test.pdf', fields: {} }
    }),
    fromMultipart: jest.fn().mockResolvedValue({
      buffer: Buffer.from('%PDF-1.7'),
      filename: 'test.pdf',
      fields: { livekitToken: 'token' }
    })
  }
}

function createMockPresentationManager(overrides?: {
  validateCredentialsError?: Error
  createPresentationError?: Error
}) {
  return {
    validateCredentials: jest.fn().mockImplementation(async () => {
      if (overrides?.validateCredentialsError) throw overrides.validateCredentialsError
    }),
    createPresentation: jest.fn().mockImplementation(async () => {
      if (overrides?.createPresentationError) throw overrides.createPresentationError
      return {
        id: 'test-id',
        fileName: 'test',
        slideCount: 1,
        currentSlide: 0,
        fileType: 'pdf' as const
      }
    })
  }
}

function createJsonContext(
  body: Record<string, unknown>,
  overrides?: { fromUrlError?: Error; validateCredentialsError?: Error; createPresentationError?: Error }
) {
  const jsonBytes = Buffer.from(JSON.stringify(body), 'utf-8')
  return {
    request: {
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json'
          return null
        }
      },
      arrayBuffer: async () => jsonBytes.buffer.slice(jsonBytes.byteOffset, jsonBytes.byteOffset + jsonBytes.byteLength)
    },
    components: {
      logs: createMockLogger(),
      presentationManager: createMockPresentationManager(overrides),
      fileProvider: createMockFileProvider(overrides)
    }
  } as unknown as Parameters<typeof createPresentationHandler>[0]
}

function createRawJsonContext(raw: string) {
  const bytes = Buffer.from(raw, 'utf-8')
  return {
    request: {
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json'
          return null
        }
      },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
    components: {
      logs: createMockLogger(),
      presentationManager: createMockPresentationManager(),
      fileProvider: createMockFileProvider()
    }
  } as unknown as Parameters<typeof createPresentationHandler>[0]
}

function createBadContentTypeContext() {
  return {
    request: {
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'text/plain'
          return null
        }
      }
    },
    components: {
      logs: createMockLogger(),
      presentationManager: createMockPresentationManager(),
      fileProvider: createMockFileProvider()
    }
  } as unknown as Parameters<typeof createPresentationHandler>[0]
}

function createOversizedJsonContext(bodySize: number) {
  // Create a JSON body that exceeds the size limit
  const body = {
    url: 'https://example.com/f.pdf',
    livekitToken: 't',
    pad: 'x'.repeat(bodySize)
  }
  const jsonBytes = Buffer.from(JSON.stringify(body), 'utf-8')
  return {
    request: {
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json'
          return null
        }
      },
      arrayBuffer: async () => jsonBytes.buffer.slice(jsonBytes.byteOffset, jsonBytes.byteOffset + jsonBytes.byteLength)
    },
    components: {
      logs: createMockLogger(),
      presentationManager: createMockPresentationManager(),
      fileProvider: createMockFileProvider()
    }
  } as unknown as Parameters<typeof createPresentationHandler>[0]
}

describe('when handling a create presentation request', () => {
  let result: IHttpServerComponent.IResponse

  describe('and the Content-Type is unsupported', () => {
    beforeEach(async () => {
      result = await createPresentationHandler(createBadContentTypeContext())
    })

    it('should return status 400', () => {
      expect(result.status).toBe(400)
    })

    it('should return an error message mentioning Content-Type', () => {
      expect((result.body as Record<string, string>).error).toContain('Content-Type')
    })
  })

  describe('and the request is JSON-based', () => {
    describe('and the url field is missing', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(createJsonContext({ livekitToken: 't' }))
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about missing url', () => {
        expect((result.body as Record<string, string>).error).toContain('Missing url')
      })
    })

    describe('and the livekitToken field is missing', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(createJsonContext({ url: 'https://example.com/file.pdf' }))
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about missing livekitToken', () => {
        expect((result.body as Record<string, string>).error).toContain('Missing livekitToken')
      })
    })

    describe('and the URL is not HTTPS', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(
          createJsonContext(
            { url: 'http://example.com/file.pdf', livekitToken: 't' },
            { fromUrlError: new InvalidUrlError('URL must use HTTPS') }
          )
        )
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message mentioning HTTPS', () => {
        expect((result.body as Record<string, string>).error).toContain('HTTPS')
      })
    })

    describe('and the URL is malformed', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(
          createJsonContext(
            { url: 'not-a-url', livekitToken: 't' },
            { fromUrlError: new InvalidUrlError('Invalid URL: not-a-url') }
          )
        )
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message containing "Invalid URL"', () => {
        expect((result.body as Record<string, string>).error).toContain('Invalid URL')
      })
    })

    describe('and the JSON body exceeds MAX_JSON_BODY_SIZE without Content-Length header', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(createOversizedJsonContext(2 * 1024 * 1024))
      })

      it('should return status 413', () => {
        expect(result.status).toBe(413)
      })

      it('should return an error message about size limit', () => {
        expect((result.body as Record<string, string>).error).toContain('size')
      })
    })

    describe('and the url field is a non-string value', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(createJsonContext({ url: 123, livekitToken: 't' }))
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about missing url', () => {
        expect((result.body as Record<string, string>).error).toContain('Missing url')
      })
    })

    describe('and the livekitToken field is a non-string value', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(
          createJsonContext({ url: 'https://example.com/file.pdf', livekitToken: true })
        )
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about missing livekitToken', () => {
        expect((result.body as Record<string, string>).error).toContain('Missing livekitToken')
      })
    })

    describe('and the LiveKit credentials fail pre-validation', () => {
      const context = createJsonContext(
        { url: 'https://example.com/file.pdf', livekitToken: 'bad' },
        { validateCredentialsError: new InvalidLivekitCredentialsError('token rejected') }
      )

      beforeEach(async () => {
        result = await createPresentationHandler(context)
      })

      it('should return status 401', () => {
        expect(result.status).toBe(401)
      })

      it('should not trigger the URL download', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect((context.components.fileProvider as any).fromUrl).not.toHaveBeenCalled()
      })
    })

    describe('and the JWT signature is invalid', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(
          createJsonContext(
            { url: 'https://example.com/file.pdf', livekitToken: 'forged' },
            { createPresentationError: new InvalidTokenError() }
          )
        )
      })

      it('should return status 401', () => {
        expect(result.status).toBe(401)
      })

      it('should return an error message mentioning the token', () => {
        expect((result.body as Record<string, string>).error).toContain('token')
      })
    })

    describe('and the target room already has an active presentation', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(
          createJsonContext(
            { url: 'https://example.com/file.pdf', livekitToken: 't' },
            { createPresentationError: new RoomAlreadyPresentingError() }
          )
        )
      })

      it('should return status 409', () => {
        expect(result.status).toBe(409)
      })

      it('should return a generic error message about an active presentation', () => {
        expect((result.body as Record<string, string>).error).toContain('active presentation')
      })
    })

    describe('and the global concurrent limit is reached', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(
          createJsonContext(
            { url: 'https://example.com/file.pdf', livekitToken: 't' },
            { createPresentationError: new MaxConcurrentPresentationsError(5) }
          )
        )
      })

      it('should return status 429', () => {
        expect(result.status).toBe(429)
      })
    })

    describe('and the body is the JSON literal null', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(createRawJsonContext('null'))
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about a JSON object', () => {
        expect((result.body as Record<string, string>).error).toContain('JSON object')
      })
    })

    describe('and the body is a JSON array', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(createRawJsonContext('[]'))
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about a JSON object', () => {
        expect((result.body as Record<string, string>).error).toContain('JSON object')
      })
    })

    describe('and the body is a JSON primitive', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(createRawJsonContext('"hello"'))
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about a JSON object', () => {
        expect((result.body as Record<string, string>).error).toContain('JSON object')
      })
    })

    describe('and the body is malformed JSON', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(createRawJsonContext('{not json'))
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about valid JSON', () => {
        expect((result.body as Record<string, string>).error).toContain('valid JSON')
      })
    })

    describe('and every required field is present and valid', () => {
      const context = createJsonContext({ url: 'https://example.com/file.pdf', livekitToken: 't' })

      beforeEach(async () => {
        result = await createPresentationHandler(context)
      })

      it('should return status 201', () => {
        expect(result.status).toBe(201)
      })

      it('should call createPresentation without a livekitUrl argument', () => {
        const call = (
          context.components.presentationManager as unknown as {
            createPresentation: jest.Mock
          }
        ).createPresentation.mock.calls[0]
        expect(call).toHaveLength(4)
        expect(call[2]).toBe('t') // livekitToken
        expect(typeof call[3]).toBe('string') // fileName, not a URL
      })
    })
  })
})
