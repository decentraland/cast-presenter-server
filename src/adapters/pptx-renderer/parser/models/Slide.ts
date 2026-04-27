import type { Shape } from './Shape'
import type { Background } from './types'

export interface SlideOptions {
  id: string
  index?: number
  shapes: Shape[]
  background?: Background
  notes?: string
  width?: number
  height?: number
}

export class Slide {
  public readonly id: string
  public index: number
  public readonly shapes: Shape[]
  public readonly background?: Background
  public readonly notes?: string
  public readonly width: number
  public readonly height: number

  constructor(options: SlideOptions) {
    this.id = options.id
    this.index = options.index ?? 0
    this.shapes = options.shapes
    this.background = options.background
    this.notes = options.notes
    // Default PowerPoint slide dimensions in pixels (960x540 = 16:9)
    this.width = options.width ?? 960
    this.height = options.height ?? 540
  }

  getVideos(): Shape[] {
    return this.shapes.filter((s) => s.mediaType === 'video')
  }

  getImages(): Shape[] {
    return this.shapes.filter((s) => s.mediaType === 'image')
  }

  getTextShapes(): Shape[] {
    return this.shapes.filter((s) => s.hasText())
  }

  /**
   * All media paths this slide needs for rendering (images, background image, embedded videos).
   * Used for preloading; external video URLs are not included.
   */
  getMediaPaths(): string[] {
    const paths: string[] = []
    if (this.background?.imageRef) {
      paths.push(this.background.imageRef)
    }
    for (const shape of this.getImages()) {
      if (shape.mediaRef) paths.push(shape.mediaRef)
    }
    for (const shape of this.getVideos()) {
      if (shape.mediaRef) paths.push(shape.mediaRef)
    }
    return [...new Set(paths)]
  }
}
