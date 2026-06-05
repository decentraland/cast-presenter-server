# Phase 5 — defense-in-depth lows

## 2026-05-21 — done
- Step 7 (RGBA buffer copies) was a no-op: Phase 3 already landed the `.slice(...)` copies for both slide and camera `ImageData` in `composeFrame`, and `readFirstCameraFrame`/cameraPump in `video-compositor` were already using `Buffer.from(rgba.data)` (Buffer.from on a Uint8Array copies). Nothing to change there.
- Dropping `videoUrl` from `broadcastError` payloads breaks `test/unit/presentation-manager.spec.ts` — two assertions at lines ~1086 and ~1162 use `expect.objectContaining({ ..., videoUrl: 'https://example.com/v.mp4' })`. Update both to remove the `videoUrl` key. `objectContaining` would happily pass without it once removed (no `not.objectContaining` needed for the spec's compile-and-pass goal).
- Phase 3's leftover `cameraStream` unused-var warning: all 4 references are file-local in `video-compositor/component.ts`. Rename to `_cameraStream` (matches the project's `^_/u` allowlist pattern) — preserves the resource-ownership tracking intent without touching call surfaces. Lint exits 0 after the rename.
- `logger.debug` is available on the `ILoggerComponent.ILogger` used in `video-compositor` — no signature mismatch when splitting the ffmpeg stderr log into warn (`{ code }`) + debug (`{ stderr }`).
