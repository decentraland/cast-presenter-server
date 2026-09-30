import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { GlobalFonts, type SKRSContext2D, createCanvas, loadImage } from '@napi-rs/canvas'
import { MAX_EMBEDDED_MEDIA_BYTES, PPTXParser } from './parser/core/PPTXParser'
import { fitRenderSize } from '../../logic/render-size'
import type { Geometry } from './parser/models/Geometry'
import type { Shape } from './parser/models/Shape'
import type { Slide } from './parser/models/Slide'
import type { Fill, Stroke, TextParagraph, TextRun } from './parser/models/types'
import type { IRenderer, IRendererComponent, RenderResult } from '../renderer/types'
import type { SlideVideoInfo } from '../video-compositor/types'

// Emoji font: pick whichever is available on the system
const EMOJI_FONT_FAMILY = GlobalFonts.has('Apple Color Emoji')
  ? 'Apple Color Emoji'
  : GlobalFonts.has('Noto Color Emoji')
    ? 'Noto Color Emoji'
    : ''

// Regex for characters that should render with the COLOR emoji font.
//
// We use \p{Emoji_Presentation} rather than \p{Extended_Pictographic} here:
// the former only matches codepoints that default to color-emoji presentation
// (U+1F300+ range, plus a few 16-bit ones with Emoji_Presentation=Yes). The
// latter also catches Dingbats and Miscellaneous Symbols (U+2600–U+27BF) like
// ❏ ❐ ❒ ◆ ☆ ★ — these are monochrome symbols that Noto Color Emoji doesn't
// ship glyphs for, causing them to silently disappear from the render.
// Characters followed by VS-16 (U+FE0F) are also treated as emoji for cases
// where authors explicitly request color presentation of a text-default code.
// eslint-disable-next-line no-misleading-character-class
const EMOJI_RE =
  /(\p{Emoji_Presentation}[\u{FE00}-\u{FE0F}\u{200D}\p{Extended_Pictographic}]*|\p{Extended_Pictographic}\u{FE0F}[\u{200D}\p{Extended_Pictographic}]*)/gu

/**
 * Splits text into alternating non-emoji / emoji segments.
 * Skia can't render mixed emoji+text in a single fillText call — the text after
 * the emoji silently disappears. We split and render each segment with its own font.
 */
function splitEmoji(text: string): Array<{ text: string; isEmoji: boolean }> {
  if (!EMOJI_FONT_FAMILY) return [{ text, isEmoji: false }]
  const parts: Array<{ text: string; isEmoji: boolean }> = []
  let lastIndex = 0
  EMOJI_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EMOJI_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), isEmoji: false })
    }
    parts.push({ text: match[0], isEmoji: true })
    lastIndex = EMOJI_RE.lastIndex
  }
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), isEmoji: false })
  }
  return parts.length > 0 ? parts : [{ text, isEmoji: false }]
}

/** Render text handling emoji segments separately to work around Skia mixed-font bug. */
function fillTextWithEmoji(ctx: SKRSContext2D, text: string, x: number, y: number, baseFont: string): number {
  const parts = splitEmoji(text)
  if (parts.length === 1 && !parts[0].isEmoji) {
    ctx.fillText(text, x, y)
    return ctx.measureText(text).width
  }
  let cx = x
  for (const part of parts) {
    if (part.isEmoji && EMOJI_FONT_FAMILY) {
      // Switch to emoji font at same size
      const sizeMatch = baseFont.match(/(\d+(?:\.\d+)?)px/)
      const size = sizeMatch ? sizeMatch[1] : '18'
      ctx.font = `${size}px "${EMOJI_FONT_FAMILY}"`
    } else {
      ctx.font = baseFont
    }
    ctx.fillText(part.text, cx, y)
    cx += ctx.measureText(part.text).width
  }
  ctx.font = baseFont
  return cx - x
}

/** Measure text width accounting for emoji font switching. */
function measureTextWithEmoji(ctx: SKRSContext2D, text: string, baseFont: string): number {
  const parts = splitEmoji(text)
  if (parts.length === 1 && !parts[0].isEmoji) {
    return ctx.measureText(text).width
  }
  let width = 0
  for (const part of parts) {
    if (part.isEmoji && EMOJI_FONT_FAMILY) {
      const sizeMatch = baseFont.match(/(\d+(?:\.\d+)?)px/)
      const size = sizeMatch ? sizeMatch[1] : '18'
      ctx.font = `${size}px "${EMOJI_FONT_FAMILY}"`
    } else {
      ctx.font = baseFont
    }
    width += ctx.measureText(part.text).width
  }
  ctx.font = baseFont
  return width
}

