# Phase 3: Redundant-allocation and dead-code cleanup

## Dependencies

- None (can run in parallel with Phases 1, 2, 4, 5)

## Goal

Three related cleanups in two adapters:

1. Remove the `ICameraOverlayCompositor.getTrack()` API and its `currentTrack` closure variable — dead code (no caller).
2. Hoist the per-frame canvas allocations in `composeFrame` into closure state, and eliminate the intermediate `camCanvas` allocation entirely by drawing the cropped camera region directly inside the circular clip on the main canvas.
3. In `video-compositor.startPlayback`, reuse the single `VideoStream`/`reader` opened to learn camera dimensions for the long-lived pump (rather than constructing a second `VideoStream` on the same track).

Closes the dead-code finding for `getTrack()`, the redundant-allocation finding for `composeFrame`, and the dual-VideoStream-construction finding from `review.md`.

## Files to modify (3)

| File | Change |
|------|--------|
| `src/adapters/camera-overlay-compositor/types.ts` | Remove `getTrack()` from `ICameraOverlayCompositor`. |
| `src/adapters/camera-overlay-compositor/component.ts` | Remove `currentTrack` closure var, its assignments, the `getTrack` method; hoist `canvas`/`fullCam` into closure state; remove `camCanvas` and draw the cropped camera directly into the circular clip. |
| `src/adapters/video-compositor/component.ts` | Change `readFirstCameraFrame` to return the open stream/reader; reuse it for the pump in `startPlayback`. |

## Steps

### 1. `src/adapters/camera-overlay-compositor/types.ts` — drop `getTrack()` from the interface

Remove lines 31–32 (the doc comment `/** Currently-bound camera track, or null if not started. Used by Phase 5 to hand the track to ffmpeg. */`) and the immediately following method signature `getTrack(): RemoteVideoTrack | null`. The `RemoteVideoTrack` import at the top of the file should remain — it is still referenced by the `track` parameter on `start()`.

### 2. `src/adapters/camera-overlay-compositor/component.ts` — remove `currentTrack` closure variable

