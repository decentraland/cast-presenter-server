import type { ILoggerComponent } from '@well-known-components/interfaces'

export function createMockLogger(): ILoggerComponent {
  return {
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
  }
}

export function createMockPresentationState(): {
  id: string
  fileName: string
  slideCount: number
  currentSlide: number
  fileType: 'pdf'
  slideVideos: never[]
  videoState: 'idle'
} {
  return {
    id: 'test-id',
    fileName: 'Test',
    slideCount: 5,
    currentSlide: 1,
    fileType: 'pdf' as const,
    slideVideos: [],
    videoState: 'idle' as const
  }
}