// -- Font weight extraction from family names (e.g. "Roboto Black" → weight 900) --

const FONT_WEIGHT_KEYWORDS: Array<[string, number]> = [
  ['ExtraBold', 800],
  ['UltraBold', 800],
  ['Black', 900],
  ['Heavy', 900],
  ['SemiBold', 600],
  ['DemiBold', 600],
  ['Bold', 700],
  ['Medium', 500],
  ['ExtraLight', 200],
  ['UltraLight', 200],
  ['Light', 300],
  ['Thin', 100]
]

function buildFont(run: { bold?: boolean; italic?: boolean; fontSize?: number; fontFamily?: string }): string {
  let family = run.fontFamily ?? 'Arial'
  let inferredWeight = 400

  // Extract weight keyword from the ORIGINAL family name before any fallback.
  // PPTX often specifies weight via family (e.g. "Inter Black", "Roboto Medium")
  // rather than a separate <b val="1"/>. Running this after a fallback to
  // Arial would discard the weight and render the text regular-weight.
  for (const [keyword, weight] of FONT_WEIGHT_KEYWORDS) {
    const re = new RegExp(`\\b${keyword}\\b`, 'i')
    if (re.test(family)) {
      inferredWeight = weight
      family = family.replace(re, '').replace(/\s+/g, ' ').trim()
      break
    }
  }
  family =
    family
      .replace(/\b(?:Italic|Oblique)\b/i, '')
      .replace(/\s+/g, ' ')
      .trim() || 'Arial'

  // Fallback to Arial for unregistered fonts AFTER weight extraction.
  // Skia's generic sans-serif fallback renders some Unicode symbols (e.g. ❏) as ⊠.
  if (family !== 'Arial' && !GlobalFonts.has(family)) {
    family = 'Arial'
  }

  const weight = run.bold ? Math.max(700, inferredWeight) : inferredWeight
  const styleStr = run.italic ? 'italic ' : ''
  const weightStr = weight !== 400 ? `${weight} ` : ''
  const size = `${run.fontSize ?? 24}px`
  return `${styleStr}${weightStr}${size} "${family}", sans-serif`.trim()
}

// -- Geometry helpers --

function applyRotation(ctx: SKRSContext2D, geo: Geometry): void {
  const cx = geo.x + geo.width / 2
  const cy = geo.y + geo.height / 2
  ctx.translate(cx, cy)
  ctx.rotate((geo.rotation * Math.PI) / 180)
  ctx.translate(-cx, -cy)
}

function applyClipPath(ctx: SKRSContext2D, geo: Geometry, clipShape: string): void {
  const { x, y, width: w, height: h } = geo
  const cx = x + w / 2
  const cy = y + h / 2

  switch (clipShape) {
    case 'ellipse':
    case 'circle':
      ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, 2 * Math.PI)
      break
    case 'roundRect': {
      const r = Math.min(w, h) * 0.1
      ctx.roundRect(x, y, w, h, r)
      break
    }
    default:
      ctx.rect(x, y, w, h)
  }
}

