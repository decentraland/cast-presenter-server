# Phase 1 — video-compositor dead code

## 2026-05-21 — done
- Spec line numbers were exact (143/500/562/715/724-737/1008) — no drift; all six edits applied 1:1.
- `VideoStream` import in `src/adapters/video-compositor/component.ts:5` still needed (used by `readFirstCameraFrame`'s `stream: VideoStream` field + `new VideoStream(track)` at :312). Don't touch the import.
- After deleting the pump's `try`/`catch`, the surrounding `void (async () => { … })()` IIFE still has an outer `try`/`catch`/`finally` — no orphaned braces.
- `'camera-resolution-invalid'` union member in `types.ts` intentionally left in place (spec note 6).
- typecheck + lint + test all green (12 suites, 221 tests). Jest's worker-teardown `CustomGC` stack from `@napi-rs/canvas` appears post-summary but does not affect pass/fail.
