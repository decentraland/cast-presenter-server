import type { IHttpServerComponent } from '@dcl/core-commons'
import { InvalidUrlError } from '../../src/adapters/file-provider'
import { createPresentationHandler } from '../../src/controllers/handlers/create-presentation-handler'
import { InvalidLivekitCredentialsError } from '../../src/logic/presentation-manager'
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
      fields: { livekitToken: 'token', livekitUrl: 'wss://lk.example.com' }
    })
  }
}

function createMockPresentationManager(overrides?: { validateCredentialsError?: Error }) {
  return {
    validateCredentials: jest.fn().mockImplementation(async () => {
      if (overrides?.validateCredentialsError) throw overrides.validateCredentialsError
    }),
    createPresentation: jest.fn().mockResolvedValue({
      id: 'test-id',
      fileName: 'test',
      slideCount: 1,
      currentSlide: 0,
      fileType: 'pdf' as const
    })
  }
}

function createJsonContext(
  body: Record<string, unknown>,
  overrides?: { fromUrlError?: Error; validateCredentialsError?: Error }
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
    livekitUrl: 'wss://lk.example.com',
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
        result = await createPresentationHandler(
          createJsonContext({ livekitToken: 't', livekitUrl: 'wss://lk.example.com' })
        )
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
            { url: 'http://example.com/file.pdf', livekitToken: 't', livekitUrl: 'wss://lk.example.com' },
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
            { url: 'not-a-url', livekitToken: 't', livekitUrl: 'wss://lk.example.com' },
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
        result = await createPresentationHandler(
          createJsonContext({ url: 123, livekitToken: 't', livekitUrl: 'wss://lk.example.com' })
        )
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
          createJsonContext({
            url: 'https://example.com/file.pdf',
            livekitToken: true,
            livekitUrl: 'wss://lk.example.com'
          })
        )
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about missing livekitToken', () => {
        expect((result.body as Record<string, string>).error).toContain('Missing livekitToken')
      })
    })

    describe('and the livekitUrl uses ws:// instead of wss://', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(
          createJsonContext({
            url: 'https://example.com/file.pdf',
            livekitToken: 't',
            livekitUrl: 'ws://lk.example.com'
          })
        )
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about wss:// protocol', () => {
        expect((result.body as Record<string, string>).error).toContain('wss://')
      })
    })

    describe('and the livekitUrl uses https:// instead of wss://', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(
          createJsonContext({
            url: 'https://example.com/file.pdf',
            livekitToken: 't',
            livekitUrl: 'https://lk.example.com'
          })
        )
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })
    })

    describe('and the LiveKit credentials fail pre-validation', () => {
      const context = createJsonContext(
        { url: 'https://example.com/file.pdf', livekitToken: 'bad', livekitUrl: 'wss://lk.example.com' },
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

    describe('and the livekitUrl is malformed', () => {
      beforeEach(async () => {
        result = await createPresentationHandler(
          createJsonContext({ url: 'https://example.com/file.pdf', livekitToken: 't', livekitUrl: 'not-a-url' })
        )
      })

      it('should return status 400', () => {
        expect(result.status).toBe(400)
      })

      it('should return an error message about invalid URL', () => {
        expect((result.body as Record<string, string>).error).toContain('valid URL')
      })
    })
  })
})
