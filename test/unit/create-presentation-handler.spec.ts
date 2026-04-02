import type { IHttpServerComponent } from '@well-known-components/interfaces'
import { InvalidUrlError } from '../../src/adapters/file-provider'
import { createPresentationHandler } from '../../src/controllers/handlers/create-presentation-handler'
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

function createMockPresentationManager() {
  return {
    createPresentation: jest.fn().mockResolvedValue({
      id: 'test-id',
      fileName: 'test',
      slideCount: 1,
      currentSlide: 0,
      fileType: 'pdf' as const
    })
  }
}

function createJsonContext(body: Record<string, unknown>, overrides?: { fromUrlError?: Error }) {
  return {
    request: {
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return 'application/json'
          return null
        }
      },
      json: async () => body
    },
    components: {
      logs: createMockLogger(),
      presentationManager: createMockPresentationManager(),
      fileProvider: createMockFileProvider(overrides)
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
        result = await createPresentationHandler(createJsonContext({ livekitToken: 't', livekitUrl: 'u' }))
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
            { url: 'http://example.com/file.pdf', livekitToken: 't', livekitUrl: 'u' },
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
            { url: 'not-a-url', livekitToken: 't', livekitUrl: 'u' },
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
  })
})
