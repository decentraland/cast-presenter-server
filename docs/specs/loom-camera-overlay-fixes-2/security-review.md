# Security review — loom-camera-overlay-fixes-2

Generated 2026-05-21 by `/plan-plus:review` (red-team agent).

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

## Iteration-2 changes — verification

| Change | Security verdict | Evidence |
|---|---|---|
| `_cameraStream` write-only variable removed | No regression. `VideoStream` lifetime was never gated by this var; it is governed by `cameraReader.cancel()` which is preserved in both `stopPlayback` (`video-compositor/component.ts:494`) and `cleanup` (`:992`). No new leak surface. | Variable absent from `video-compositor/component.ts`; no other reader of the removed field anywhere in the tree. |
| Pre-spawn `validateMediaDimensions` (old `:562`) removed | No regression. Values interpolated into `-s ${cameraInit.width}x${cameraInit.height}` at `video-compositor/component.ts:621` originate from `readFirstCameraFrame`, which validates the converted RGBA frame dimensions at `:326` before returning. There is no mutation between validation and use. Argv-interpolation boundary stays closed. | `readFirstCameraFrame` calls `validateMediaDimensions(rgba.width, rgba.height, 'readFirstCameraFrame')` at `:326`; `cameraInit.width`/`.height` are assigned from those same `rgba.width`/`.height` values at `:328-329`. |
| Pump's per-frame `validateMediaDimensions` + try/catch (old `:732`) removed | No regression. The load-bearing equality check at `:720` (`value.frame.width !== camWidth || value.frame.height !== camHeight`) is preserved and now fully owns the per-frame check: any deviation from the validated initial dimensions calls `abortPlayback('camera-resolution-changed', …)`; matching dimensions equal already-validated values. ffmpeg input resolution can't change mid-stream, so this is the correct gate. | `video-compositor/component.ts:720-726`. The `camera-resolution-invalid` reason still exists in the type/message map (unused but harmless — dead path, not dead defense). |
| `startCameraOverlayPump` helper attached to `InternalSession` | No regression. Helper is set once at session creation (`presentation-manager/component.ts:516`), captured by closure over `cameraOverlayCompositor` + `publisherLogger`, and never reassigned. It does **not** touch any sub/unsub trust boundary — no `setSubscribed`, no LiveKit room operations, no participant filtering. It only constructs a camera-overlay compositor and calls `stopHeartbeat` + `overlay.start(…, /* I420 */ 5)`. The two call sites (active-branch at `:454`, `onEnd` at `:962`) both reach it after explicit guards, and the helper itself re-checks `overlayConfig` and `lastPresenterCameraTrack` before doing work. `publisherLogger` reuse resolves to the same logger object that was already used elsewhere — no new information surface. |
| Cross-cutting: argv injection, SSRF, subscription filter, dimension cap, RGBA copy, broadcast payload | All iter-1 fixes intact. `validateFilterParam` still gates `x/y/vw/vh/D/cx/cy` (`:542-545`, `:117-119`); `validateMediaDimensions` cap of 7680 still enforced at the boundary (`:60-67`, `:326`); presenter-only subscription filter and `RoomMetadataChanged` unsub still in `livekit-publisher/component.ts`; RGBA `Buffer.from(…)` copies preserved at the pump (`:728`); `broadcastError` payload still `{ code, message, videoIndex? }` (`:296-312`). |

## Section 1 — Vulnerabilities

No findings.

## Section 2 — Systemic Risk

No new patterns identified in this iteration. The previously-tracked ffmpeg stderr fragments in thrown `Remux failed` errors (`video-compositor/component.ts:279`) remain unchanged and remain on the deferred "Future work" list per `plan.md`; not re-flagged here per the review instructions.
