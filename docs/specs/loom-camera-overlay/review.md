# Code review — loom-camera-overlay

Generated 2026-05-21 by `/plan-plus:review`.

## Scope

Files reviewed (from spec phase files):
- src/adapters/camera-overlay-compositor/component.ts
- src/adapters/camera-overlay-compositor/index.ts
- src/adapters/camera-overlay-compositor/types.ts
- src/adapters/livekit-publisher/component.ts
- src/adapters/livekit-publisher/types.ts
- src/adapters/video-compositor/component.ts
- src/controllers/handlers/create-presentation-handler.ts
- src/logic/presentation-manager/component.ts
- src/logic/presentation-manager/types.ts
- test/integration/loom-overlay.spec.ts
- test/unit/build-filter-complex.spec.ts

## Section 1 — Findings

- **File + line**: `src/adapters/camera-overlay-compositor/types.ts:31-32` and `src/adapters/camera-overlay-compositor/component.ts:144-146`
- **Category**: dead code
- **Description**: `ICameraOverlayCompositor.getTrack()` was added in Phase 3 explicitly so that Phase 5 could "hand the track to ffmpeg," but Phase 5's actual implementation reads the track from `session.lastPresenterCameraTrack` instead (component.ts:885). The getter is never called from anywhere in the reviewed code (and `learnings/phase-5.md` confirms it: "we re-create a fresh compositor … The session's `lastPresenterCameraTrack` is the durable handle"). The method, its closure variable `currentTrack`, and the `currentTrack = track` / `currentTrack = null` mutations all support an unused public API.
- **Suggestion**: remove (`getTrack()` from the interface, `currentTrack` closure var, and the corresponding assignments in `start`/`stop`).

- **File + line**: `src/controllers/handlers/create-presentation-handler.ts:46-48`
- **Category**: unnecessary abstraction
- **Description**: `parseOverlayConfigFromFields` is a one-line wrapper that just casts `Record<string, string>` to `Record<string, unknown>` and delegates to `parseOverlayConfigFromBody`. Its single caller (line 127) could invoke the body parser directly with the same cast, or — better — `parseOverlayConfigFromBody` could be widened to accept the union since it only reads two string fields.
- **Suggestion**: inline.

