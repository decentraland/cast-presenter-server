import { createPresentationHandler } from '../../src/controllers/handlers/create-presentation-handler'
import { createMockLogger } from '../mocks/context'

function jsonContext(body: Record<string, unknown>) {
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
      presentationManager: {
        createPresentation: async () => ({
          id: 'test-id',
          fileName: 'test',
          slideCount: 1,
          currentSlide: 0,
          fileType: 'pdf' as const
        })
      },
      fileProvider: {
        fromUrl: async () => {
          throw new (await import('../../src/adapters/file-provider')).InvalidUrlError('URL must use HTTPS')
        },
        fromMultipart: async () => {
          throw new Error('not expected')
        }
      }
    }
  } as unknown as Parameters<typeof createPresentationHandler>[0]
}

function badContentTypeContext() {
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
      presentationManager: {},
      fileProvider: {}
    }
  } as unknown as Parameters<typeof createPresentationHandler>[0]
}

describe('create-presentation-handler', () => {
  describe('Content-Type validation', () => {
    it('rejects unsupported Content-Type', async () => {
      const res = await createPresentationHandler(badContentTypeContext())
      expect(res.status).toBe(400)
      expect((res.body as Record<string, string>).error).toContain('Content-Type')
    })
  })

  describe('JSON / URL-based creation', () => {
    it('returns 400 when url is missing', async () => {
      const res = await createPresentationHandler(jsonContext({ livekitToken: 't', livekitUrl: 'u' }))
      expect(res.status).toBe(400)
      expect((res.body as Record<string, string>).error).toContain('Missing url')
    })

    it('returns 400 when livekitToken is missing', async () => {
      const res = await createPresentationHandler(jsonContext({ url: 'https://example.com/file.pdf' }))
      expect(res.status).toBe(400)
      expect((res.body as Record<string, string>).error).toContain('Missing livekitToken')
    })

    it('returns 400 for non-HTTPS URL', async () => {
      const res = await createPresentationHandler(
        jsonContext({
          url: 'http://example.com/file.pdf',
          livekitToken: 't',
          livekitUrl: 'u'
        })
      )
      expect(res.status).toBe(400)
      expect((res.body as Record<string, string>).error).toContain('HTTPS')
    })

    it('returns 400 for invalid URL', async () => {
      const ctx = jsonContext({
        url: 'not-a-url',
        livekitToken: 't',
        livekitUrl: 'u'
      })
      // Override fileProvider to throw InvalidUrlError for invalid URL
      ctx.components.fileProvider = {
        fromUrl: async () => {
          throw new (await import('../../src/adapters/file-provider')).InvalidUrlError('Invalid URL: not-a-url')
        },
        fromMultipart: async () => {
          throw new Error('not expected')
        }
      } as unknown as typeof ctx.components.fileProvider
      const res = await createPresentationHandler(ctx)
      expect(res.status).toBe(400)
      expect((res.body as Record<string, string>).error).toContain('Invalid URL')
    })
  })
})
