# Phase 3: Canvas-based camera overlay compositor

## Dependencies

- Phase 1 (consumes `OverlayConfig`).
- Independent of Phase 2 — can run in parallel.

## Goal

A new adapter, `camera-overlay-compositor`, that:

1. Takes an `OverlayConfig`, the current slide buffer (RGBA), and a `VideoStream<VideoFrameEvent>` for the presenter's camera.
2. Draws each camera frame onto the slide using `@napi-rs/canvas`, applying a center-square-crop and circular clip in the configured corner.
3. Converts the composite RGBA to I420 and emits frames at ~20 fps for the publisher to push.
4. Owns no LiveKit state — it's a pure transform from `(slide, camera frames)` → `composite frames`.

## Files to create (3)

| File | Purpose |
|------|---------|
| `src/adapters/camera-overlay-compositor/types.ts` | Public interface + factory type. |
| `src/adapters/camera-overlay-compositor/component.ts` | The adapter implementation. |
| `src/adapters/camera-overlay-compositor/index.ts` | Barrel re-export to match the project's other adapter shape (`adapters/video-compositor/index.ts`, `adapters/livekit-publisher/index.ts`). |

## Files to modify (0)

None — wiring happens in Phase 4.

## Steps

### 1. Create `src/adapters/camera-overlay-compositor/types.ts`

```typescript
import type { ILoggerComponent, IBaseComponent } from '@well-known-components/interfaces'
import type { RemoteVideoTrack } from '@livekit/rtc-node'
import type { OverlayConfig } from '../../logic/presentation-manager/types'

/** A single composited frame, ready to push to LiveKit. */
export interface CompositeFrame {
  /** I420 (yuv420p) buffer sized for `width * height * 1.5`. */
  buffer: Buffer
  width: number
  height: number
}

/** Updates the slide buffer the compositor draws onto. Camera frames continue to flow. */
export interface ICameraOverlayCompositor {
  /**
   * Begin reading frames from the given camera track and pushing composites to `onFrame`.
   * Resolves once the stream is wired up; rejects on construction errors. Reading runs
   * in the background until `stop()` is called.
   */
  start(
    track: RemoteVideoTrack,
    slideBuffer: Buffer,
    slideWidth: number,
    slideHeight: number,
    onFrame: (frame: CompositeFrame) => void
  ): Promise<void>

  /** Swap the slide buffer (e.g. on slide navigation). No-op if not started. */
  updateSlide(slideBuffer: Buffer, slideWidth: number, slideHeight: number): void

  /** Currently-bound camera track, or null if not started. Used by Phase 5 to hand the track to ffmpeg. */
  getTrack(): RemoteVideoTrack | null

  /** Stop reading frames and release the VideoStream. Idempotent. */
  stop(): Promise<void>
}

export interface ICameraOverlayCompositorComponent extends IBaseComponent {
  createCompositor(logger: ILoggerComponent.ILogger, overlayConfig: OverlayConfig): ICameraOverlayCompositor
}
```

### 2. Create `src/adapters/camera-overlay-compositor/component.ts`

The full file contents (paste exactly):

