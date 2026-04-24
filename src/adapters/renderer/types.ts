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
 * Format-agnostic contract implemented by every renderer adapter (PDF via
 * pdfjs-dist + @napi-rs/canvas; PPTX via the vendored OOXML parser +
 * @napi-rs/canvas). Lives under `adapters/renderer/` rather than any single
 * format's directory so no adapter depends on a peer adapter's types.
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
