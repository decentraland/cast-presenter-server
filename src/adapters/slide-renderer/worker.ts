import { errorMessage } from '../../logic/error-message'
import { type SlideImage, encodeSlidePng } from '../../logic/slide-image'
import { createPdfRendererComponent } from '../pdf-renderer'
import { createPptxRendererComponent } from '../pptx-renderer'
import { SlideRenderError } from '../renderer/errors'
import type { FileType } from '../../logic/file-validator'
import type { IRenderer, IRendererComponent, SlideVideoInfo } from '../renderer/types'

/** Reply payload for each request operation. */
export interface WorkerResults {
  initialize: { slideCount: number }
  renderSlide: SlideImage
  getSlideVideos: { videos: SlideVideoInfo[]; embeddedMediaDir: string | null }
}

/** A request from the server to its render process. */
export type WorkerRequest =
  | { id: number; op: 'initialize'; fileType: FileType; buffer: Uint8Array }
  | { id: number; op: 'renderSlide' | 'getSlideVideos'; index: number }
  | { op: 'destroy' }

/** The render process's reply to the request with the same `id`. */
export type WorkerResponse = { id: number; result: WorkerResults[keyof WorkerResults] } | { id: number; error: string }

const RENDERER_FACTORIES: Record<FileType, () => IRendererComponent> = {
  pdf: createPdfRendererComponent,
  pptx: createPptxRendererComponent
}

let renderer: IRenderer | null = null

function loadedRenderer(): IRenderer {
  if (!renderer) throw new Error('Renderer not initialized')
  return renderer
}

async function handle(request: Exclude<WorkerRequest, { op: 'destroy' }>): Promise<WorkerResults[keyof WorkerResults]> {
  switch (request.op) {
    case 'initialize':
      renderer = RENDERER_FACTORIES[request.fileType]().createRenderer()
      await renderer.initialize(Buffer.from(request.buffer))
      return { slideCount: renderer.getSlideCount() }
    case 'renderSlide': {
      const { buffer, width, height } = await loadedRenderer().renderSlide(request.index)
      return encodeSlidePng(buffer, width, height)
    }
    case 'getSlideVideos': {
      const videos = await loadedRenderer().getSlideVideos(request.index)
      return { videos, embeddedMediaDir: loadedRenderer().getEmbeddedMediaDir() }
    }
  }
}

process.on('message', (request: WorkerRequest) => {
  if (request.op === 'destroy') {
    renderer?.destroy()
    process.exit()
  }
  handle(request).then(
    (result) => process.send?.({ id: request.id, result }),
    (error: unknown) =>
      process.send?.({ id: request.id, error: errorMessage(error instanceof SlideRenderError ? error.cause : error) })
  )
})
