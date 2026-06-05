import { VideoBufferType, VideoStream } from '@livekit/rtc-node'
import { type Canvas, ImageData, createCanvas } from '@napi-rs/canvas'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { rgbaToI420 } from '../../logic/color-convert'
import { validateMediaDimensions } from '../video-compositor/component'
import type { CompositeFrame, ICameraOverlayCompositor, ICameraOverlayCompositorComponent } from './types'
import type { OverlayConfig } from '../../logic/presentation-manager/types'
import type { VideoFrame as RtcVideoFrame } from '@livekit/rtc-node'

const SIZE_RATIO: Record<OverlayConfig['size'], number> = {
  small: 0.15,
  medium: 0.2,
  large: 0.25
}

/** Margin from the slide edge, as a fraction of slide width. */
const MARGIN_RATIO = 0.02

/** Target output frame rate. Matches the existing FRAME_RATE in video-compositor. */
const FRAME_RATE = 20
const MIN_FRAME_INTERVAL_MS = 1000 / FRAME_RATE

function cornerOrigin(
  corner: OverlayConfig['corner'],
  slideWidth: number,
  slideHeight: number,
  diameter: number,
  margin: number
): { x: number; y: number } {
  switch (corner) {
    case 'TL':
      return { x: margin, y: margin }
    case 'TR':
      return { x: slideWidth - margin - diameter, y: margin }
    case 'BL':
      return { x: margin, y: slideHeight - margin - diameter }
    case 'BR':
      return { x: slideWidth - margin - diameter, y: slideHeight - margin - diameter }
  }
}

function createCameraOverlayCompositor(
  logger: ILoggerComponent.ILogger,
  overlayConfig: OverlayConfig
): ICameraOverlayCompositor {
  let stream: VideoStream | null = null
  let reader: ReadableStreamDefaultReader<{ frame: RtcVideoFrame }> | null = null
  let running = false
  let slide: { buffer: Buffer; width: number; height: number } | null = null
  let lastPushedAt = 0
  // Hoisted canvas + ImageData state — created on first frame, resized on slide
  // dimension changes. Reused across frames to keep per-frame GC pressure flat
  // (otherwise ~24 MB of getImageData output × 20 fps = ~480 MB/s of garbage).
  let mainCanvas: Canvas | null = null
  let mainCanvasWidth = 0
  let mainCanvasHeight = 0
  let fullCamCanvas: Canvas | null = null
  let fullCamWidth = 0
  let fullCamHeight = 0

  async function pump(onFrame: (frame: CompositeFrame) => void): Promise<void> {
    if (!reader) return
    try {
      while (running) {
        const { value, done } = await reader.read()
        if (done) break
        if (!slide) continue
        const now = Date.now()
        if (now - lastPushedAt < MIN_FRAME_INTERVAL_MS) continue
        lastPushedAt = now

        const composite = composeFrame(value.frame, slide.buffer, slide.width, slide.height)
        onFrame(composite)
      }
    } catch (err) {
      logger.warn(`camera-overlay-compositor pump error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function composeFrame(
    cameraFrame: RtcVideoFrame,
    slideBuffer: Buffer,
    slideWidth: number,
    slideHeight: number
  ): CompositeFrame {
    // Force the LiveKit-side frame into RGBA so we can draw it via Canvas2D.
    const rgba = cameraFrame.convert(VideoBufferType.RGBA)
    validateMediaDimensions(rgba.width, rgba.height, 'composeFrame')

    // Allocate (or resize) the main slide canvas. Reused across frames in the
    // common case where slide dimensions are constant.
    if (!mainCanvas || mainCanvasWidth !== slideWidth || mainCanvasHeight !== slideHeight) {
      mainCanvas = createCanvas(slideWidth, slideHeight)
      mainCanvasWidth = slideWidth
      mainCanvasHeight = slideHeight
    }
    const ctx = mainCanvas.getContext('2d')

    // Stamp the slide. ImageData wraps the slide buffer's bytes; this is a copy
    // into the canvas's internal backing store, so subsequent slide swaps are safe.
    const slideImageData = new ImageData(
      new Uint8ClampedArray(
        slideBuffer.buffer.slice(slideBuffer.byteOffset, slideBuffer.byteOffset + slideBuffer.byteLength)
      ),
      slideWidth,
      slideHeight
    )
    ctx.putImageData(slideImageData, 0, 0)

    // Overlay geometry.
    const diameter = Math.round(slideWidth * SIZE_RATIO[overlayConfig.size])
    const margin = Math.round(slideWidth * MARGIN_RATIO)
    const { x: ox, y: oy } = cornerOrigin(overlayConfig.corner, slideWidth, slideHeight, diameter, margin)

    // Allocate (or resize) the full-cam scratch canvas — we still need to stamp
    // the raw RGBA bytes onto a canvas so we can use drawImage's crop-rect form.
    if (!fullCamCanvas || fullCamWidth !== rgba.width || fullCamHeight !== rgba.height) {
      fullCamCanvas = createCanvas(rgba.width, rgba.height)
      fullCamWidth = rgba.width
      fullCamHeight = rgba.height
    }
    const camImageData = new ImageData(
      new Uint8ClampedArray(rgba.data.buffer.slice(rgba.data.byteOffset, rgba.data.byteOffset + rgba.data.byteLength)),
      rgba.width,
      rgba.height
    )
    fullCamCanvas.getContext('2d').putImageData(camImageData, 0, 0)

    const cropSide = Math.min(rgba.width, rgba.height)
    const cropX = Math.floor((rgba.width - cropSide) / 2)
    const cropY = Math.floor((rgba.height - cropSide) / 2)

    // Apply circular clip on the main canvas, then draw the cropped+scaled
    // camera region directly inside the clip with the crop-rect form of
    // drawImage. This replaces the per-frame intermediate camCanvas allocation.
    ctx.save()
    ctx.beginPath()
    ctx.arc(ox + diameter / 2, oy + diameter / 2, diameter / 2, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(fullCamCanvas, cropX, cropY, cropSide, cropSide, ox, oy, diameter, diameter)
    ctx.restore()

    const composite = ctx.getImageData(0, 0, slideWidth, slideHeight)
    const i420 = rgbaToI420(Buffer.from(composite.data.buffer), slideWidth, slideHeight)
    return { buffer: i420, width: slideWidth, height: slideHeight }
  }

  return {
    async start(track, slideBuffer, slideWidth, slideHeight, onFrame): Promise<void> {
      if (stream) {
        logger.warn('camera-overlay-compositor.start called while already running — restarting')
        await this.stop()
      }
      slide = { buffer: slideBuffer, width: slideWidth, height: slideHeight }
      stream = new VideoStream(track)
      reader = stream.getReader()
      running = true
      lastPushedAt = 0
      // Background pump — we deliberately don't `await` it.
      void pump(onFrame)
    },

    updateSlide(slideBuffer, slideWidth, slideHeight): void {
      slide = { buffer: slideBuffer, width: slideWidth, height: slideHeight }
    },

    async stop(): Promise<void> {
      running = false
      if (reader) {
        try {
          await reader.cancel()
        } catch {
          /* already cancelled */
        }
        reader = null
      }
      stream = null
      slide = null
      mainCanvas = null
      mainCanvasWidth = 0
      mainCanvasHeight = 0
      fullCamCanvas = null
      fullCamWidth = 0
      fullCamHeight = 0
    }
  }
}

export function createCameraOverlayCompositorComponent(): ICameraOverlayCompositorComponent {
  return {
    createCompositor: createCameraOverlayCompositor
  }
}
