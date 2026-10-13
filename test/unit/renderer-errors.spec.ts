import { createCanvas } from '@napi-rs/canvas'
import { createPdfRendererComponent } from '../../src/adapters/pdf-renderer'
import { SlideRenderError } from '../../src/adapters/renderer'

jest.mock('@napi-rs/canvas', () => ({ createCanvas: jest.fn() }))

// pdfjs-dist ships as ESM (uses import.meta), which jest cannot load; a one-page stub is enough here.
jest.mock(
  'pdfjs-dist/legacy/build/pdf.mjs',
  () => ({
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        destroy: async () => undefined,
        getPage: async () => ({
          getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 1e9 * scale })
        })
      })
    })
  }),
  { virtual: true }
)

describe('when rendering a slide and the native canvas cannot create a surface', () => {
  let renderer: ReturnType<ReturnType<typeof createPdfRendererComponent>['createRenderer']>

  beforeEach(async () => {
    ;(createCanvas as jest.Mock).mockImplementation(() => {
      throw new Error('Create skia surface failed')
    })
    renderer = createPdfRendererComponent().createRenderer()
    await renderer.initialize(Buffer.from('%PDF-1.4'))
  })

  afterEach(() => {
    renderer.destroy()
  })

  it('should reject with a SlideRenderError carrying the original cause', async () => {
    const error = await renderer.renderSlide(0).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SlideRenderError)
    expect((error as SlideRenderError).cause).toEqual(new Error('Create skia surface failed'))
  })
})
