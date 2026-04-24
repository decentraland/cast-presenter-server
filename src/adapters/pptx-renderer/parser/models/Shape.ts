import type { Geometry } from './Geometry'
import type { Fill, Shadow, Stroke, TextParagraph } from './types'

export type ShapeType = 'rectangle' | 'roundRect' | 'ellipse' | 'picture' | 'text' | 'group' | 'line' | 'unknown'

export interface ShapeOptions {
  type: ShapeType
  geometry: Geometry
  fill?: Fill
  stroke?: Stroke
  shadow?: Shadow
  text?: string
  paragraphs?: TextParagraph[]
  mediaRef?: string
  mediaType?: 'image' | 'video'
  /** External URL for linked videos (e.g. Google Drive). No file is embedded in the PPTX. */
  externalUrl?: string
  name?: string
  textInsets?: { left: number; right: number; top: number; bottom: number }
  textAnchor?: 'top' | 'middle' | 'bottom'
  clipShape?: string
  /** Adjust values from a:avLst keyed by guide name (e.g. { adj: 16667 } for roundRect radius). */
  clipAdjustValues?: Record<string, number>
}

export class Shape {
  public readonly type: ShapeType
  public readonly geometry: Geometry
  public readonly fill?: Fill
  public readonly stroke?: Stroke
  public readonly shadow?: Shadow
  public readonly text?: string
  public readonly paragraphs?: TextParagraph[]
  public readonly mediaRef?: string
  public readonly mediaType?: 'image' | 'video'
  public readonly externalUrl?: string
  public readonly name?: string
  public readonly textInsets?: { left: number; right: number; top: number; bottom: number }
  public readonly textAnchor?: 'top' | 'middle' | 'bottom'
  public readonly clipShape?: string
  public readonly clipAdjustValues?: Record<string, number>

  constructor(options: ShapeOptions) {
    this.type = options.type
    this.geometry = options.geometry
    this.fill = options.fill
    this.stroke = options.stroke
    this.shadow = options.shadow
    this.text = options.text
    this.paragraphs = options.paragraphs
    this.mediaRef = options.mediaRef
    this.mediaType = options.mediaType
    this.externalUrl = options.externalUrl
    this.name = options.name
    this.textInsets = options.textInsets
    this.textAnchor = options.textAnchor
    this.clipShape = options.clipShape
    this.clipAdjustValues = options.clipAdjustValues
  }

  isVideo(): boolean {
    return this.mediaType === 'video'
  }

  isImage(): boolean {
    return this.mediaType === 'image'
  }

  hasText(): boolean {
    return !!this.text || (this.paragraphs !== undefined && this.paragraphs.length > 0)
  }
}
