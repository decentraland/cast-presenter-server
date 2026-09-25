# Phase 2: Camera overlay stamper

## Outcome

A new WKC adapter at `src/adapters/camera-overlay/` provides:
- the wire-contract types;
- the shared `overlayRect` geometry;
- `blendPatch`, a pure function that blends into an I420 frame;
- a per-session `ICameraOverlay` that reads the presenter camera track and stamps the circular bubble into any I420 frame.

It is unit-tested and not yet wired into anything; phase 3 does that.

## Dependencies

Phase 1: canvas 1.0.9 and rtc-node 1.1.0 are installed.

## Write ownership

- `src/adapters/camera-overlay/types.ts` (new)
- `src/adapters/camera-overlay/component.ts` (new)
- `src/adapters/camera-overlay/index.ts` (new)
- `test/unit/camera-overlay.spec.ts` (new)

## Context

Base sha `2c6cdd12e0267306818af9540eede56d67203655`. Line numbers are from before phase 1 and may have drifted slightly.

What to reuse:
- **Camera drawing to port:** `src/adapters/camera-overlay-compositor/component.ts`.
  - The frame convert and dimension check are at `:87-88`: `cameraFrame.convert(VideoBufferType.RGBA)` then `validateMediaDimensions`.
  - The full-camera scratch canvas (reused, resized on change) is at `:117-127`, the centre-square crop at `:129-131`, and the `arc` clip with the crop-rect `drawImage` at `:136-142`.
  - The frame-rate throttle is at `:19-21` and `:68-70`: `FRAME_RATE = 20`, `MIN_FRAME_INTERVAL_MS`.
  - The reader loop is at `:61-78`, and `start`/`stop` with reader cancel at `:150-187`.
  - This phase copies that logic into the new module. The old module stays until phase 3 deletes it.
- **Colour conversion:** `rgbaToI420(rgba, w, h)` and `i420FrameSize(w, h)` in `src/logic/color-convert.ts:5-70`, using BT.601 and 2×2 chroma averaging.
- **Dimension check:** `validateMediaDimensions(width, height, ctx, max = 7680)` in `src/adapters/video-compositor/component.ts:60-67`, exported. Import it from there.
- **Factory shape to mirror:** `ICameraOverlayCompositorComponent` in `src/adapters/camera-overlay-compositor/types.ts:35-37`, and the synchronous factory `createCameraOverlayCompositorComponent` at `component.ts:190-194`.
- **Test constraint:** jest cannot run the real rtc-node native addon. Mock it the way `test/unit/livekit-publisher.spec.ts:9-22` does. `@napi-rs/canvas` loads natively in jest's `node` environment (`jest.config.js:9`), so use it unmocked.

## Steps

**Test-first.** Do step 6 right after step 1: write `test/unit/camera-overlay.spec.ts` against the step-1 interface, run it, and record the failing output in the learning JSON. Then do steps 2–5 until it passes.

1. Create `src/adapters/camera-overlay/types.ts`. This AFTER block is the interface decision; keep the names and signatures exactly, and add terse JSDoc per member.

   ```ts
   import type { IBaseComponent, ILoggerComponent } from '@well-known-components/interfaces'
   import type { RemoteVideoTrack } from '@livekit/rtc-node'

   export type OverlaySize = 'small' | 'large'

   export interface OverlayLayout {
     x: number
     y: number
     size: OverlaySize
   }

   export interface OverlayRect {
     left: number
     top: number
     d: number
   }

   export interface OverlayPatch {
     d: number
     y: Uint8Array
     u: Uint8Array
     v: Uint8Array
     alpha: Uint8Array
   }

   export interface ICameraOverlay {
     start(track: RemoteVideoTrack): void
     stop(): Promise<void>
     setLayout(layout: OverlayLayout): void
     getLayout(): OverlayLayout
     isActive(): boolean
     stamp(i420: Buffer, width: number, height: number): void
     onCameraFrame(callback: () => void): void
   }

   export interface ICameraOverlayComponent extends IBaseComponent {
     createOverlay(logger: ILoggerComponent.ILogger): ICameraOverlay
   }
   ```

