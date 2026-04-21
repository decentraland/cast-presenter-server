import type { IBaseComponent } from '@well-known-components/interfaces'
import type { SlideVideoInfo } from '../video-compositor/types'

/** RGBA frame buffer with dimensions. */
export interface RenderResult {
  buffer: Buffer
  width: number
  height: number
}

/**
 * A PDF renderer instance bound to a single loaded document.
 *
 * Renders slides to RGBA buffers and extracts video annotations.
 */
export interface IPdfRenderer {
  initialize(fileBuffer: Buffer): Promise<void>
  renderSlide(index: number): Promise<RenderResult>
  getSlideVideos(index: number): Promise<SlideVideoInfo[]>
  getSlideCount(): number
  destroy(): void
}

/**
 * Factory component for creating per-session PDF renderers.
 */
export interface IPdfRendererComponent extends IBaseComponent {
  /**
   * Creates a new renderer instance.
   *
   * @returns An uninitialized IPdfRenderer (call initialize() before use)
   */
  createRenderer(): IPdfRenderer
}
