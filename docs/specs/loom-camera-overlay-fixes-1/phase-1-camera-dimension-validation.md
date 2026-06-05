# Phase 1: Camera frame dimension validation

## Dependencies

- None (can run in parallel with Phases 2–5)

## Goal

Reject (or fail closed on) remote camera frames whose dimensions exceed a hard cap, so an attacker who can act as a presenter cannot trigger arbitrarily large native canvas / `Buffer.from(rgba.data)` allocations or feed unsafe values into ffmpeg `-s WxH` argv. Closes the High-severity DoS finding and the Medium-severity ffmpeg-argv finding from `security-review.md`.

## Files to modify (2)

| File | Change |
|------|--------|
| `src/adapters/video-compositor/component.ts` | Add `validateMediaDimensions` helper; invoke it on the pre-read camera frame and on every camera pump frame; cap before `-s WxH` argv. |
| `src/adapters/camera-overlay-compositor/component.ts` | Invoke `validateMediaDimensions` on each frame's `rgba` dimensions before any canvas allocation in `composeFrame`. |

## Steps

### 1. `src/adapters/video-compositor/component.ts` — add `validateMediaDimensions` helper

Insert a new exported helper directly after the existing `validateFilterParam` function (which currently ends at line 47, immediately before the `const SIZE_RATIO` declaration). The helper centralizes the dimension cap used by every remote-media boundary; the comment cross-references the security review. AFTER:

```typescript
/**
 * Validates remote-media (camera/video) frame dimensions before they are used
 * for resource allocation (canvas/buffer) or interpolated into ffmpeg argv.
 *
 * Mirrors `validateFilterParam`'s 7680 cap but throws a stable error reason
 * (`camera-resolution-invalid`) so callers can surface it as a typed compositor
 * error rather than a raw OOM/argv parse failure. See `security-review.md`
 * (High — Unbounded camera frame size enables memory DoS).
 *
 * @throws {Error} If width or height is not a positive integer ≤ max.
 */
export function validateMediaDimensions(width: number, height: number, ctx: string, max = 7680): void {
  if (!Number.isInteger(width) || width < 1 || width > max) {
    throw new Error(`Invalid media dimensions ${ctx}: width=${width}, must be integer 1-${max}`)
  }
  if (!Number.isInteger(height) || height < 1 || height > max) {
    throw new Error(`Invalid media dimensions ${ctx}: height=${height}, must be integer 1-${max}`)
  }
}
```

### 2. `src/adapters/video-compositor/component.ts` — validate the pre-read camera frame

Inside `readFirstCameraFrame` (around line 296, immediately after the existing `const rgba = value.frame.convert(VideoBufferType.RGBA)`), call the new helper before constructing the return value. The validation must run before `Buffer.from(rgba.data)` allocates `4 * width * height` bytes. AFTER:

```typescript
      const rgba = value.frame.convert(VideoBufferType.RGBA)
      validateMediaDimensions(rgba.width, rgba.height, 'readFirstCameraFrame')
      return {
        width: rgba.width,
        height: rgba.height,
        firstFrameRgba: Buffer.from(rgba.data)
      }
```

### 3. `src/adapters/video-compositor/component.ts` — validate camera dimensions in the pump loop

Inside `startPlayback`'s camera-frame pump loop (around line 677, inside the `while (isPlaying)` block, immediately after the existing resolution-changed check that compares against `camWidth`/`camHeight`), call `validateMediaDimensions(value.frame.width, value.frame.height, 'cameraPump')` before `value.frame.convert(VideoBufferType.RGBA)`. On failure, log a warning and call `abortPlayback('camera-resolution-invalid', publisher, slideBuffer, slideWidth, slideHeight)` then `break`. AFTER:

```typescript
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
```

### 4. `src/adapters/video-compositor/component.ts` — add `camera-resolution-invalid` to the compositor error reason union

