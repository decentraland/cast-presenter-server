import { createCanvas } from '@napi-rs/canvas'
import type { IPdfRenderer, IPdfRendererComponent, RenderResult } from './types'
import type { SlideVideoInfo } from '../video-compositor/types'

// pdfjs-dist types
interface PDFDocumentProxy {
  numPages: number
  getPage(pageNumber: number): Promise<PDFPageProxy>
  destroy(): void
}

interface PDFPageProxy {
  getViewport(params: { scale: number }): { width: number; height: number }
  render(params: { canvasContext: unknown; viewport: { width: number; height: number } }): { promise: Promise<void> }
  getAnnotations(): Promise<PDFAnnotation[]>
}

interface PDFAnnotation {
  subtype: string
  url?: string
  rect?: number[]
}

const TARGET_WIDTH = 960

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
  const scale = viewport.width / unscaledPageWidth
  const x = Math.round(rect[0] * scale)
  const width = Math.round((rect[2] - rect[0]) * scale)
  const height = Math.round((rect[3] - rect[1]) * scale)
  const y = Math.round(viewport.height - rect[3] * scale)
  return { x, y, width, height }
}

function createRenderer(): IPdfRenderer {
  let doc: PDFDocumentProxy | null = null

  return {
    async initialize(fileBuffer: Buffer): Promise<void> {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
      doc = await pdfjs.getDocument({ data: new Uint8Array(fileBuffer) }).promise
    },

    async renderSlide(index: number): Promise<RenderResult> {
      if (!doc) throw new Error('PDF not initialized')

      const page = await doc.getPage(index + 1)
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = TARGET_WIDTH / baseViewport.width
      const viewport = page.getViewport({ scale })

      const width = Math.round(viewport.width)
      const height = Math.round(viewport.height)
      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')

      await page.render({ canvasContext: ctx as unknown, viewport }).promise

      const annotations = await page.getAnnotations()
      for (const a of annotations) {
        if (a.subtype !== 'Link' || !a.url || !isMediaUrl(a.url) || !a.rect) continue
        const geo = pdfRectToCanvas(a.rect, viewport, baseViewport.width)

        ctx.fillStyle = '#000000'
        ctx.fillRect(geo.x, geo.y, geo.width, geo.height)

        const cx = geo.x + geo.width / 2
        const cy = geo.y + geo.height / 2
        const radius = Math.min(geo.width, geo.height) * 0.12

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
        ctx.lineWidth = 2.5
        ctx.beginPath()
        ctx.arc(cx, cy, radius, 0, Math.PI * 2)
        ctx.stroke()

        const triSize = radius * 0.55
        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)'
        ctx.beginPath()
        ctx.moveTo(cx - triSize * 0.35, cy - triSize)
        ctx.lineTo(cx - triSize * 0.35, cy + triSize)
        ctx.lineTo(cx + triSize * 0.8, cy)
        ctx.closePath()
        ctx.fill()
      }

      const imageData = ctx.getImageData(0, 0, width, height)
      return { buffer: Buffer.from(imageData.data.buffer), width, height }
    },

    async getSlideVideos(index: number): Promise<SlideVideoInfo[]> {
      if (!doc) throw new Error('PDF not initialized')

      const page = await doc.getPage(index + 1)
      const annotations = await page.getAnnotations()
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = TARGET_WIDTH / baseViewport.width
      const viewport = page.getViewport({ scale })

      return annotations
        .filter((a) => a.subtype === 'Link' && a.url && isMediaUrl(a.url))
        .filter((a): a is PDFAnnotation & { url: string; rect: number[] } => !!a.url && !!a.rect)
        .map((a) => ({
          url: a.url,
          geometry: pdfRectToCanvas(a.rect, viewport, baseViewport.width)
        }))
    },

    getSlideCount(): number {
      if (!doc) throw new Error('PDF not initialized')
      return doc.numPages
    },

    destroy(): void {
      if (doc) {
        doc.destroy()
        doc = null
      }
    }
  }
}

export function createPdfRendererComponent(): IPdfRendererComponent {
  return {
    createRenderer
  }
}