2. In `src/adapters/camera-overlay/component.ts`, export these constants and pure functions:
   - `OVERLAY_SIZES: readonly OverlaySize[] = ['small', 'large']`
   - `DEFAULT_OVERLAY_LAYOUT: OverlayLayout = { x: 0, y: 1, size: 'small' }`
   - `overlayRect(layout, width, height): OverlayRect`, implementing the geometry in `plan.md` "Wire contract" exactly. `RATIO = { small: 0.15, large: 0.25 }`, `MARGIN_RATIO = 0.02`. It treats `layout.x`/`layout.y` outside `[0, 1]` as clamped. It returns `d = 0` when the computed diameter is `< 2`.
   - `blendPatch(i420, width, height, patch, rect): void`. It blends in place.
     - Y plane: for each patch pixel with `a = alpha[j*d+i] > 0`, `Y = (patchY*a + Y*(255-a) + 127) / 255 | 0`.
     - U and V planes (offsets from `i420FrameSize` layout: `ySize = w*h`, `uvW = (w+1)>>1`): for each chroma sample, `a` is the mean of the four patch alphas in its 2×2 block, and the same formula applies.
     - It skips any pixel outside the frame bounds.
     - It is a no-op when `rect.d === 0`.

3. In the same file, implement `createCameraOverlay(logger): ICameraOverlay` as a closure.
   - **State:** `layout` (starts as a copy of `DEFAULT_OVERLAY_LAYOUT`); `stream` and `reader`; `running`; `lastAcceptedAt`; `fullCamCanvas` plus its dimensions; `cameraSeq` (increments on every accepted frame); `hasFrame`; `patch: OverlayPatch | null`; `patchKey` (`${cameraSeq}:${d}`); `callbacks: Array<() => void>`.
   - **`start(track)`:**
     - Replace any running reader: detach it (`const old = reader; reader = null`) and cancel `old` with `.catch(() => undefined)`, without awaiting.
     - Then `stream = new VideoStream(track)`, `reader = stream.getReader()`, `running = true`, `hasFrame = false`, and launch `void pump(reader)`.
     - The pump takes its reader as a parameter and loops only while `running && reader === ownReader`. It re-checks that condition right after each `await ownReader.read()` resolves, before touching any state. That way a replaced or stopped reader's pump exits without processing a late frame.
     - The pump loop mirrors `camera-overlay-compositor/component.ts:61-78`: read, apply the 20 fps throttle, then `frame.convert(VideoBufferType.RGBA)`, then `validateMediaDimensions(…, 'camera-overlay')`.
     - On a dimension error, `logger.warn` and `continue`.
     - Otherwise `putImageData` into `fullCamCanvas` (reallocated only when the dimensions change), set `hasFrame = true`, increment `cameraSeq`, and call every callback, each inside its own `try/catch` with `logger.warn`, so one throwing callback never ends the pump.
     - Wrap the loop in `try/catch` and `logger.warn` on error.
   - **`stop()`:** first detach all state synchronously: `const old = reader`, set `running = false`, `hasFrame = false`, and null `reader`, `stream`, `fullCamCanvas` and `patch`. Only then `await old?.cancel().catch(() => undefined)`. A `start()` that runs during the await is therefore never wiped. It is idempotent.
   - **`setLayout(l)`:** store a copy, with `x`/`y` clamped to `[0, 1]`. `getLayout()` returns a copy.
   - **`isActive()`:** returns `running && hasFrame`.
   - **`stamp(i420, w, h)`:**
     - Return immediately if `!isActive()`.
     - Compute `rect = overlayRect(layout, w, h)` and return if `rect.d === 0`.
     - If `patchKey !== \`${cameraSeq}:${rect.d}\``, rebuild the patch:
       - `clearRect(0, 0, d, d)` on a reused `d×d` canvas, then draw the centre-square crop of `fullCamCanvas` into it inside an `arc` clip (port of `:129-142`, destination `0,0,d,d`). The clear keeps the anti-aliased edge from accumulating to opaque;
       - `getImageData(0, 0, d, d)`;
       - `alpha` = every 4th byte;
       - `y`/`u`/`v` = the planes sliced from `rgbaToI420(Buffer.from(imageData.data.buffer), d, d)`.
     - Then call `blendPatch(i420, w, h, patch, rect)`.
   - **`onCameraFrame(cb)`:** push the callback.