`abortPlayback`'s first parameter is `CompositorErrorReason`, declared in `src/adapters/video-compositor/types.ts`. Open that types file and add `'camera-resolution-invalid'` to the `CompositorErrorReason` union (alongside `'camera-resolution-changed'`). Also add a matching entry to the `COMPOSITOR_ERROR_MESSAGES` lookup table in `src/logic/presentation-manager/component.ts` (search for `COMPOSITOR_ERROR_MESSAGES` to locate the const); message text: `'Camera resolution invalid'`.

### 5. `src/adapters/video-compositor/component.ts` — validate before ffmpeg `-s WxH`

Inside `startPlayback`, immediately after the line `cameraInit = await readFirstCameraFrame(presenterCamera.track)` (around line 521), insert a second `validateMediaDimensions(cameraInit.width, cameraInit.height, 'ffmpegCameraInput')` call. This is defense-in-depth: step 2 already validated, but the camera-pump path's `cameraInit.width`/`cameraInit.height` flow directly into the `-s ${cameraInit.width}x${cameraInit.height}` argv (line 583), so the closest-to-use check is here. AFTER:

```typescript
      let cameraInit: { width: number; height: number; firstFrameRgba: Buffer } | null = null
      if (presenterCamera) {
        cameraInit = await readFirstCameraFrame(presenterCamera.track)
        validateMediaDimensions(cameraInit.width, cameraInit.height, 'ffmpegCameraInput')
      }
```

### 6. `src/adapters/camera-overlay-compositor/component.ts` — validate camera frame in `composeFrame`

Add an import for `validateMediaDimensions` from `'../video-compositor/component'` at the top of the file (alongside the existing imports). Then inside `composeFrame` (around line 78), immediately after `const rgba = cameraFrame.convert(VideoBufferType.RGBA)`, call `validateMediaDimensions(rgba.width, rgba.height, 'composeFrame')`. On failure, the error propagates out of `pump()`'s `try` block and is logged by the existing catch — no extra handling needed; the compositor stops feeding frames on a bad frame, which is the desired behavior. AFTER:

```typescript
    // Force the LiveKit-side frame into RGBA so we can draw it via Canvas2D.
    const rgba = cameraFrame.convert(VideoBufferType.RGBA)
    validateMediaDimensions(rgba.width, rgba.height, 'composeFrame')
```

### 7. `test/unit/build-filter-complex.spec.ts` — add `validateMediaDimensions` unit tests

In the same test file that already exercises `validateFilterParam`, add a `describe('validateMediaDimensions')` block covering: (a) accepts a 1280×720 frame, (b) accepts 7680×7680, (c) rejects 7681×720, (d) rejects 0×720, (e) rejects NaN/Infinity/non-integer, (f) the error message includes the `ctx` argument. Use the same Jest expectations style as the existing `validateFilterParam` tests. If you cannot locate matching style examples, AFTER:

```typescript
import { validateMediaDimensions } from '../../src/adapters/video-compositor/component'

describe('validateMediaDimensions', () => {
  it('accepts a standard 1280x720 frame', () => {
    expect(() => validateMediaDimensions(1280, 720, 'test')).not.toThrow()
  })
  it('accepts the max 7680x7680 frame', () => {
    expect(() => validateMediaDimensions(7680, 7680, 'test')).not.toThrow()
  })
  it('rejects a width above the cap', () => {
    expect(() => validateMediaDimensions(7681, 720, 'test')).toThrow(/width=7681/)
  })
  it('rejects a height of zero', () => {
    expect(() => validateMediaDimensions(1280, 0, 'test')).toThrow(/height=0/)
  })
  it('rejects NaN', () => {
    expect(() => validateMediaDimensions(NaN, 720, 'test')).toThrow()
  })
  it('rejects a non-integer width', () => {
    expect(() => validateMediaDimensions(1280.5, 720, 'test')).toThrow()
  })
  it('includes the ctx string in the error message', () => {
    expect(() => validateMediaDimensions(99999, 720, 'pumpCtx')).toThrow(/pumpCtx/)
  })
})
```

## Verification

```bash
yarn typecheck && yarn test test/unit/build-filter-complex.spec.ts
```

Then a focused check that the camera-overlay-compositor still compiles with its new import:

```bash
yarn typecheck
```

## Learnings (post-execution)

After running this phase, append to `learnings/phase-1.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
