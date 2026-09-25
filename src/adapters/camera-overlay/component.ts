import { VideoBufferType, VideoStream } from '@livekit/rtc-node'
import { type Canvas, ImageData, createCanvas } from '@napi-rs/canvas'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { rgbaToI420 } from '../../logic/color-convert'
import { validateMediaDimensions } from '../video-compositor/component'
import type {
  ICameraOverlay,
  ICameraOverlayComponent,
  OverlayLayout,
  OverlayPatch,
  OverlayRect,
  OverlaySize
} from './types'
import type { VideoFrameEvent } from '@livekit/rtc-node'

export const OVERLAY_SIZES: readonly OverlaySize[] = ['small', 'large']

export const DEFAULT_OVERLAY_LAYOUT: OverlayLayout = { x: 0, y: 1, size: 'small' }

const RATIO: Record<OverlaySize, number> = { small: 0.15, large: 0.25 }
const MARGIN_RATIO = 0.02
const FRAME_RATE = 20
const MIN_FRAME_INTERVAL_MS = 1000 / FRAME_RATE

const even = (n: number): number => n - (n % 2)
const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max)
const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** @returns the even-aligned bubble square in pixels; `d` is `0` when it does not fit. */
export function overlayRect(layout: OverlayLayout, width: number, height: number): OverlayRect {
  const margin = Math.round(width * MARGIN_RATIO)
  const d = even(Math.min(Math.round(width * RATIO[layout.size]), height - 2 * margin))
  if (d < 2) return { left: 0, top: 0, d: 0 }
  const r = d / 2
  const cx = clamp(clamp(layout.x, 0, 1) * width, margin + r, width - margin - r)
  const cy = clamp(clamp(layout.y, 0, 1) * height, margin + r, height - margin - r)
  return { left: even(Math.round(cx - r)), top: even(Math.round(cy - r)), d }
}

const blend = (src: number, dst: number, a: number): number => ((src * a + dst * (255 - a) + 127) / 255) | 0

/** Alpha-blends `patch` into `i420` in place at `rect`, skipping out-of-frame pixels. */
export function blendPatch(i420: Buffer, width: number, height: number, patch: OverlayPatch, rect: OverlayRect): void {
  const d = rect.d
  if (d === 0) return
  const { y, u, v, alpha } = patch

  for (let j = 0; j < d; j++) {
    const fy = rect.top + j
    if (fy < 0 || fy >= height) continue
    for (let i = 0; i < d; i++) {
      const fx = rect.left + i
      if (fx < 0 || fx >= width) continue
      const a = alpha[j * d + i]
      if (a === 0) continue
      const idx = fy * width + fx
      i420[idx] = blend(y[j * d + i], i420[idx], a)
    }
  }

  const ySize = width * height
  const uvW = (width + 1) >> 1
  const uvH = (height + 1) >> 1
  const uvSize = uvW * uvH
  const uvD = d >> 1
  const uvLeft = rect.left >> 1
  const uvTop = rect.top >> 1
  for (let cj = 0; cj < uvD; cj++) {
    const fy = uvTop + cj
    if (fy < 0 || fy >= uvH) continue
    for (let ci = 0; ci < uvD; ci++) {
      const fx = uvLeft + ci
      if (fx < 0 || fx >= uvW) continue
      const p = cj * 2 * d + ci * 2
      const a = (alpha[p] + alpha[p + 1] + alpha[p + d] + alpha[p + d + 1] + 2) >> 2
      if (a === 0) continue
      const src = cj * uvD + ci
      const idx = fy * uvW + fx
      i420[ySize + idx] = blend(u[src], i420[ySize + idx], a)
      i420[ySize + uvSize + idx] = blend(v[src], i420[ySize + uvSize + idx], a)
    }
  }
}

