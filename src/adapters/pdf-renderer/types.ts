import type { IBaseComponent } from '@well-known-components/interfaces'
import type { SlideVideoInfo } from '../video-compositor/types'

/** RGBA frame buffer with dimensions. */
export interface RenderResult {
  buffer: Buffer
  width: number
  height: number
}

/**
 * A presentation renderer instance bound to a single loaded document.
 *
 * Renders slides to RGBA buffers and extracts video annotations. Implementations
 * exist for PDF (pdfjs-dist + @napi-rs/canvas) and PPTX (vendored OOXML parser +
 * @napi-rs/canvas).
 */
export interface IRenderer {
  initialize(fileBuffer: Buffer): Promise<void>
  renderSlide(index: number): Promise<RenderResult>
  getSlideVideos(index: number): Promise<SlideVideoInfo[]>
  getSlideCount(): number
  destroy(): void
}

/**
 * Factory component for creating per-session renderers.
 */
export interface IRendererComponent extends IBaseComponent {
  /**
   * Creates a new renderer instance.
   *
   * @returns An uninitialized IRenderer (call initialize() before use)
   */
  createRenderer(): IRenderer
}