function applyOpacity(color: string, opacity?: number): string {
  if (opacity === undefined || opacity === 1) return color
  const hex = color.replace('#', '')
  if (hex.length === 6) {
    const r = parseInt(hex.slice(0, 2), 16)
    const g = parseInt(hex.slice(2, 4), 16)
    const b = parseInt(hex.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${opacity})`
  }
  return color
}

// -- Background rendering --

async function renderBackground(ctx: SKRSContext2D, slide: Slide, parser: PPTXParser): Promise<void> {
  const bg = slide.background
  const w = slide.width
  const h = slide.height

  if (!bg) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    return
  }

  if (bg.gradientStops && bg.gradientStops.length > 0) {
    const angle = (bg.gradientAngle ?? 0) * (Math.PI / 180)
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const grad = ctx.createLinearGradient(
      w * (0.5 - cos * 0.5),
      h * (0.5 - sin * 0.5),
      w * (0.5 + cos * 0.5),
      h * (0.5 + sin * 0.5)
    )
    for (const stop of bg.gradientStops) {
      grad.addColorStop(stop.position, stop.color)
    }
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
  } else if (bg.imageRef) {
    try {
      const data = await parser.getMedia(bg.imageRef)
      const img = await loadImage(Buffer.from(data))
      ctx.drawImage(img, 0, 0, w, h)
    } catch {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
    }
  } else if (bg.color) {
    ctx.fillStyle = bg.color
    ctx.fillRect(0, 0, w, h)
  } else {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
  }
}

// -- Video placeholder (same pattern as PDF renderer) --

function renderVideoPlaceholder(ctx: SKRSContext2D, geo: Geometry): void {
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

// -- Image shape rendering --

async function renderImageShape(ctx: SKRSContext2D, shape: Shape, parser: PPTXParser): Promise<void> {
  if (!shape.mediaRef) return
  try {
    const data = await parser.getMedia(shape.mediaRef)
    const img = await loadImage(Buffer.from(data))
    const geo = shape.geometry

    ctx.save()

    if (geo.rotation !== 0) {
      applyRotation(ctx, geo)
    }

    if (shape.clipShape) {
      ctx.beginPath()
      applyClipPath(ctx, geo, shape.clipShape)
      ctx.clip()
    }

    ctx.drawImage(img, geo.x, geo.y, geo.width, geo.height)
    ctx.restore()
  } catch {
    // Image failed to load (unsupported format like EMF/WMF) — gray placeholder
    ctx.fillStyle = '#cccccc'
    ctx.fillRect(shape.geometry.x, shape.geometry.y, shape.geometry.width, shape.geometry.height)
  }
}

// -- Primitive shape rendering --

function applyFill(ctx: SKRSContext2D, fill: Fill, geo: Geometry): void {
  if (fill.gradient && fill.gradient.stops.length > 0) {
    const angle = (fill.gradient.angle ?? 0) * (Math.PI / 180)
    const cx = geo.x + geo.width / 2
    const cy = geo.y + geo.height / 2
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const half = Math.max(geo.width, geo.height)
    const grad = ctx.createLinearGradient(cx - cos * half, cy - sin * half, cx + cos * half, cy + sin * half)
    for (const stop of fill.gradient.stops) {
      grad.addColorStop(stop.position, stop.color)
    }
    ctx.fillStyle = grad
  } else {
    ctx.fillStyle = applyOpacity(fill.color, fill.opacity)
  }
}

function renderRectangle(ctx: SKRSContext2D, geo: Geometry, fill?: Fill, stroke?: Stroke): void {
  if (fill) {
    applyFill(ctx, fill, geo)
    ctx.fillRect(geo.x, geo.y, geo.width, geo.height)
  }
  if (stroke) {
    ctx.strokeStyle = applyOpacity(stroke.color, stroke.opacity)
    ctx.lineWidth = stroke.width
    ctx.strokeRect(geo.x, geo.y, geo.width, geo.height)
  }
}

function renderRoundRect(ctx: SKRSContext2D, geo: Geometry, fill?: Fill, stroke?: Stroke): void {
  const r = Math.min(geo.width, geo.height) * 0.1
  if (fill) {
    applyFill(ctx, fill, geo)
    ctx.beginPath()
    ctx.roundRect(geo.x, geo.y, geo.width, geo.height, r)
    ctx.fill()
  }
  if (stroke) {
    ctx.strokeStyle = applyOpacity(stroke.color, stroke.opacity)
    ctx.lineWidth = stroke.width
    ctx.beginPath()
    ctx.roundRect(geo.x, geo.y, geo.width, geo.height, r)
    ctx.stroke()
  }
}

function renderEllipse(ctx: SKRSContext2D, geo: Geometry, fill?: Fill, stroke?: Stroke): void {
  const cx = geo.x + geo.width / 2
  const cy = geo.y + geo.height / 2
  ctx.beginPath()
  ctx.ellipse(cx, cy, geo.width / 2, geo.height / 2, 0, 0, 2 * Math.PI)
  if (fill) {
    applyFill(ctx, fill, geo)
    ctx.fill()
  }
  if (stroke) {
    ctx.strokeStyle = applyOpacity(stroke.color, stroke.opacity)
    ctx.lineWidth = stroke.width
    ctx.stroke()
  }
}

function renderLine(ctx: SKRSContext2D, geo: Geometry, stroke?: Stroke): void {
  if (!stroke) return
  ctx.beginPath()
  ctx.moveTo(geo.x, geo.y)
  ctx.lineTo(geo.x + geo.width, geo.y + geo.height)
  ctx.strokeStyle = applyOpacity(stroke.color, stroke.opacity)
  ctx.lineWidth = stroke.width
  ctx.stroke()
}

// -- Text rendering --

function renderSimpleText(ctx: SKRSContext2D, geo: Geometry, text: string, fill?: Fill): void {
  ctx.fillStyle = fill?.color ?? '#000000'
  ctx.font = '16px "Arial", sans-serif'
  ctx.textBaseline = 'top'

  const padding = 4
  const maxWidth = geo.width - padding * 2
  const lineHeight = 20
  const words = text.split(' ')
  let line = ''
  let y = geo.y + padding

  const baseFont = ctx.font
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word
    const w = measureTextWithEmoji(ctx, testLine, baseFont)
    if (w > maxWidth && line) {
      fillTextWithEmoji(ctx, line, geo.x + padding, y, baseFont)
      line = word
      y += lineHeight
    } else {
      line = testLine
    }
  }
  if (line) {
    fillTextWithEmoji(ctx, line, geo.x + padding, y, baseFont)
  }
}

interface LineSegment {
  text: string
  run: TextRun
}

function wrapParagraph(ctx: SKRSContext2D, para: TextParagraph, maxWidth: number): LineSegment[][] {
  const lines: LineSegment[][] = []
  let currentLine: LineSegment[] = []
  let currentWidth = 0

  const pushLine = (): void => {
    lines.push(currentLine)
    currentLine = []
    currentWidth = 0
  }

  for (const run of para.runs) {
    if (run.lineBreak) {
      pushLine()
      continue
    }

    const text = run.text
    if (!text) continue

    ctx.font = buildFont(run)
    const baseFont = ctx.font
    const tokens = text.match(/\S+\s*|\s+/g) ?? [text]

    for (const token of tokens) {
      const tokenWidth = measureTextWithEmoji(ctx, token, baseFont)

      if (maxWidth > 0 && currentWidth + tokenWidth > maxWidth && currentLine.length > 0) {
        pushLine()
        const trimmed = token.replace(/^\s+/, '')
        if (trimmed) {
          currentLine.push({ text: trimmed, run })
          currentWidth = measureTextWithEmoji(ctx, trimmed, baseFont)
        }
      } else {
        const last = currentLine[currentLine.length - 1]
        if (last && last.run === run) {
          last.text += token
        } else {
          currentLine.push({ text: token, run })
        }
        currentWidth += tokenWidth
      }
    }
  }

  pushLine()
  return lines
}

function renderParagraphs(
  ctx: SKRSContext2D,
  geo: Geometry,
  paragraphs: TextParagraph[],
  insets?: { left: number; right: number; top: number; bottom: number },
  textAnchor?: 'top' | 'middle' | 'bottom'
): void {
  const padL = insets?.left ?? 9.6
  const padR = insets?.right ?? 9.6
  const padT = insets?.top ?? 4.8
  const padB = insets?.bottom ?? 4.8
  const availWidth = geo.width - padL - padR

  // Phase 1: wrap all paragraphs
  const wrappedParas = paragraphs.map((para) => wrapParagraph(ctx, para, availWidth - (para.marL ?? 0)))

  // Phase 2: calculate total text height
  let totalTextHeight = 0
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]
    const lines = wrappedParas[i]
    const maxFontSize = para.runs.filter((r) => !r.lineBreak).reduce((mx, r) => Math.max(mx, r.fontSize ?? 24), 18)
    const lineHeight = maxFontSize * 1.2
    totalTextHeight += para.spaceBefore ?? 0
    if (lines.length === 0 || (lines.length === 1 && lines[0].length === 0)) {
      totalTextHeight += lineHeight
    } else {
      totalTextHeight += lines.length * lineHeight
    }
    totalTextHeight += para.spaceAfter ?? 0
  }

  // Phase 3: vertical anchor
  let y: number
  if (textAnchor === 'middle') {
    y = geo.y + (geo.height - totalTextHeight) / 2
  } else if (textAnchor === 'bottom') {
    y = geo.y + geo.height - padB - totalTextHeight
  } else {
    y = geo.y + padT
  }
  y = Math.max(y, geo.y + padT)

  const clipBottom = geo.y + geo.height - padB

  // Phase 4: render
  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i]
    const lines = wrappedParas[i]

    y += para.spaceBefore ?? 0

    const maxFontSize = para.runs.filter((r) => !r.lineBreak).reduce((mx, r) => Math.max(mx, r.fontSize ?? 24), 18)
    const lineHeight = maxFontSize * 1.2
    const marL = para.marL ?? 0
    const indent = para.indent ?? 0

    // Empty paragraph: advance y by one line height
    if (lines.length === 0 || (lines.length === 1 && lines[0].length === 0)) {
      y += lineHeight
      y += para.spaceAfter ?? 0
      if (y > clipBottom) break
      continue
    }

    let isFirstLine = true
    for (const line of lines) {
      if (y > clipBottom) break

      // Bullet on first visual line only — positioned at marL + indent (indent is negative for hanging bullets)
      if (isFirstLine && para.bullet && !para.bullet.none) {
        const bulletChar = para.bullet.char ?? (para.bullet.autoNum ? '1.' : '\u2022')
        const firstRun: TextRun = para.runs.find((r) => !r.lineBreak) ?? { text: '', fontSize: 24 }
        ctx.font = buildFont(firstRun)
        ctx.fillStyle = firstRun.color ?? '#000000'
        ctx.textBaseline = 'top'
        const bulletX = geo.x + padL + marL + indent
        fillTextWithEmoji(ctx, bulletChar, bulletX, y, ctx.font)
      }
      isFirstLine = false

      const textX = geo.x + padL + marL

      // Measure total line width for alignment
      let lineWidth = 0
      for (const seg of line) {
        ctx.font = buildFont(seg.run)
        lineWidth += measureTextWithEmoji(ctx, seg.text, ctx.font)
      }

      let x: number
      if (para.align === 'center') {
        x = textX + (availWidth - marL - lineWidth) / 2
      } else if (para.align === 'right') {
        x = geo.x + geo.width - padR - lineWidth
      } else {
        x = textX
      }

      for (const seg of line) {
        ctx.font = buildFont(seg.run)
        const baseFont = ctx.font
        const segWidth = measureTextWithEmoji(ctx, seg.text, baseFont)

        // Highlight background
        if (seg.run.highlight) {
          const fontSize = seg.run.fontSize ?? 24
          ctx.fillStyle = seg.run.highlight
          ctx.fillRect(x, y, segWidth, fontSize * 1.2)
        }

        // Text
        ctx.fillStyle = seg.run.color ?? '#000000'
        ctx.textBaseline = 'top'
        fillTextWithEmoji(ctx, seg.text, x, y, baseFont)

        // Underline
        if (seg.run.underline) {
          const fontSize = seg.run.fontSize ?? 24
          ctx.beginPath()
          ctx.moveTo(x, y + fontSize + 1)
          ctx.lineTo(x + segWidth, y + fontSize + 1)
          ctx.strokeStyle = seg.run.color ?? '#000000'
          ctx.lineWidth = 1
          ctx.stroke()
        }

        x += segWidth
      }

      y += lineHeight
    }

    y += para.spaceAfter ?? 0
    if (y > clipBottom) break
  }
}

// -- Shape dispatch --

function renderShape(ctx: SKRSContext2D, shape: Shape): void {
  const geo = shape.geometry
  ctx.save()

  if (shape.shadow) {
    ctx.shadowColor = shape.shadow.color
    ctx.shadowBlur = shape.shadow.blur
    ctx.shadowOffsetX = shape.shadow.offsetX
    ctx.shadowOffsetY = shape.shadow.offsetY
  }

  if (geo.rotation !== 0) {
    applyRotation(ctx, geo)
  }

  switch (shape.type) {
    case 'rectangle':
    case 'text':
      renderRectangle(ctx, geo, shape.fill, shape.stroke)
      break
    case 'roundRect':
      renderRoundRect(ctx, geo, shape.fill, shape.stroke)
      break
    case 'ellipse':
      renderEllipse(ctx, geo, shape.fill, shape.stroke)
      break
    case 'line':
      renderLine(ctx, geo, shape.stroke)
      break
    default:
      if (shape.fill || shape.stroke) {
        renderRectangle(ctx, geo, shape.fill, shape.stroke)
      }
  }

  // Text rendering — any PPTX shape type can carry text
  if (shape.paragraphs && shape.paragraphs.length > 0) {
    renderParagraphs(ctx, geo, shape.paragraphs, shape.textInsets, shape.textAnchor)
  } else if (shape.text) {
    renderSimpleText(ctx, geo, shape.text, shape.fill)
  }

  ctx.restore()
}

// -- Renderer factory --

function createRenderer(): IRenderer {
  let parser: PPTXParser | null = null
  let embeddedVideoDir: string | null = null

  async function extractEmbeddedVideo(mediaRef: string): Promise<string> {
    if (!parser) throw new Error('PPTX not initialized')
    if (!embeddedVideoDir) {
      embeddedVideoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cast-pptx-video-'))
    }
    const data = await parser.getMedia(mediaRef)
    // Cap per-media bytes to complement the overall ZIP-bomb guard. An
    // individual embedded asset shouldn't exceed this — if it does the deck
    // is almost certainly malicious or corrupted.
    if (data.byteLength > MAX_EMBEDDED_MEDIA_BYTES) {
      throw new Error(`Embedded media ${mediaRef} exceeds ${MAX_EMBEDDED_MEDIA_BYTES / 1024 / 1024} MB limit`)
    }
    const fileName = path.basename(mediaRef)
    const filePath = path.join(embeddedVideoDir, fileName)
    await fsp.writeFile(filePath, new Uint8Array(data))
    return filePath
  }

  return {
    async initialize(fileBuffer: Buffer): Promise<void> {
      parser = new PPTXParser()
      await parser.parse(new Uint8Array(fileBuffer))
    },

    async renderSlide(index: number): Promise<RenderResult> {
      if (!parser) throw new Error('PPTX not initialized')

      const slide = await parser.getSlide(index)
      const { scale, width, height } = fitRenderSize(slide.width, slide.height)

      const canvas = createCanvas(width, height)
      const ctx = canvas.getContext('2d')

      // Scale context so all rendering uses slide-space coordinates
      ctx.scale(scale, scale)

      // 1. Background
      await renderBackground(ctx, slide, parser)

      // 2. Shapes
      for (const shape of slide.shapes) {
        if (shape.isVideo()) {
          renderVideoPlaceholder(ctx, shape.geometry)
          continue
        }
        if (shape.isImage() && shape.mediaRef) {
          await renderImageShape(ctx, shape, parser)
          continue
        }
        renderShape(ctx, shape)
      }

      // 3. Extract RGBA buffer
      ctx.resetTransform()
      const imageData = ctx.getImageData(0, 0, width, height)
      return { buffer: Buffer.from(imageData.data.buffer), width, height }
    },

    async getSlideVideos(index: number): Promise<SlideVideoInfo[]> {
      if (!parser) throw new Error('PPTX not initialized')

      const slide = await parser.getSlide(index)
      const { scale } = fitRenderSize(slide.width, slide.height)
      const videos: SlideVideoInfo[] = []

      for (const shape of slide.getVideos()) {
        let url = ''

        if (shape.externalUrl) {
          // Defence-in-depth: the video-compositor runs full SSRF validation
          // (HTTPS + domain allowlist + private-IP block) on download, but a
          // crafted PPTX can embed hyperlinks with dangerous schemes that we
          // shouldn't even surface to callers or log. Accept only http/https
          // here; everything else (file:, data:, javascript:, ftp:, gopher:,
          // etc.) gets dropped silently.
          if (!/^https?:\/\//i.test(shape.externalUrl)) continue
          url = shape.externalUrl
        } else if (shape.mediaRef) {
          url = await extractEmbeddedVideo(shape.mediaRef)
        }

        if (!url) continue

        videos.push({
          url,
          geometry: {
            x: Math.round(shape.geometry.x * scale),
            y: Math.round(shape.geometry.y * scale),
            width: Math.round(shape.geometry.width * scale),
            height: Math.round(shape.geometry.height * scale)
          }
        })
      }

      return videos
    },

    getSlideCount(): number {
      if (!parser) throw new Error('PPTX not initialized')
      return parser.getSlideCount()
    },

    destroy(): void {
      parser = null
      if (embeddedVideoDir) {
        fs.rmSync(embeddedVideoDir, { recursive: true, force: true })
        embeddedVideoDir = null
      }
    }
  }
}

export function createPptxRendererComponent(): IRendererComponent {
  return { createRenderer }
}
