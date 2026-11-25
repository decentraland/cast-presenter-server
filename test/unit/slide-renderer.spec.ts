import { type ChildProcess, fork } from 'child_process'
import { once } from 'events'
import { existsSync, readFileSync } from 'fs'
import * as path from 'path'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { SlideRenderError } from '../../src/adapters/renderer/errors'
import { createSlideRendererComponent } from '../../src/adapters/slide-renderer'
import { buildPptx, ellipseSlide, embeddedVideoSlide } from '../helpers/build-pptx'
import { createLoggerMock } from '../mocks/context'
import type { SlideVideoInfo } from '../../src/adapters/renderer/types'
import type { ISlideRenderer } from '../../src/adapters/slide-renderer/types'
import type { FileType } from '../../src/logic/file-validator'
import type { SlideImage } from '../../src/logic/slide-image'

jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process')
  return { ...actual, fork: jest.fn(actual.fork) }
})

jest.setTimeout(60_000)

const SCRIPTED_WORKER = path.join(__dirname, '../fixtures/slide-renderer/aborting-worker.ts')
const PDF_FIXTURE = path.join(__dirname, '../fixtures/pdf/ccitt-black.pdf')
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

let logger: jest.Mocked<ILoggerComponent.ILogger>

beforeEach(() => {
  logger = createLoggerMock()
})

afterEach(() => {
  jest.mocked(fork).mockClear()
})

interface RenderProcess {
  renderer: ISlideRenderer
  child: ChildProcess
  closed: Promise<unknown>
}

function startRenderer(fileType: FileType, workerPath?: string): RenderProcess {
  const renderer = createSlideRendererComponent({ logs: { getLogger: () => logger } }, { workerPath }).createRenderer(
    fileType
  )
  const child: ChildProcess = jest.mocked(fork).mock.results[0].value
  return { renderer, child, closed: once(child, 'close') }
}

function isPng(image: SlideImage): boolean {
  return image.png.subarray(0, 8).equals(PNG_SIGNATURE)
}

