# Phase 1: Remove dead code in `video-compositor/component.ts`

## Dependencies

- None

## Files to modify (1)

| File | Change |
|------|--------|
| `src/adapters/video-compositor/component.ts` | Delete `_cameraStream` and three assignment sites; delete two redundant `validateMediaDimensions` calls. |

## Steps

### 1. Delete the `_cameraStream` declaration

At line 143, delete the entire line declaring the write-only variable. The literal token at that line is `_cameraStream: VideoStream | null = null` (the underscore prefix makes it locally unique — no other identifier in the file starts with `_camera`). Remove the full `let _cameraStream: VideoStream | null = null` statement.

### 2. Delete the `_cameraStream = null` assignment inside `stopPlayback`

At line 500, delete the `_cameraStream = null` statement. The cited literal `_cameraStream = null` is locally unique (only three sites in the whole file assign this variable; this one sits inside `stopPlayback`'s cleanup block).

### 3. Delete the `_cameraStream = cameraInit.stream` assignment in `startPlayback`

At line 715, delete the `_cameraStream = cameraInit.stream` statement. The line sits immediately above `cameraReader = cameraInit.reader`; the surrounding-context phrase is "right before `cameraReader = cameraInit.reader`." The cited literal `_cameraStream = cameraInit.stream` is locally unique.

### 4. Delete the `_cameraStream = null` assignment inside `cleanup`

At line 1008, delete the `_cameraStream = null` statement. The surrounding-context phrase is "inside the `cleanup` function's null-out block." The cited literal `_cameraStream = null` is unique at this location (different from step 2 because step 2 lives inside `stopPlayback`).

### 5. Delete the pre-spawn redundant `validateMediaDimensions` call

At line 562, delete the entire statement `validateMediaDimensions(cameraInit.width, cameraInit.height, 'ffmpegCameraInput')`. The cited literal `'ffmpegCameraInput'` is locally unique (no other `validateMediaDimensions` call in the file passes this context string). The block becomes:

```typescript
      if (presenterCamera) {
        cameraInit = await readFirstCameraFrame(presenterCamera.track)
      }
```

Note: `readFirstCameraFrame` at `:327` already validates the same `width`/`height` values via `validateMediaDimensions(rgba.width, rgba.height, 'readFirstCameraFrame')`, and no mutation happens between the two calls — leave the `:327` site untouched.

### 6. Delete the camera-pump unreachable `validateMediaDimensions` + its `try`/`catch`

In the camera pump's `void (async () => { … })()` IIFE near lines 731-737, delete the `try`/`catch` block that wraps `validateMediaDimensions(value.frame.width, value.frame.height, 'cameraPump')`. The cited literal `'cameraPump'` is locally unique. AFTER (the surrounding `if` equality check at line 724 and the `convert` call at the former line 738 stay; the deletion is the seven lines between them):

```typescript
              if (value.frame.width !== camWidth || value.frame.height !== camHeight) {
                logger.warn(
                  `Camera resolution changed (${camWidth}x${camHeight} -> ${value.frame.width}x${value.frame.height}), aborting`
                )
                abortPlayback('camera-resolution-changed', publisher, slideBuffer, slideWidth, slideHeight)
                break
              }
              const rgba = value.frame.convert(VideoBufferType.RGBA)
```

Notes:
- Do **not** remove the `'camera-resolution-invalid'` reason from `types.ts` even though this is now the only deletion site that ever fired it — leave the union member in place; that's a separate cleanup outside this fix-spec's scope.
- Do **not** modify the equality check at the prior `if`; it is the load-bearing guard for "ffmpeg can't change input resolution mid-stream."

## Verification

```bash
yarn typecheck
yarn lint
yarn test
```

Sanity-check that the file no longer contains any reference to `_cameraStream`:

```bash
grep -n "_cameraStream" src/adapters/video-compositor/component.ts
# (expect no output)
```

And that exactly one `validateMediaDimensions` call remains in this file (the boundary at `readFirstCameraFrame`):

```bash
grep -c "validateMediaDimensions(" src/adapters/video-compositor/component.ts
# expect 2 — one declaration (line 60) + one call site (line 327)
```
