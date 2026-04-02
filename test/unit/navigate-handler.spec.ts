import type { IHttpServerComponent } from '@well-known-components/interfaces'
import { navigateHandler } from '../../src/controllers/handlers/navigate-handler'
import { PresentationNotFoundError } from '../../src/logic/presentation-manager'
import { createMockLogger, createMockPresentationState } from '../mocks/context'

function createMockContext(body: Record<string, unknown>, options?: { throwError?: Error }) {
  const mockState = createMockPresentationState()

  return {
    params: { id: 'test-id' },
    request: {
      json: async () => body
    },
    components: {
      logs: createMockLogger(),
      presentationManager: {
        navigate: jest.fn().mockImplementation(async () => {
          if (options?.throwError) throw options.throwError
          return mockState
        })
      }
    }
  } as unknown as Parameters<typeof navigateHandler>[0]
}

describe('when handling a navigate request', () => {
  let result: IHttpServerComponent.IResponse

  describe('and the action field is missing', () => {
    beforeEach(async () => {
      result = await navigateHandler(createMockContext({}))
    })

    it('should return status 400', () => {
      expect(result.status).toBe(400)
    })

    it('should return an error message about invalid action', () => {
      expect((result.body as Record<string, string>).error).toContain('Invalid action')
    })
  })

  describe('and the action is an unsupported value', () => {
    beforeEach(async () => {
      result = await navigateHandler(createMockContext({ action: 'jump' }))
    })

    it('should return status 400', () => {
      expect(result.status).toBe(400)
    })
  })

  describe('and the action is "next"', () => {
    beforeEach(async () => {
      result = await navigateHandler(createMockContext({ action: 'next' }))
    })

    it('should return status 200', () => {
      expect(result.status).toBe(200)
    })

    it('should return the presentation state with currentSlide', () => {
      expect((result.body as Record<string, unknown>).currentSlide).toBeDefined()
    })
  })

  describe('and the action is "prev"', () => {
    beforeEach(async () => {
      result = await navigateHandler(createMockContext({ action: 'prev' }))
    })

    it('should return status 200', () => {
      expect(result.status).toBe(200)
    })
  })

  describe('and the action is "goto" with a slide index', () => {
    beforeEach(async () => {
      result = await navigateHandler(createMockContext({ action: 'goto', slideIndex: 3 }))
    })

    it('should return status 200', () => {
      expect(result.status).toBe(200)
    })
  })

  describe('and the presentation does not exist', () => {
    beforeEach(async () => {
      result = await navigateHandler(
        createMockContext({ action: 'next' }, { throwError: new PresentationNotFoundError('test-id') })
      )
    })

    it('should return status 404', () => {
      expect(result.status).toBe(404)
    })

    it('should return an error message containing "not found"', () => {
      expect((result.body as Record<string, string>).error).toContain('not found')
    })
  })
})
