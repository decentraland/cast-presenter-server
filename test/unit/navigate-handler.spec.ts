import { navigateHandler } from '../../src/controllers/handlers/navigate-handler'

function mockContext(body: Record<string, unknown>, presentationExists = true) {
  const mockState = {
    id: 'test-id',
    fileName: 'Test',
    slideCount: 5,
    currentSlide: 1,
    fileType: 'pdf' as const,
    slideVideos: [],
    videoState: 'idle' as const
  }

  return {
    params: { id: 'test-id' },
    request: {
      json: async () => body
    },
    components: {
      logs: {
        getLogger: () => ({
          info: () => {
            /* noop */
          },
          warn: () => {
            /* noop */
          },
          error: () => {
            /* noop */
          },
          debug: () => {
            /* noop */
          },
          log: () => {
            /* noop */
          }
        })
      },
      presentationManager: {
        navigate: async (_id: string, _action: string, _slideIndex?: number) => {
          if (!presentationExists) throw new Error('Presentation not found')
          return mockState
        }
      }
    }
  } as unknown as Parameters<typeof navigateHandler>[0]
}

describe('navigate-handler', () => {
  it('returns 400 for missing action', async () => {
    const res = await navigateHandler(mockContext({}))
    expect(res.status).toBe(400)
    expect((res.body as unknown as Record<string, string>).error).toContain('Invalid action')
  })

  it('returns 400 for invalid action value', async () => {
    const res = await navigateHandler(mockContext({ action: 'jump' }))
    expect(res.status).toBe(400)
  })

  it('returns 200 for valid next action', async () => {
    const res = await navigateHandler(mockContext({ action: 'next' }))
    expect(res.status).toBe(200)
    expect((res.body as unknown as Record<string, unknown>).currentSlide).toBeDefined()
  })

  it('returns 200 for valid prev action', async () => {
    const res = await navigateHandler(mockContext({ action: 'prev' }))
    expect(res.status).toBe(200)
  })

  it('returns 200 for valid goto action', async () => {
    const res = await navigateHandler(mockContext({ action: 'goto', slideIndex: 3 }))
    expect(res.status).toBe(200)
  })

  it('returns 404 when presentation not found', async () => {
    const res = await navigateHandler(mockContext({ action: 'next' }, false))
    expect(res.status).toBe(404)
    expect((res.body as unknown as Record<string, string>).error).toContain('not found')
  })
})