4. Export `createCameraOverlayComponent(): ICameraOverlayComponent` returning `{ createOverlay: createCameraOverlay }`. It is synchronous, like `createCameraOverlayCompositorComponent`.

5. `src/adapters/camera-overlay/index.ts` re-exports `createCameraOverlayComponent`, `DEFAULT_OVERLAY_LAYOUT`, `OVERLAY_SIZES`, `overlayRect` and `blendPatch` from `./component`, and the types from `./types`.

6. Write `test/unit/camera-overlay.spec.ts`. Use `jest.mock('@livekit/rtc-node', () => ({ VideoStream: jest.fn(), VideoBufferType: { RGBA: 0, I420: 5 } }))`, and use the real canvas. Cover:
   - `overlayRect` on 960×540:
     - small at `(0,1)` gives `{ left: 18, top: 376, d: 144 }` (margin 19, centre clamped to (91, 449));
     - large at `(1,0)` gives `{ left: 700, top: 18, d: 240 }` (centre clamped to (821, 139));
     - an out-of-range `x = 5` clamps like `x = 1`;
     - a short 960×100 frame caps small `d` to `62`;
     - every `left`, `top` and `d` is even.
   - `blendPatch`:
     - a 4×4 patch with alpha 255 overwrites Y and U/V at the rect;
     - alpha 0 leaves the frame untouched;
     - alpha 128 lands between the two values;
     - a rect partly outside the frame does not throw and writes only in-bounds pixels.
   - `createCameraOverlay` with a mocked `VideoStream` whose `getReader().read` resolves one fake frame and then pends forever. The fake frame's `convert` returns `{ width: 64, height: 48, data: <solid red RGBA> }`.
     - `isActive()` is false before the first frame and true after flushing microtasks.
     - `onCameraFrame` callbacks fire.
     - `stamp` changes Y at the bubble centre and leaves the frame corners unchanged.
     - `stop()` makes `isActive()` false, and `stamp` is then a no-op.
     - `start(trackA)`, then `stop()` without awaiting, then `start(trackB)`, then flush: the overlay is active from trackB's frames, and trackA's reader was cancelled.
     - A throwing `onCameraFrame` callback logs a warning, and the next frame still reaches the other callbacks.
     - The patch edge alpha is stable: with `jest.spyOn(Date, 'now')`, feed two camera frames with identical content at least 50 ms apart (past the 20 fps throttle). Assert that `onCameraFrame` fired twice, which proves `cameraSeq` advanced and the patch was rebuilt. Then stamp a fresh copy of the same base frame after each; the two results are byte-identical.
     - A frame with `width: 99999` from `convert` is dropped and triggers `logger.warn`.

## Edge cases

| Scenario | Handling |
|---|---|
| Camera frame arrives faster than 20 fps | Dropped before `convert` (throttle). |
| Camera resolution changes mid-stream | `fullCamCanvas` is reallocated. No abort. |
| Camera frame dimensions invalid (>7680, non-integer) | `logger.warn`, frame dropped, no allocation. |
| `stamp` called before any camera frame | No-op (`isActive()` false). |
| Output width changes between calls | `d` changes, so `patchKey` misses and the patch is rebuilt. |
| `start` called twice | Old reader cancelled, new one used. |

## Verification

```sh
npx --yes yarn@1.22.22 lint:fix && npx --yes yarn@1.22.22 typecheck && npx --yes yarn@1.22.22 lint
npx --yes yarn@1.22.22 test test/unit/camera-overlay.spec.ts
npx --yes yarn@1.22.22 test
git diff --quiet HEAD -- yarn.lock package.json
```

## Completion criteria

- The four new files exist, and the exported names and signatures match step 1 exactly.
- The new spec passes and covers every bullet in step 6. The full suite passes.
- No file outside the write ownership changed. `camera-overlay-compositor/` is untouched.

## Learning output

Write only `docs/specs/loom-overlay-runtime/learnings/phase-2.json` using plan-plus `docs/learning-schema.md` (schema v2, `scope: "project"`).
