# Phase 1 — camera dimension validation

## 2026-05-21 — done
- `validateMediaDimensions` is exported from `src/adapters/video-compositor/component.ts`; `camera-overlay-compositor/component.ts` cross-imports it directly from the sibling adapter. The repo already has this kind of cross-adapter import (no shared `lib/` directory), so no refactor was needed.
- Adding a new `CompositorErrorReason` variant is a two-file change: the union in `src/adapters/video-compositor/types.ts` AND a corresponding entry in the `COMPOSITOR_ERROR_MESSAGES` table in `src/logic/presentation-manager/component.ts`. Forgetting the table entry is a TS error (the record is keyed on the union), so typecheck will catch it.
- Jest emits two "CustomGC open handles" warnings from `@livekit/rtc-node` + `@napi-rs/canvas` on every run — pre-existing, unrelated to this phase. Don't chase them.