describe('when a deck finishes rendering through the render process', () => {
  let renderProcess: RenderProcess
  let images: SlideImage[]
  let videos: SlideVideoInfo[]
  let embeddedMediaDir: string | null

  beforeEach(async () => {
    renderProcess = startRenderer('pptx')
    const { renderer } = renderProcess
    await renderer.initialize(
      await buildPptx([ellipseSlide('0'), embeddedVideoSlide('clip.mp4')], { 'ppt/media/clip.mp4': 'video-bytes' })
    )
    await renderProcess.closed
    images = [await renderer.renderSlide(0), await renderer.renderSlide(1)]
    videos = await renderer.getSlideVideos(1)
    embeddedMediaDir = renderer.getEmbeddedMediaDir()
  })

  afterEach(() => {
    renderProcess.renderer.destroy()
  })

  it('should end the render process with a clean exit', () => {
    expect(renderProcess.child.exitCode).toBe(0)
  })

  it('should not warn about the render process exit', () => {
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('should keep serving every slide as a PNG', () => {
    expect(images.map(isPng)).toEqual([true, true])
  })

  it('should keep reporting the embedded video extracted into the embedded media directory', () => {
    expect(videos.map((video) => path.dirname(video.url))).toEqual([embeddedMediaDir])
  })

  it('should keep the extracted embedded media on disk', () => {
    expect(existsSync(String(embeddedMediaDir))).toBe(true)
  })

  describe('and the renderer is destroyed', () => {
    beforeEach(() => {
      renderProcess.renderer.destroy()
    })

    it('should remove the extracted embedded media', () => {
      expect(existsSync(String(embeddedMediaDir))).toBe(false)
    })
  })
})

describe('when the render process aborts after reporting the first slide', () => {
  let renderProcess: RenderProcess
  let firstImage: SlideImage
  let secondError: unknown

  beforeEach(async () => {
    renderProcess = startRenderer('pptx', SCRIPTED_WORKER)
    const { renderer } = renderProcess
    await renderer.initialize(Buffer.from('abort-after-first'))
    firstImage = await renderer.renderSlide(0)
    secondError = await renderer.renderSlide(1).catch((error: unknown) => error)
    await renderProcess.closed
  })

  afterEach(() => {
    renderProcess.renderer.destroy()
  })

  it('should serve the first slide from its written PNG', () => {
    expect(firstImage.png.toString()).toBe('png-0')
  })

  it('should reject the unreported slide with a SlideRenderError', () => {
    expect(secondError).toBeInstanceOf(SlideRenderError)
  })

  it('should warn once with the exit signal and the number of unrendered slides', () => {
    expect(logger.warn.mock.calls).toEqual([[expect.any(String), { exit: 'SIGABRT', unrenderedSlides: 1 }]])
  })

  describe('and the unreported slide videos are requested afterwards', () => {
    let videosError: unknown

    beforeEach(async () => {
      videosError = await renderProcess.renderer.getSlideVideos(1).catch((error: unknown) => error)
    })

    it('should reject them with a SlideRenderError', () => {
      expect(videosError).toBeInstanceOf(SlideRenderError)
    })
  })

  describe('and the unreported slide is requested again', () => {
    let retryError: unknown

    beforeEach(async () => {
      retryError = await renderProcess.renderer.renderSlide(1).catch((error: unknown) => error)
    })

    it('should reject it with a SlideRenderError', () => {
      expect(retryError).toBeInstanceOf(SlideRenderError)
    })
  })
})

describe('when the first slide fails to render', () => {
  let renderProcess: RenderProcess
  let firstError: unknown
  let secondImage: SlideImage

  beforeEach(async () => {
    renderProcess = startRenderer('pptx', SCRIPTED_WORKER)
    const { renderer } = renderProcess
    await renderer.initialize(Buffer.from('fail-first'))
    firstError = await renderer.renderSlide(0).catch((error: unknown) => error)
    secondImage = await renderer.renderSlide(1)
    await renderProcess.closed
  })

  afterEach(() => {
    renderProcess.renderer.destroy()
  })

  it('should reject the failed slide with a SlideRenderError', () => {
    expect(firstError).toBeInstanceOf(SlideRenderError)
  })

  it('should still render the following slide', () => {
    expect(secondImage.png.toString()).toBe('png-1')
  })

  it('should not warn about the render process exit', () => {
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('when the renderer is destroyed while the deck is rendering', () => {
  let renderProcess: RenderProcess
  let embeddedMediaDir: string | null

  beforeEach(async () => {
    renderProcess = startRenderer('pptx', SCRIPTED_WORKER)
    const { renderer } = renderProcess
    await renderer.initialize(Buffer.from('extract-then-hang'))
    await renderer.getSlideVideos(0)
    embeddedMediaDir = renderer.getEmbeddedMediaDir()
    renderer.destroy()
    await renderProcess.closed
  })

  it('should have extracted embedded media before being destroyed', () => {
    expect(embeddedMediaDir).not.toBeNull()
  })

  it('should kill the render process', () => {
    expect(renderProcess.child.signalCode).toBe('SIGKILL')
  })

  it('should remove the embedded media the process extracted', () => {
    expect(existsSync(String(embeddedMediaDir))).toBe(false)
  })

  it('should not warn about the render process exit', () => {
    expect(logger.warn).not.toHaveBeenCalled()
  })
})

describe('when rendering a PDF through the render process', () => {
  let renderProcess: RenderProcess
  let image: SlideImage

  beforeEach(async () => {
    renderProcess = startRenderer('pdf')
    await renderProcess.renderer.initialize(readFileSync(PDF_FIXTURE))
    image = await renderProcess.renderer.renderSlide(0)
  })

  afterEach(() => {
    renderProcess.renderer.destroy()
  })

  it('should report the document page count as the slide count', () => {
    expect(renderProcess.renderer.getSlideCount()).toBe(1)
  })

  it('should return the slide as a PNG buffer', () => {
    expect(Buffer.isBuffer(image.png) && isPng(image)).toBe(true)
  })
})

describe('when rendering a PPTX through the render process', () => {
  let renderProcess: RenderProcess

  beforeEach(() => {
    renderProcess = startRenderer('pptx')
  })

  afterEach(() => {
    renderProcess.renderer.destroy()
  })

  describe('and the deck holds an ordinary ellipse', () => {
    let image: SlideImage

    beforeEach(async () => {
      await renderProcess.renderer.initialize(await buildPptx([ellipseSlide('0')]))
      image = await renderProcess.renderer.renderSlide(0)
    })

    it('should report one slide', () => {
      expect(renderProcess.renderer.getSlideCount()).toBe(1)
    })

    it('should return the slide as a 1920x1080 PNG', () => {
      expect({ png: isPng(image), width: image.width, height: image.height }).toEqual({
        png: true,
        width: 1920,
        height: 1080
      })
    })

    describe('and a slide outside the deck is requested', () => {
      let outOfRangeError: unknown

      beforeEach(async () => {
        outOfRangeError = await renderProcess.renderer.renderSlide(5).catch((error: unknown) => error)
      })

      it('should reject it with a SlideRenderError', () => {
        expect(outOfRangeError).toBeInstanceOf(SlideRenderError)
      })
    })

    describe('and its slide videos are requested', () => {
      let videos: SlideVideoInfo[]

      beforeEach(async () => {
        videos = await renderProcess.renderer.getSlideVideos(0)
      })

      it('should report no videos and no embedded media directory', () => {
        expect({ videos, dir: renderProcess.renderer.getEmbeddedMediaDir() }).toEqual({ videos: [], dir: null })
      })
    })
  })

  describe('and the deck holds an ellipse with an infinite offset', () => {
    let image: SlideImage

    beforeEach(async () => {
      await renderProcess.renderer.initialize(await buildPptx([ellipseSlide('1e400')]))
      image = await renderProcess.renderer.renderSlide(0)
    })

    it('should render the slide as a PNG', () => {
      expect(isPng(image)).toBe(true)
    })
  })
})
