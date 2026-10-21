import { createPdfRendererComponent } from '../../src/adapters/pdf-renderer'
import { SlideRenderError } from '../../src/adapters/renderer'

const getDocument = jest.fn()

jest.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: (...args: unknown[]) => getDocument(...args) }), {
  virtual: true
})

describe('when a PDF is loaded', () => {
  let renderer: ReturnType<ReturnType<typeof createPdfRendererComponent>['createRenderer']>
  let destroyLoadingTask: jest.Mock

  beforeEach(async () => {
    destroyLoadingTask = jest.fn()
    getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 1,
        loadingTask: { destroy: destroyLoadingTask },
        getPage: async () => ({ getViewport: () => ({ width: 0, height: 0 }) })
      })
    })
    renderer = createPdfRendererComponent().createRenderer()
    await renderer.initialize(Buffer.from('%PDF-1.4'))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it('should cap the decoded size of embedded images', () => {
    expect(getDocument).toHaveBeenCalledWith(expect.objectContaining({ maxImageSize: expect.any(Number) }))
  })

  describe('and a page has no size', () => {
    let error: unknown

    beforeEach(async () => {
      error = await renderer.renderSlide(0).catch((e: unknown) => e)
    })

    it('should reject with a SlideRenderError', () => {
      expect(error).toBeInstanceOf(SlideRenderError)
    })
  })

  describe('and destroying the document fails', () => {
    let unhandled: jest.Mock

    beforeEach(async () => {
      unhandled = jest.fn()
      process.on('unhandledRejection', unhandled)
      destroyLoadingTask.mockRejectedValue(new Error('worker gone'))
      renderer.destroy()
      await new Promise((resolve) => setImmediate(resolve))
    })

    afterEach(() => {
      process.off('unhandledRejection', unhandled)
    })

    it('should not leave an unhandled rejection', () => {
      expect(unhandled).not.toHaveBeenCalled()
    })
  })
})
