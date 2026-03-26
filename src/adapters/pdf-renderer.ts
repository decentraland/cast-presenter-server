import { createCanvas } from '@napi-rs/canvas'
import type { SlideVideoInfo } from '../logic/types'

// pdfjs-dist types
interface PDFDocumentProxy {
  numPages: number
  getPage(pageNumber: number): Promise<PDFPageProxy>
  destroy(): void
}

interface PDFPageProxy {
  getViewport(params: { scale: number }): { width: number; height: number }
  render(params: { canvasContext: any; viewport: any }): { promise: Promise<void> }
  getAnnotations(): Promise<PDFAnnotation[]>
}

interface PDFAnnotation {
  subtype: string
  url?: string
  rect?: number[]
}

const TARGET_WIDTH = 1280

const VIDEO_URL_PATTERN = /youtube\.com|youtu\.be|drive\.google\.com|docs\.google\.com\/file|vimeo\.com/
const MEDIA_URL_PATTERN = /\.gif($|\?)|\.mp4($|\?)|\.webm($|\?)/i

function isMediaUrl(url: string): boolean {
  return VIDEO_URL_PATTERN.test(url) || MEDIA_URL_PATTERN.test(url)
}

function pdfRectToCanvas(
  rect: number[],
  viewport: { width: number; height: number },
  unscaledPageWidth: number
): { x: number; y: number; width: number; height: number } {
  // PDF annotation rect is [x1, y1, x2, y2] in unscaled PDF coords (bottom-left origin)
  // viewport is already scaled to TARGET_WIDTH
  const scale = viewport.width / unscaledPageWidth
  const x = Math.round(rect[0] * scale)
  const width = Math.round((rect[2] - rect[0]) * scale)
  const height = Math.round((rect[3] - rect[1]) * scale)
  // Flip Y: PDF origin is bottom-left, canvas origin is top-left
  const y = Math.round(viewport.height - rect[3] * scale)
  return { x, y, width, height }
}

export class PDFRenderer {
  private doc: PDFDocumentProxy | null = null
  private getDocument: ((params: { data: Uint8Array }) => { promise: Promise<PDFDocumentProxy> }) | null = null

  async initialize(fileBuffer: Buffer): Promise<void> {
    // Dynamic import of pdfjs-dist (ESM module)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    this.getDocument = pdfjs.getDocument
    this.doc = await pdfjs.getDocument({ data: new Uint8Array(fileBuffer) }).promise
  }

  async renderSlide(index: number): Promise<{ buffer: Buffer; width: number; height: number }> {
    if (!this.doc) throw new Error('PDF not initialized')

    const page = await this.doc.getPage(index + 1) // pdfjs is 1-indexed
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = TARGET_WIDTH / baseViewport.width
    const viewport = page.getViewport({ scale })

    const width = Math.round(viewport.width)
    const height = Math.round(viewport.height)
    const canvas = createCanvas(width, height)
    const ctx = canvas.getContext('2d')

    await page.render({ canvasContext: ctx as any, viewport }).promise

    // Draw video placeholders — black rectangle with play icon over media annotations
    const annotations = await page.getAnnotations()
    for (const a of annotations) {
      if (a.subtype !== 'Link' || !a.url || !isMediaUrl(a.url) || !a.rect) continue
      const geo = pdfRectToCanvas(a.rect, viewport, baseViewport.width)

      // Black background
      ctx.fillStyle = '#000000'
      ctx.fillRect(geo.x, geo.y, geo.width, geo.height)

      // Circle + play triangle (like YouTube thumbnail)
      const cx = geo.x + geo.width / 2
      const cy = geo.y + geo.height / 2
      const radius = Math.min(geo.width, geo.height) * 0.12

      // Circle outline
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.lineWidth = 2.5
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.stroke()

      // Play triangle inside circle
      const triSize = radius * 0.55
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
      ctx.beginPath()
      ctx.moveTo(cx - triSize * 0.35, cy - triSize)
      ctx.lineTo(cx - triSize * 0.35, cy + triSize)
      ctx.lineTo(cx + triSize * 0.8, cy)
      ctx.closePath()
      ctx.fill()
    }

    // Get raw RGBA buffer
    const imageData = ctx.getImageData(0, 0, width, height)
    return { buffer: Buffer.from(imageData.data.buffer), width, height }
  }

  async getSlideVideos(index: number): Promise<SlideVideoInfo[]> {
    if (!this.doc) throw new Error('PDF not initialized')

    const page = await this.doc.getPage(index + 1)
    const annotations = await page.getAnnotations()
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = TARGET_WIDTH / baseViewport.width
    const viewport = page.getViewport({ scale })

    return annotations
      .filter((a) => a.subtype === 'Link' && a.url && isMediaUrl(a.url))
      .map((a) => ({
        url: a.url!,
        geometry: pdfRectToCanvas(a.rect!, viewport, baseViewport.width)
      }))
  }

  getSlideCount(): number {
    if (!this.doc) throw new Error('PDF not initialized')
    return this.doc.numPages
  }

  destroy(): void {
    if (this.doc) {
      this.doc.destroy()
      this.doc = null
    }
  }
}
