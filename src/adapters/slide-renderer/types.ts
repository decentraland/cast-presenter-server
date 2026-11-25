import type { IBaseComponent } from '@well-known-components/interfaces'
import type { FileType } from '../../logic/file-validator'
import type { SlideImage } from '../../logic/slide-image'
import type { SlideVideoInfo } from '../renderer/types'

/** A renderer bound to a single loaded document, whose slides a short-lived child process writes to disk. */
export interface ISlideRenderer {
  initialize(fileBuffer: Buffer): Promise<void>
  /** @throws {SlideRenderError} When the slide image failed, or the render process exited before reporting the slide. */
  renderSlide(index: number): Promise<SlideImage>
  getSlideVideos(index: number): Promise<SlideVideoInfo[]>
  /** @returns the directory embedded media was extracted into, or null when none was extracted. */
  getEmbeddedMediaDir(): string | null
  getSlideCount(): number
  destroy(): void
}

/** Factory component for creating per-session slide renderers. */
export interface ISlideRendererComponent extends IBaseComponent {
  /**
   * Creates a renderer backed by a new child process.
   *
   * @param fileType - Format of the document the renderer will load
   * @returns An uninitialized ISlideRenderer (call initialize() before use)
   */
  createRenderer(fileType: FileType): ISlideRenderer
}