Delete the line `let currentTrack: RemoteVideoTrack | null = null` (line 50, inside `createCameraOverlayCompositor`'s closure block). Then delete the assignment `currentTrack = track` inside `start()` (currently line 131, immediately after `slide = { buffer: slideBuffer, ... }`), the entire `getTrack()` method block in the returned object (currently lines 144–146), and the line `currentTrack = null` inside `stop()` (currently line 160, between `slide = null` and the closing brace of `stop`).

After removing those, the `RemoteVideoTrack` type import on line 7 of the file is no longer referenced by any local declaration (the `start` method's `track` parameter is typed via the interface). Verify by running `yarn typecheck`; if the import becomes unused, delete it from the import statement.

### 3. `src/adapters/camera-overlay-compositor/component.ts` — hoist canvases into closure state

Inside `createCameraOverlayCompositor`'s closure (the block beginning at line 41), add three closure-scoped mutable canvas variables alongside the existing `let slide`, `let lastPushedAt` declarations. They start as `null` and are sized on first use (or resized when slide dimensions change). The `camCanvas` allocation is being eliminated entirely in step 4, so do **not** add a `camCanvas` closure variable. AFTER (inserted directly after the existing `let lastPushedAt = 0` line):

```typescript
  let lastPushedAt = 0
  // Hoisted canvas + ImageData state — created on first frame, resized on slide
  // dimension changes. Reused across frames to keep per-frame GC pressure flat
  // (otherwise ~24 MB of getImageData output × 20 fps = ~480 MB/s of garbage).
  let mainCanvas: ReturnType<typeof createCanvas> | null = null
  let mainCanvasWidth = 0
  let mainCanvasHeight = 0
  let fullCamCanvas: ReturnType<typeof createCanvas> | null = null
  let fullCamWidth = 0
  let fullCamHeight = 0
```

### 4. `src/adapters/camera-overlay-compositor/component.ts` — rewrite `composeFrame` to reuse canvases and drop `camCanvas`

Replace the entire body of `composeFrame` (currently lines 71–122). The new body validates dimensions (Phase 1 already adds the `validateMediaDimensions` call — keep that import + call), reuses or resizes the hoisted `mainCanvas` and `fullCamCanvas`, and draws the cropped camera region directly inside the circular clip on the main canvas using the crop-rect form of `drawImage`, eliminating the intermediate `camCanvas`. AFTER (the full replacement body — preserve the function signature and the surrounding `function composeFrame(...)` declaration):

```typescript
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
      new Uint8ClampedArray(slideBuffer.buffer.slice(slideBuffer.byteOffset, slideBuffer.byteOffset + slideBuffer.byteLength)),
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
```

> Note: the `Uint8ClampedArray(...buffer.slice(...))` form (instead of the previous aliased-view form) is a defense-in-depth copy that closes the Phase 5 Low-severity buffer-aliasing finding. Keep both copies — overlap with Phase 5 is intentional.

### 5. `src/adapters/camera-overlay-compositor/component.ts` — null hoisted canvases on `stop()`

Inside the `stop()` method on the returned object (currently lines 148–161), add `mainCanvas = null; mainCanvasWidth = 0; mainCanvasHeight = 0; fullCamCanvas = null; fullCamWidth = 0; fullCamHeight = 0` immediately before the closing brace of the async function (right after `slide = null`). This frees the native canvas handles when the compositor is stopped. AFTER:

```typescript
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
```

### 6. `src/adapters/video-compositor/component.ts` — change `readFirstCameraFrame` to return the open stream/reader

Replace the `readFirstCameraFrame` function body (lines 286–309) so it returns the stream and reader to the caller alongside the first frame's dimensions/bytes. The caller (in `startPlayback`) takes ownership and reuses them for the pump, rather than constructing a second `VideoStream`. The new return type is `{ width, height, firstFrameRgba, stream, reader }`. Keep the existing `Camera stream ended before first frame` error path. AFTER:

```typescript
  async function readFirstCameraFrame(track: RemoteVideoTrack): Promise<{
    width: number
    height: number
    firstFrameRgba: Buffer
    stream: VideoStream
    reader: ReadableStreamDefaultReader<{ frame: RtcVideoFrame }>
  }> {
    const stream = new VideoStream(track)
    const reader = stream.getReader()
    try {
      const { value, done } = await reader.read()
      if (done || !value) {
        // Clean up the just-opened reader/stream before failing — caller never gets them.
        try {
          await reader.cancel()
        } catch {
          /* already cancelled */
        }
        throw new Error('Camera stream ended before first frame')
      }
      const rgba = value.frame.convert(VideoBufferType.RGBA)
      validateMediaDimensions(rgba.width, rgba.height, 'readFirstCameraFrame')
      return {
        width: rgba.width,
        height: rgba.height,
        firstFrameRgba: Buffer.from(rgba.data),
        stream,
        reader
      }
    } catch (err) {
      try {
        await reader.cancel()
      } catch {
        /* already cancelled */
      }
      throw err
    }
  }
```

### 7. `src/adapters/video-compositor/component.ts` — reuse the returned stream/reader in `startPlayback`

Inside `startPlayback`, replace the existing camera pump setup (the block starting at line 655 with `if (presenterCamera && cameraInit && compositeProcess.stdio[3]) {` and ending at line 705 with the `).catch(...)` line). The new shape: bind `cameraStream` and `cameraReader` from `cameraInit.stream` and `cameraInit.reader` (i.e., the ones already opened by `readFirstCameraFrame`), drop the `new VideoStream(presenterCamera.track)` and `cameraStream.getReader()` calls, and use the existing `localReader` reference for the pump loop. AFTER:

```typescript
      // Camera-frame pump: feed raw RGBA frames from the LiveKit VideoStream into
      // ffmpeg's fd:3. We reuse the VideoStream/reader already opened by
      // readFirstCameraFrame to learn the camera's dimensions — opening a second
      // VideoStream on the same RemoteVideoTrack would duplicate the allocation
      // and add an artificial dependency on the first frame arriving before
      // ffmpeg can spawn. ffmpeg can't change input resolution mid-stream — if
      // the camera reports a new size we abort and let the presentation-manager
      // restart playback. Back-pressure is handled via 'drain'; EPIPE on
      // shutdown is silenced.
      if (presenterCamera && cameraInit && compositeProcess.stdio[3]) {
        const cameraStdin = compositeProcess.stdio[3] as NodeJS.WritableStream
        const camWidth = cameraInit.width
        const camHeight = cameraInit.height

        // Write the pre-read first frame so ffmpeg gets data immediately.
        cameraStdin.write(cameraInit.firstFrameRgba)

        cameraStdin.on('error', (err: Error) => {
          // ffmpeg may EPIPE this fd on its own shutdown — we don't want it to crash us.
          logger.warn(`Camera stdin error: ${err.message}`)
        })

        // Reuse — don't reconstruct — the stream/reader opened by readFirstCameraFrame.
        cameraStream = cameraInit.stream
        cameraReader = cameraInit.reader
        const localReader = cameraReader

        void (async () => {
          try {
            while (isPlaying) {
              const { value, done } = await localReader.read()
              if (done || !value) break
              if (value.frame.width !== camWidth || value.frame.height !== camHeight) {
                logger.warn(
                  `Camera resolution changed (${camWidth}x${camHeight} -> ${value.frame.width}x${value.frame.height}), aborting`
                )
                abortPlayback('camera-resolution-changed', publisher, slideBuffer, slideWidth, slideHeight)
                break
              }
              try {
                validateMediaDimensions(value.frame.width, value.frame.height, 'cameraPump')
              } catch (err) {
                logger.warn(`Camera pump aborted: ${err instanceof Error ? err.message : String(err)}`)
                abortPlayback('camera-resolution-invalid', publisher, slideBuffer, slideWidth, slideHeight)
                break
              }
              const rgba = value.frame.convert(VideoBufferType.RGBA)
              const ok = cameraStdin.write(Buffer.from(rgba.data))
              if (!ok) {
                // Back-pressure — wait for drain before reading more.
                await new Promise<void>((resolve) => cameraStdin.once('drain', resolve))
              }
            }
          } catch (err) {
            logger.warn(`Camera pump error: ${err instanceof Error ? err.message : String(err)}`)
          } finally {
            try {
              cameraStdin.end()
            } catch {
              /* already closed */
            }
          }
        })().catch((err) => {
          logger.warn(`Camera pump unhandled rejection: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
```

> Note: if Phase 1 has already landed and added the `validateMediaDimensions(...)` block plus the second-validation line after `readFirstCameraFrame`, leave the Phase 1 additions in place (they merge cleanly with this phase). The `validateMediaDimensions(cameraInit.width, cameraInit.height, 'ffmpegCameraInput')` call from Phase 1 remains exactly where Phase 1 put it.

### 8. `src/adapters/video-compositor/component.ts` — defensive cleanup if pump branch is skipped

If `presenterCamera` was set but the new pump branch's `if (presenterCamera && cameraInit && compositeProcess.stdio[3])` evaluates false (e.g., stdio fd 3 missing), the stream/reader returned from `readFirstCameraFrame` would leak. Add a defensive `else if (cameraInit) { ... }` block immediately after the new pump block that cancels `cameraInit.reader` (best-effort) so the resource isn't orphaned. AFTER:

```typescript
      } else if (cameraInit) {
        // Defensive: presenterCamera was set but the stdio fd is missing.
        // Close the stream/reader so they don't leak.
        try {
          await cameraInit.reader.cancel()
        } catch {
          /* already cancelled */
        }
      }
```

(Place this `else if` directly after the closing brace of the `if (presenterCamera && cameraInit && compositeProcess.stdio[3]) { ... }` block. Note: `await` inside `startPlayback` is fine — the surrounding function is already `async`.)

## Verification

```bash
yarn typecheck && yarn lint
```

Then targeted unit/integration runs that exercise the camera-overlay pump and the ffmpeg pipeline:

```bash
yarn test test/unit/build-filter-complex.spec.ts test/integration/loom-overlay.spec.ts
```

## Learnings (post-execution)

After running this phase, append to `learnings/phase-3.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
