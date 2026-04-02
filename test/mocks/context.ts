import type { ILoggerComponent } from '@well-known-components/interfaces'
import type { PresentationState } from '../../src/adapters/presentation-manager'

export function createMockLogger(): ILoggerComponent {
  return {
    getLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      log: jest.fn()
    })
  }
}

export function createMockPresentationState(): PresentationState {
  return {
    id: 'test-id',
    fileName: 'Test',
    slideCount: 5,
    currentSlide: 1,
    fileType: 'pdf',
    slideVideos: [],
    videoState: 'idle'
  }
}
