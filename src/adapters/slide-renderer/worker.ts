import { writeFile } from 'fs/promises'
import path from 'path'
import { errorMessage } from '../../logic/error-message'
import { encodeSlidePng } from '../../logic/slide-image'
import { createPdfRendererComponent } from '../pdf-renderer'
import { createPptxRendererComponent } from '../pptx-renderer'
import { SlideRenderError } from '../renderer/errors'
import type { FileType } from '../../logic/file-validator'
import type { IRenderer, IRendererComponent, SlideVideoInfo } from '../renderer/types'

/** The single request the server sends its render process. */
export interface WorkerRequest {
  fileType: FileType
  buffer: Uint8Array
  outputDir: string
}

/** A slide written to `<outputDir>/<index>.png`. */
export interface RenderedSlide {
  type: 'slide'
  index: number
  hash: string
  width: number
  height: number
  videos: SlideVideoInfo[]
  embeddedMediaDir: string | null
}

/** Messages the render process streams back: the slide count, then one message per slide in order. */
export type WorkerMessage =
  | { type: 'deck'; slideCount: number }
  | { type: 'deckFailed'; error: string }
  | RenderedSlide
  | { type: 'slideFailed'; index: number; error: string }

const RENDERER_FACTORIES: Record<FileType, () => IRendererComponent> = {
  pdf: createPdfRendererComponent,
  pptx: createPptxRendererComponent
}

function send(message: WorkerMessage): Promise<void> {
  return new Promise((resolve, reject) =>
    process.send?.(message, undefined, undefined, (error: Error | null) => (error ? reject(error) : resolve()))
  )
}

async function renderSlide(renderer: IRenderer, index: number, outputDir: string): Promise<RenderedSlide> {
  const { buffer, width, height } = await renderer.renderSlide(index)
  const { png, hash } = await encodeSlidePng(buffer, width, height)
  await writeFile(path.join(outputDir, `${index}.png`), png)
  const videos = await renderer.getSlideVideos(index)
  return { type: 'slide', index, hash, width, height, videos, embeddedMediaDir: renderer.getEmbeddedMediaDir() }
}

async function renderDeck({ fileType, buffer, outputDir }: WorkerRequest): Promise<void> {
  const renderer = RENDERER_FACTORIES[fileType]().createRenderer()
  await renderer.initialize(Buffer.from(buffer))
  const slideCount = renderer.getSlideCount()
  await send({ type: 'deck', slideCount })
  for (let index = 0; index < slideCount; index++) {
    await send(
      await renderSlide(renderer, index, outputDir).catch(
        (error: unknown): WorkerMessage => ({
          type: 'slideFailed',
          index,
          error: errorMessage(error instanceof SlideRenderError ? error.cause : error)
        })
      )
    )
  }
}

process.once('message', (request: WorkerRequest) => {
  renderDeck(request)
    .catch((error: unknown) => send({ type: 'deckFailed', error: errorMessage(error) }))
    .finally(() => process.exit())
})
