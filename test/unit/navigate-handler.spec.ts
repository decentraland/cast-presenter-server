import { PresentationNotFoundError } from '../../src/adapters/presentation-manager'
import { navigateHandler } from '../../src/controllers/handlers/navigate-handler'
import { createMockLogger, createMockPresentationState } from '../mocks/context'

function mockContext(body: Record<string, unknown>, options?: { throwError?: Error }) {
  const mockState = createMockPresentationState()

  return {
    params: { id: 'test-id' },
    request: {
      json: async () => body
    },
    components: {
      logs: createMockLogger(),
      presentationManager: {
        navigate: async () => {
          if (options?.throwError) throw options.throwError
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
    expect((res.body as Record<string, string>).error).toContain('Invalid action')
  })

  it('returns 400 for invalid action value', async () => {
    const res = await navigateHandler(mockContext({ action: 'jump' }))
    expect(res.status).toBe(400)
  })

  it('returns 200 for valid next action', async () => {
    const res = await navigateHandler(mockContext({ action: 'next' }))
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>).currentSlide).toBeDefined()
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
    const res = await navigateHandler(
      mockContext({ action: 'next' }, { throwError: new PresentationNotFoundError('test-id') })
    )
    expect(res.status).toBe(404)
    expect((res.body as Record<string, string>).error).toContain('not found')
  })
})
