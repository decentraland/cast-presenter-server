import type { SlideVideoInfo } from '../video-compositor/types'

export interface RenderResult {
  buffer: Buffer
  width: number
  height: number
}

export interface IPdfRenderer {
  initialize(fileBuffer: Buffer): Promise<void>
  renderSlide(index: number): Promise<RenderResult>
  getSlideVideos(index: number): Promise<SlideVideoInfo[]>
  getSlideCount(): number
  destroy(): void
}

export interface IPdfRendererComponent {
  createRenderer(): IPdfRenderer
}
