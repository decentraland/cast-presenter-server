# Code review — loom-camera-overlay-fixes-2

Generated 2026-05-21 by `/plan-plus:review`.

## Scope
Files reviewed:
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/camera-overlay-compositor/component.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/camera-overlay-compositor/types.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/livekit-publisher/component.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/livekit-publisher/types.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/video-compositor/component.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/video-compositor/types.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/controllers/handlers/create-presentation-handler.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/logic/presentation-manager/component.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/logic/presentation-manager/types.ts

## Section 1 — Findings

No findings.

Phase 1 cleanly removed `_cameraStream` (no remaining references in
`video-compositor/component.ts`) and the two redundant
`validateMediaDimensions` call sites. The only remaining call in the file is
the boundary check at `readFirstCameraFrame` (`:326`), matching the spec's
verification grep. The `'camera-resolution-invalid'` union member is left in
place as `types.ts:48` per the plan's explicit "out of scope" note (will
become orphaned in any future cleanup, but not re-flagging since the plan
called it out).

Phase 2 collapsed the two `createCompositor → stopHeartbeat → overlay.start`
duplications into `startCameraOverlayPump` and folded out the inline
`logs.getLogger(\`livekit-publisher:${session.id}\`)` reconstruction; both
call sites now use the closure-captured `publisherLogger`. The design
deviation (helper exposed via `session.startCameraOverlayPump` because
`playVideoSession` is a sibling of `createPresentation`, not nested) is
documented in `learnings/phase-2.md` and is the minimum bridge needed; the
helper's per-call `(session)` arg is mildly redundant with the captured
closure but not enough to flag against the "meaningfully matters" bar.

The systemic-risk note about ffmpeg stderr fragments in thrown error
messages (`video-compositor/component.ts:279` "Remux failed", logged at
`presentation-manager/component.ts:789`) remains, but it is explicitly
listed under Future work in `plan.md` and is therefore not re-flagged here.
