import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import { SlideRenderError } from '../../src/adapters/renderer/errors'
import { createSlideRendererComponent } from '../../src/adapters/slide-renderer'
import { buildPptx, ellipseShapeXml } from '../helpers/build-pptx'
import type { SlideVideoInfo } from '../../src/adapters/renderer/types'
import type { ISlideRenderer } from '../../src/adapters/slide-renderer/types'
import type { SlideImage } from '../../src/logic/slide-image'

jest.setTimeout(60_000)

const ABORTING_WORKER = path.join(__dirname, '../fixtures/slide-renderer/aborting-worker.ts')
const PDF_FIXTURE = path.join(__dirname, '../fixtures/pdf/ccitt-black.pdf')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('when the render process aborts while rendering a slide', () => {
  let renderer: ISlideRenderer
  let embeddedMediaDir: string | null
  let renderError: unknown

  beforeEach(async () => {
    renderer = createSlideRendererComponent({ workerPath: ABORTING_WORKER }).createRenderer('pptx')
    await renderer.initialize(Buffer.from('deck'))
    await renderer.getSlideVideos(0)
    embeddedMediaDir = renderer.getEmbeddedMediaDir()
    renderError = await renderer.renderSlide(0).catch((error: unknown) => error)
  })

  afterEach(() => {
    renderer.destroy()
  })

  it('should reject the render with a SlideRenderError', () => {
    expect(renderError).toBeInstanceOf(SlideRenderError)
  })

  it('should keep the slide count reported before the crash', () => {
    expect(renderer.getSlideCount()).toBe(2)
  })

  it('should keep the embedded media directory reported before the crash', () => {
    expect(embeddedMediaDir).not.toBeNull()
  })

  describe('and another slide is requested afterwards', () => {
    let secondError: unknown

    beforeEach(async () => {
      secondError = await renderer.renderSlide(1).catch((error: unknown) => error)
    })

    it('should reject it with a SlideRenderError', () => {
      expect(secondError).toBeInstanceOf(SlideRenderError)
    })
  })

  describe('and the slide videos are requested afterwards', () => {
    let videosError: unknown

    beforeEach(async () => {
      videosError = await renderer.getSlideVideos(1).catch((error: unknown) => error)
    })

    it('should reject them with a SlideRenderError', () => {
      expect(videosError).toBeInstanceOf(SlideRenderError)
    })
  })

  describe('and the renderer is destroyed', () => {
    beforeEach(() => {
      renderer.destroy()
    })

    it('should remove the embedded media directory the process left behind', () => {
      expect(existsSync(String(embeddedMediaDir))).toBe(false)
    })
  })
})

describe('when rendering a PDF through the render process', () => {
  let renderer: ISlideRenderer
  let image: SlideImage

  beforeEach(async () => {
    renderer = createSlideRendererComponent().createRenderer('pdf')
    await renderer.initialize(readFileSync(PDF_FIXTURE))
    image = await renderer.renderSlide(0)
  })

  afterEach(() => {
    renderer.destroy()
  })

  it('should report the document page count as the slide count', () => {
    expect(renderer.getSlideCount()).toBe(1)
  })

  it('should return the slide as a PNG buffer', () => {
    expect(Buffer.isBuffer(image.png) && image.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
  })
})

describe('when rendering a PPTX through the render process', () => {
  let renderer: ISlideRenderer
  let deck: Buffer

  beforeEach(() => {
    renderer = createSlideRendererComponent().createRenderer('pptx')
  })

  afterEach(() => {
    renderer.destroy()
  })

  describe('and the deck holds an ordinary ellipse', () => {
    let image: SlideImage

    beforeEach(async () => {
      deck = await buildPptx(ellipseShapeXml('0'))
      await renderer.initialize(deck)
      image = await renderer.renderSlide(0)
    })

    it('should report one slide', () => {
      expect(renderer.getSlideCount()).toBe(1)
    })

    it('should return the slide as a 1920x1080 PNG', () => {
      expect({
        signature: image.png.subarray(0, 8),
        width: image.width,
        height: image.height
      }).toEqual({ signature: PNG_SIGNATURE, width: 1920, height: 1080 })
    })

    describe('and a slide outside the deck is requested', () => {
      let outOfRangeError: unknown
      let nextImage: SlideImage

      beforeEach(async () => {
        outOfRangeError = await renderer.renderSlide(5).catch((error: unknown) => error)
        nextImage = await renderer.renderSlide(0)
      })

      it('should reject it with a SlideRenderError', () => {
        expect(outOfRangeError).toBeInstanceOf(SlideRenderError)
      })

      it('should keep rendering valid slides afterwards', () => {
        expect(nextImage.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
      })
    })

    describe('and the renderer is destroyed before another slide is requested', () => {
      let afterDestroyError: unknown

      beforeEach(async () => {
        renderer.destroy()
        afterDestroyError = await renderer.renderSlide(0).catch((error: unknown) => error)
      })

      it('should reject the request with a SlideRenderError once the process has exited', () => {
        expect(afterDestroyError).toBeInstanceOf(SlideRenderError)
      })
    })

    describe('and its slide videos are requested', () => {
      let videos: SlideVideoInfo[]

      beforeEach(async () => {
        videos = await renderer.getSlideVideos(0)
      })

      it('should report no videos and no embedded media directory', () => {
        expect({ videos, dir: renderer.getEmbeddedMediaDir() }).toEqual({ videos: [], dir: null })
      })
    })
  })

  describe('and the deck holds an ellipse with an infinite offset', () => {
    let image: SlideImage

    beforeEach(async () => {
      deck = await buildPptx(ellipseShapeXml('1e400'))
      await renderer.initialize(deck)
      image = await renderer.renderSlide(0)
    })

    it('should render the slide as a PNG', () => {
      expect(image.png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    })
  })
})
