import { writeFile } from 'fs/promises'
import path from 'path'
import { errorMessage } from '../../logic/error-message'
import { encodeSlidePng } from '../../logic/slide-image'
import { createPdfRendererComponent } from '../pdf-renderer'
import { createPptxRendererComponent } from '../pptx-renderer'
import { SlideRenderError } from '../renderer/errors'
import type { FileType } from '../../logic/file-validator'
import type { IRendererComponent, SlideVideoInfo } from '../renderer/types'

/** Largest deck the render process accepts. */
export const MAX_SLIDES = 500

/** Total PNG bytes one deck may write. */
export const MAX_DECK_PNG_BYTES = 2 * 1024 * 1024 * 1024

/** The single request the server sends its render process. */
export interface WorkerRequest {
  fileType: FileType
  buffer: Uint8Array
  outputDir: string
}

interface Failure {
  error: string
}

/** Image written to `<outputDir>/<index>.png`. */
export interface SlideImageInfo {
  hash: string
  width: number
  height: number
  bytes: number
}

/** The outcome of one slide; its image and its videos succeed or fail independently. */
export interface SlideReport {
  type: 'slide'
  index: number
  image: SlideImageInfo | Failure
  videos: SlideVideoInfo[] | Failure
  embeddedMediaDir: string | null
}

/**
 * Messages the render process streams back: the slide count, then one report per slide in order,
 * preceded once by `imageBudgetExceeded` at the first slide whose image did not fit the deck budget.
 */
export type WorkerMessage =
  | { type: 'deck'; slideCount: number }
  | { type: 'deckFailed'; error: string }
  | { type: 'tooManySlides'; slideCount: number; maxSlides: number }
  | { type: 'imageBudgetExceeded'; index: number }
  | SlideReport

const RENDERER_FACTORIES: Record<FileType, () => IRendererComponent> = {
  pdf: createPdfRendererComponent,
  pptx: createPptxRendererComponent
}

function failure(error: unknown): Failure {
  return { error: errorMessage(error instanceof SlideRenderError ? error.cause : error) }
}

/**
 * Loads a deck and writes its slides as PNGs, reporting each step through `send`.
 *
 * @param request - The document and the directory to write PNGs into
 * @param send - Delivers one message to the server
 * @param maxPngBytes - PNG bytes the deck may write before the remaining slide images fail
 * @throws When `send` fails after the slide count was reported
 */
export async function renderDeck(
  { fileType, buffer, outputDir }: WorkerRequest,
  send: (message: WorkerMessage) => Promise<void>,
  maxPngBytes = MAX_DECK_PNG_BYTES
): Promise<void> {
  const renderer = RENDERER_FACTORIES[fileType]().createRenderer()
  let slideCount: number
  try {
    await renderer.initialize(Buffer.from(buffer))
    slideCount = renderer.getSlideCount()
  } catch (error) {
    return send({ type: 'deckFailed', error: errorMessage(error) })
  }
  if (slideCount > MAX_SLIDES) return send({ type: 'tooManySlides', slideCount, maxSlides: MAX_SLIDES })
  await send({ type: 'deck', slideCount })

  const overBudget = new Error(`Deck exceeded its image budget of ${maxPngBytes} bytes`)
  let pngBytes = 0
  let firstSlideOverBudget: number | null = null

  async function writeImage(index: number): Promise<SlideImageInfo> {
    if (firstSlideOverBudget !== null) throw overBudget
    const { buffer: rgba, width, height } = await renderer.renderSlide(index)
    const { png, hash } = await encodeSlidePng(rgba, width, height)
    if (pngBytes + png.length > maxPngBytes) {
      firstSlideOverBudget = index
      throw overBudget
    }
    pngBytes += png.length
    await writeFile(path.join(outputDir, `${index}.png`), png)
    return { hash, width, height, bytes: png.length }
  }

  for (let index = 0; index < slideCount; index++) {
    const image = await writeImage(index).catch(failure)
    if (firstSlideOverBudget === index) await send({ type: 'imageBudgetExceeded', index })
    const videos = await renderer.getSlideVideos(index).catch(failure)
    await send({ type: 'slide', index, image, videos, embeddedMediaDir: renderer.getEmbeddedMediaDir() })
  }
}

function sendToServer(message: WorkerMessage): Promise<void> {
  return new Promise((resolve, reject) =>
    process.send?.(message, undefined, undefined, (error: Error | null) => (error ? reject(error) : resolve()))
  )
}

if (require.main === module) {
  process.once('message', (request: WorkerRequest) => {
    renderDeck(request, sendToServer)
      .catch((error: unknown) => process.stderr.write(`Slide render process failed: ${errorMessage(error)}\n`))
      .finally(() => process.exit())
  })
}