```typescript
import { createCanvas, ImageData } from '@napi-rs/canvas'
import { VideoBufferType, VideoStream } from '@livekit/rtc-node'
import type { RemoteVideoTrack, VideoFrame as RtcVideoFrame } from '@livekit/rtc-node'
import type { ILoggerComponent } from '@well-known-components/interfaces'
import { rgbaToI420 } from '../../logic/color-convert'
import type { OverlayConfig } from '../../logic/presentation-manager/types'
import type {
  CompositeFrame,
  ICameraOverlayCompositor,
  ICameraOverlayCompositorComponent
} from './types'

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
  let currentTrack: RemoteVideoTrack | null = null

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

    // Construct a backing canvas the size of the slide and stamp the slide first.
    const canvas = createCanvas(slideWidth, slideHeight)
    const ctx = canvas.getContext('2d')
    const slideImageData = new ImageData(
      new Uint8ClampedArray(slideBuffer.buffer, slideBuffer.byteOffset, slideBuffer.byteLength),
      slideWidth,
      slideHeight
    )
    ctx.putImageData(slideImageData, 0, 0)

    // Center-square-crop the camera frame onto a sub-canvas the size of the overlay diameter.
    const diameter = Math.round(slideWidth * SIZE_RATIO[overlayConfig.size])
    const margin = Math.round(slideWidth * MARGIN_RATIO)
    const { x: ox, y: oy } = cornerOrigin(overlayConfig.corner, slideWidth, slideHeight, diameter, margin)

    const camCanvas = createCanvas(diameter, diameter)
    const camCtx = camCanvas.getContext('2d')
    const camImageData = new ImageData(
      new Uint8ClampedArray(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength),
      rgba.width,
      rgba.height
    )
    // Stamp the raw camera frame onto a throw-away canvas to be able to drawImage with crop.
    const fullCam = createCanvas(rgba.width, rgba.height)
    fullCam.getContext('2d').putImageData(camImageData, 0, 0)
    const cropSide = Math.min(rgba.width, rgba.height)
    const cropX = Math.floor((rgba.width - cropSide) / 2)
    const cropY = Math.floor((rgba.height - cropSide) / 2)
    camCtx.drawImage(fullCam, cropX, cropY, cropSide, cropSide, 0, 0, diameter, diameter)

    // Apply circular clip on the main canvas, draw the cropped camera, then restore.
    ctx.save()
    ctx.beginPath()
    ctx.arc(ox + diameter / 2, oy + diameter / 2, diameter / 2, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    ctx.drawImage(camCanvas, ox, oy, diameter, diameter)
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
      currentTrack = track
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

    getTrack(): RemoteVideoTrack | null {
      return currentTrack
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
      currentTrack = null
    }
  }
}

export function createCameraOverlayCompositorComponent(): ICameraOverlayCompositorComponent {
  return {
    createCompositor: createCameraOverlayCompositor
  }
}
```

### 3. Create `src/adapters/camera-overlay-compositor/index.ts`

```typescript
export { createCameraOverlayCompositorComponent } from './component'
export type {
  CompositeFrame,
  ICameraOverlayCompositor,
  ICameraOverlayCompositorComponent
} from './types'
```

### 4. Register the component in the app wiring

Find the file that wires components into the well-known-components container — grep `createVideoCompositorComponent` to locate it (likely `src/components.ts`). At that file, follow the existing pattern (e.g., the line that reads roughly `const videoCompositor = await createVideoCompositorComponent({ networkValidator })`) and add a sibling line:

```typescript
const cameraOverlayCompositor = await createCameraOverlayCompositorComponent()
```

Then include `cameraOverlayCompositor` in the returned `AppComponents` object and add `cameraOverlayCompositor: ICameraOverlayCompositorComponent` to the `AppComponents` type definition (typically `src/types.ts`).

> The spec writer did not enumerate these wiring lines because component-registry shape varies by project. The phase executor must read `src/components.ts` and `src/types.ts` and place the new component alongside `videoCompositor` using the existing convention.

## Edge cases

| Scenario | Handling |
|----------|----------|
| Camera frame arrives with `width === 0` or `height === 0` | `Math.min(0, …)` makes `cropSide = 0`; `drawImage` no-ops; nothing visible. We don't error. |
| Slide buffer has dimensions different from `slideWidth × slideHeight × 4` | Caller's contract violation. `ImageData` ctor throws; the pump's `try/catch` logs and continues — next slide may succeed. |
| Camera frame rate higher than 20 fps | Excess frames dropped by the `now - lastPushedAt < MIN_FRAME_INTERVAL_MS` gate. |
| Camera frame rate lower than 20 fps | We don't repeat — Phase 4 keeps the last-pushed slide+heartbeat alive between camera frames; no work here. |
| `stop()` called while `pump()` is mid-`reader.read()` | `running = false` exits the loop after the current `read()` resolves; `reader.cancel()` interrupts the pending read. |

## Verification

```bash
yarn typecheck
yarn lint
yarn test
```

Plus a smoke benchmark — write a one-off Jest test in `test/unit/camera-overlay-compositor.spec.ts` that:

1. Creates a 1920×1080 RGBA slide buffer (e.g., filled with a solid colour).
2. Constructs a fake `RtcVideoFrame` (RGBA, 640×480, gradient).
3. Calls `composeFrame()` directly (exported for testing) 200 times.
4. Asserts the loop completes in under 5 seconds (= 25 ms/frame budget at 20 fps).

If the budget is exceeded, log in `learnings/phase-3.md` and Phase 5 will need to consider whether to drop canvas overlay and unify on the ffmpeg path. The likely fix is *not* reallocating `createCanvas` per frame — hoist the slide canvas and the cam-sub-canvas into closure state and reuse them across frames.

## Learnings (post-execution)

After running this phase, append to `learnings/phase-3.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