function createCameraOverlay(logger: ILoggerComponent.ILogger): ICameraOverlay {
  let layout: OverlayLayout = { ...DEFAULT_OVERLAY_LAYOUT }
  let stream: VideoStream | null = null
  let reader: ReadableStreamDefaultReader<VideoFrameEvent> | null = null
  let running = false
  let lastAcceptedAt = 0
  let fullCamCanvas: Canvas | null = null
  let fullCamWidth = 0
  let fullCamHeight = 0
  let patchCanvas: Canvas | null = null
  let cameraSeq = 0
  let hasFrame = false
  let patch: OverlayPatch | null = null
  let patchKey = ''
  const callbacks: Array<() => void> = []

  const isCurrent = (ownReader: ReadableStreamDefaultReader<VideoFrameEvent>): boolean =>
    running && reader === ownReader

  function acceptFrame(event: VideoFrameEvent): void {
    try {
      validateMediaDimensions(event.frame.width, event.frame.height, 'camera-overlay')
    } catch (err) {
      logger.warn(`camera-overlay dropped frame: ${describeError(err)}`)
      return
    }
    const rgba = event.frame.convert(VideoBufferType.RGBA)
    if (!fullCamCanvas || fullCamWidth !== rgba.width || fullCamHeight !== rgba.height) {
      fullCamCanvas = createCanvas(rgba.width, rgba.height)
      fullCamWidth = rgba.width
      fullCamHeight = rgba.height
    }
    const imageData = new ImageData(
      new Uint8ClampedArray(rgba.data.buffer.slice(rgba.data.byteOffset, rgba.data.byteOffset + rgba.data.byteLength)),
      rgba.width,
      rgba.height
    )
    fullCamCanvas.getContext('2d').putImageData(imageData, 0, 0)
    hasFrame = true
    cameraSeq++
    for (const callback of callbacks) {
      try {
        callback()
      } catch (err) {
        logger.warn(`camera-overlay frame callback error: ${describeError(err)}`)
      }
    }
  }

  async function pump(ownReader: ReadableStreamDefaultReader<VideoFrameEvent>): Promise<void> {
    try {
      while (isCurrent(ownReader)) {
        const { value, done } = await ownReader.read()
        if (!isCurrent(ownReader) || done) break
        const now = Date.now()
        if (now - lastAcceptedAt < MIN_FRAME_INTERVAL_MS) continue
        lastAcceptedAt = now
        try {
          acceptFrame(value)
        } catch (err) {
          logger.warn(`camera-overlay frame error: ${describeError(err)}`)
        }
      }
    } catch (err) {
      logger.warn(`camera-overlay pump error: ${describeError(err)}`)
    }
    if (reader !== ownReader) return
    reader = null
    stream = null
    running = false
    hasFrame = false
    patch = null
    ownReader.cancel().catch(() => undefined)
  }

  function buildPatch(d: number): OverlayPatch {
    if (!patchCanvas || patchCanvas.width !== d) patchCanvas = createCanvas(d, d)
    const ctx = patchCanvas.getContext('2d')
    ctx.clearRect(0, 0, d, d)
    if (fullCamCanvas) {
      const cropSide = Math.min(fullCamWidth, fullCamHeight)
      const cropX = Math.floor((fullCamWidth - cropSide) / 2)
      const cropY = Math.floor((fullCamHeight - cropSide) / 2)
      ctx.save()
      ctx.beginPath()
      ctx.arc(d / 2, d / 2, d / 2, 0, Math.PI * 2)
      ctx.closePath()
      ctx.clip()
      ctx.drawImage(fullCamCanvas, cropX, cropY, cropSide, cropSide, 0, 0, d, d)
      ctx.restore()
    }
    const { data } = ctx.getImageData(0, 0, d, d)
    const alpha = new Uint8Array(d * d)
    for (let p = 0; p < alpha.length; p++) alpha[p] = data[p * 4 + 3]
    const planes = rgbaToI420(Buffer.from(data.buffer, data.byteOffset, data.byteLength), d, d)
    const ySize = d * d
    const uvSize = (d >> 1) * (d >> 1)
    return {
      d,
      y: planes.subarray(0, ySize),
      u: planes.subarray(ySize, ySize + uvSize),
      v: planes.subarray(ySize + uvSize, ySize + uvSize * 2),
      alpha
    }
  }

  const overlay: ICameraOverlay = {
    start(track) {
      const old = reader
      reader = null
      old?.cancel().catch(() => undefined)
      running = false
      hasFrame = false
      let ownReader: ReadableStreamDefaultReader<VideoFrameEvent>
      try {
        stream = new VideoStream(track)
        ownReader = stream.getReader()
      } catch (err) {
        stream = null
        logger.warn(`camera-overlay failed to start: ${describeError(err)}`)
        return
      }
      reader = ownReader
      running = true
      lastAcceptedAt = 0
      void pump(ownReader)
    },

    async stop() {
      const old = reader
      running = false
      hasFrame = false
      reader = null
      stream = null
      fullCamCanvas = null
      patch = null
      patchKey = ''
      await old?.cancel().catch(() => undefined)
    },

    setLayout(next) {
      layout = { x: clamp(next.x, 0, 1), y: clamp(next.y, 0, 1), size: next.size }
    },

    getLayout() {
      return { ...layout }
    },

    isActive() {
      return running && hasFrame
    },

    stamp(i420, width, height) {
      if (!overlay.isActive()) return
      const rect = overlayRect(layout, width, height)
      if (rect.d === 0) return
      const key = `${cameraSeq}:${rect.d}`
      if (!patch || patchKey !== key) {
        patch = buildPatch(rect.d)
        patchKey = key
      }
      blendPatch(i420, width, height, patch, rect)
    },

    onCameraFrame(callback) {
      callbacks.push(callback)
    }
  }

  return overlay
}

/** Creates the camera overlay factory component. */
export function createCameraOverlayComponent(): ICameraOverlayComponent {
  return {
    createOverlay: createCameraOverlay
  }
}
