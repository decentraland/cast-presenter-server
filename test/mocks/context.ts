import type { ILoggerComponent } from '@well-known-components/interfaces'
import type { PresentationState } from '../../src/logic/presentation-manager'

export function createLoggerMock(): jest.Mocked<ILoggerComponent.ILogger> {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() }
}

export function createMockLogger(): ILoggerComponent {
  return { getLogger: () => createLoggerMock() }
}

export function createMockPresentationState(): PresentationState {
  return {
    id: 'test-id',
    fileName: 'Test',
    slideCount: 5,
    currentSlide: 1,
    fileType: 'pdf',
    slideVideos: [],
    videoState: 'idle',
    overlay: { x: 0, y: 1, size: 'small' }
  }
}