- **File + line**: `src/adapters/camera-overlay-compositor/component.ts:71-122` (specifically the `camCanvas` allocation at line 95 + draw at 116)
- **Category**: redundant pattern
- **Description**: `composeFrame` allocates three canvases per frame (`canvas`, `camCanvas`, `fullCam`). `camCanvas` is an intermediate that holds the cropped/scaled camera, then is immediately drawn once onto the clipped main canvas. The same crop-and-scale `drawImage(fullCam, sx, sy, sw, sh, dx, dy, dw, dh)` can be done directly on the main canvas inside the clip path, eliminating one full canvas allocation + one extra copy per frame. (Phase 3's verification step already flagged per-frame `createCanvas` allocations as a hot path; this drops one of the three.)
- **Suggestion**: simplify (draw `fullCam` directly inside the circular clip with the crop-rect form of `drawImage`).

- **File + line**: `src/adapters/camera-overlay-compositor/component.ts:52-53`
- **Category**: redundant pattern
- **Description**: `pump()` opens with `if (!reader) return`, but `start()` assigns `reader = stream.getReader()` synchronously immediately before `void pump(onFrame)`. The reader can never be null on entry; the guard is dead-on-arrival.
- **Suggestion**: remove the guard (or `assert reader` if you prefer a runtime claim).

- **File + line**: `src/logic/presentation-manager/component.ts:229-236`
- **Category**: unnecessary abstraction
- **Description**: `setupSlideOutput` takes `cameraOverlayCompositor: ICameraOverlayCompositorComponent` and `logger: ILoggerComponent.ILogger` as parameters even though it's a closure-internal function and both are already in scope from the enclosing `createPresentationManager`. `learnings/phase-4.md` notes this as deliberate ("makes the helper movable outside the closure later") — but that's exactly an over-engineering signal: the parameters serve a hypothetical future move, not today's caller. Every call site (component.ts:525, 682, 1020) passes the same closure references.
- **Suggestion**: simplify (drop the two parameters; rely on closure capture).

- **File + line**: `src/logic/presentation-manager/component.ts:422, 456`
- **Category**: redundant pattern
- **Description**: Both restart-on-camera-flip branches gate on `session.videoState === 'playing' && session.pausedVideoIndex >= 0`. `pausedVideoIndex` is set to the current video index at line 871, *before* `videoState` is flipped to `'playing'` at line 928, so any state-machine transition through `'playing'` guarantees `pausedVideoIndex >= 0`. The second clause is always true when the first one is.
- **Suggestion**: simplify (drop `&& session.pausedVideoIndex >= 0`; keep the comment if the intent is "we know which video to resume").

- **File + line**: `src/logic/presentation-manager/component.ts:386-473` (the presenter-camera handler)
- **Category**: redundant pattern
- **Description**: The two restart-on-flip blocks (active branch at 420-432, inactive branch at 455-466) are byte-identical except for the log message ("activate" / "deactivate"). About 12 duplicated lines per branch.
- **Suggestion**: simplify (extract a local `restartPlaybackOnCameraFlip(reason: 'activate' | 'deactivate')` helper).

- **File + line**: `src/adapters/video-compositor/component.ts:286-309` (`readFirstCameraFrame`) combined with `src/adapters/video-compositor/component.ts:668-705` (the camera pump that opens a *second* `VideoStream` on the same track)
- **Category**: redundant pattern
- **Description**: `startPlayback` opens a `VideoStream` to read exactly one frame (to learn dimensions), cancels it, then opens a brand-new `VideoStream` on the *same* `RemoteVideoTrack` to start the actual pump. Two stream constructions, two reader cancellations, and an artificial dependency on the camera delivering its first frame before ffmpeg can even spawn. Phase 5's design comment ("ffmpeg needs `-s WxH` at spawn time") justifies needing the dimensions, but not the second VideoStream — the first reader could be kept open and reused for the pump (writing its first frame straight through). The current shape is a literal interpretation of the spec snippet rather than a minimal implementation.
- **Suggestion**: simplify (hold the first stream/reader open and reuse it for the pump; drop the dual construction).

- **File + line**: `src/logic/presentation-manager/types.ts:18-33`
- **Category**: over-engineering
- **Description**: `overlayConfig` was added as an optional field on the *public* `PresentationSession` interface, but the field is never read outside the `InternalSession` machinery (it's not included in `PresentationInfo` or `PresentationState`, which are the only types crossing the public boundary). The public interface now advertises a session-internal knob.
- **Suggestion**: simplify (move `overlayConfig` to `InternalSession` only; keep `OverlayConfig`/`OverlayCorner`/`OverlaySize` exported for the handler).

## Section 2 — Architectural Opportunities

- **Title**: Hoist canvas allocations out of the per-frame hot path
- **Problem**: `camera-overlay-compositor/component.ts` `composeFrame()` allocates three `Canvas` objects per frame (`canvas`, `camCanvas`, `fullCam`) at the configured frame rate (20 fps). On a 1920×1080 slide this is ~24 MB/frame of fresh `getImageData` output plus three native canvas allocations per tick — exactly the path Phase 3's verification budget flagged. Phase 3 deliberately deferred the optimization; with Phase 5 now exercising the full pipeline, the cost is measurable.
- **Proposed approach**: Hoist the slide canvas, the cam-sub-canvas, and the `fullCam` canvas into closure state, sized once on `start()`/`updateSlide()`. Reuse `ctx.putImageData` on the same backing buffers across frames. Reset the clip via `ctx.save()`/`restore()` only.
- **Estimated impact**: Drop ~3 native canvas constructions, ~3 `getImageData` round-trips, and ~24 MB of garbage per frame. At 20 fps that's ~480 MB/s of GC pressure removed from the steady-state slide+camera path.
- **Risk**: low — pure refactor inside one adapter; existing call-site contract is unchanged. Smoke test (`composeFrame` × 200) will catch regressions if Phase 3's deferred benchmark spec is added.
- **Suggested PR scope**: `src/adapters/camera-overlay-compositor/component.ts` only; optionally add the deferred `test/unit/camera-overlay-compositor.spec.ts` benchmark to lock the budget.
