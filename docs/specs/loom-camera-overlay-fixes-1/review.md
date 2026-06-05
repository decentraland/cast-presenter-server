# Code review — loom-camera-overlay-fixes-1

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

- **File**: `src/adapters/video-compositor/component.ts:143, 500, 715, 1008`
  **Category**: dead code
  **Description**: `_cameraStream` is write-only after the Phase 3 reuse rewiring. It is declared (`let _cameraStream: VideoStream | null = null`), assigned in `startPlayback` (`_cameraStream = cameraInit.stream`), and nulled in both `stopPlayback` and `cleanup`, but never read anywhere in the file. The underscore prefix and the `learnings/phase-3.md` note acknowledge this — it was kept "for resource-ownership tracking" but no code ever consults the variable; the `VideoStream` lifecycle is driven entirely through the `cameraReader.cancel()` call.
  **Suggestion**: Delete the variable declaration and all three assignment sites. If a future need to dispose the `VideoStream` separately from the reader arises, reintroduce it then.

- **File**: `src/adapters/video-compositor/component.ts:562`
  **Category**: redundant pattern
  **Description**: `validateMediaDimensions(cameraInit.width, cameraInit.height, 'ffmpegCameraInput')` re-runs the exact same validation that `readFirstCameraFrame` performed at line 327 (`validateMediaDimensions(rgba.width, rgba.height, 'readFirstCameraFrame')`) on the same values, before returning. There is no mutation or coercion between the two calls — the second is dead defense.
  **Suggestion**: Drop the second call. The validation lives at the boundary where dimensions enter the system (`readFirstCameraFrame`), which is where the security review wanted it.

- **File**: `src/adapters/video-compositor/component.ts:724-737`
  **Category**: redundant pattern
  **Description**: In the camera pump, the `value.frame.width !== camWidth || value.frame.height !== camHeight` check (line 724) already aborts on any dimension change. The subsequent `validateMediaDimensions(value.frame.width, value.frame.height, 'cameraPump')` call (line 732) is therefore unreachable in any failure mode: if width/height equal `camWidth`/`camHeight` (which were validated at line 327), the bounds check trivially passes; if they differ, the prior branch already broke out. The `camera-resolution-invalid` reason is not reachable from the pump.
  **Suggestion**: Either drop the second `validateMediaDimensions` + its try/catch in the pump, or drop the equality check (keeping only the validation) — the equality check is the load-bearing one for "ffmpeg can't change input resolution mid-stream," so prefer to delete the validation.

- **File**: `src/logic/presentation-manager/component.ts:422-433` vs `932-958`
  **Category**: redundant pattern
  **Description**: The camera-overlay startup sequence is duplicated between the `setPresenterCameraTrackHandler` 'active' branch and the `compositor.onEnd` callback in `playVideoSession`. Both blocks: (1) call `cameraOverlayCompositor.createCompositor(...)`, (2) assign to `session.cameraOverlayCompositor`, (3) call `session.publisher.stopHeartbeat()`, (4) call `overlay.start(track, lastFrameBuffer, lastFrameWidth, lastFrameHeight, push-as-I420-callback)`. The push callback's `/* I420 */ 5` literal is duplicated verbatim. This is the same kind of duplication Phase 4 extracted for `restartPlaybackOnCameraFlip`.
  **Suggestion**: Extract a `startCameraOverlayPump(session, logger)` helper that handles creating the compositor, stopping the heartbeat, and invoking `overlay.start` with the standard push callback. Both call sites become a single helper invocation guarded by their own preconditions.

- **File**: `src/logic/presentation-manager/component.ts:415, 939-941`
  **Category**: redundant pattern
  **Description**: The two `createCompositor` call sites pick logger names inconsistently: the 'active' branch uses `publisherLogger` (named `livekit-publisher:${id}`), while the onEnd restart re-derives `logs.getLogger(\`livekit-publisher:${session.id}\`)` inline. Same logger, two construction paths.
  **Suggestion**: If/when the duplication in the preceding finding is collapsed, reuse a single logger reference (the closure-captured `publisherLogger`) rather than re-resolving via `logs.getLogger` on each restart.

## Section 2 — Architectural Opportunities

(omitted — no recurring pattern beyond the duplication already flagged above qualifies.)
