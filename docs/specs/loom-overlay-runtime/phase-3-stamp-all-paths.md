# Phase 3: Stamp all output paths

## Outcome

Every session owns one `ICameraOverlay` (phase 2), and it stamps every frame the bot publishes:
- slides and paused frozen frames, driven by camera frames;
- playing video, where ffmpeg frames pass through a `decorateFrame` callback.

ffmpeg is back to a two-input graph with no camera input. The old canvas compositor, the ffmpeg camera plumbing, the restart on camera change, and `OverlayConfig` are deleted. The bubble shows in every session whenever a presenter camera is active, at `DEFAULT_OVERLAY_LAYOUT`. Phase 4 adds runtime layout changes.

## Dependencies

Phase 2.

## Write ownership

- `src/adapters/video-compositor/component.ts`, `src/adapters/video-compositor/types.ts`
- `src/adapters/camera-overlay-compositor/`: delete the whole directory
- `src/logic/presentation-manager/component.ts`, `src/logic/presentation-manager/types.ts`
- `src/controllers/handlers/create-presentation-handler.ts`
- `src/components.ts`, `src/types.ts`
- `test/unit/presentation-manager.spec.ts`, `test/unit/build-filter-complex.spec.ts`, `test/unit/video-compositor.spec.ts`

## Context

Base sha `2c6cdd12e0267306818af9540eede56d67203655`. Phases 1–2 do not touch these files except for dependency versions, so the anchors hold. Re-grep each cited token before editing.

**Reuse from phase 2** (`src/adapters/camera-overlay/`): `createCameraOverlayComponent`, `ICameraOverlay`, `ICameraOverlayComponent` and `DEFAULT_OVERLAY_LAYOUT`.

`src/adapters/video-compositor/component.ts`:
- `:19` `import type { OverlayConfig }`; `:22` `RemoteVideoTrack, VideoFrame as RtcVideoFrame`; `:5` `VideoBufferType, VideoStream`.
- `:69-74` `SIZE_RATIO` / `MARGIN_RATIO`.
- `:76-134` `buildFilterComplex`: its no-camera branch at `:90-92` is the target shape.
- `:143` `let cameraReader`; `:305-342` `readFirstCameraFrame`; `:493-498` camera reader cancel inside `stopPlayback`.
- `:536` the `presenterCamera?` parameter; `:547-560` `cameraInit`.
- `:586-598` the `buildFilterComplex` call; `:610-627` `cameraInputArgs`; `:653` `...cameraInputArgs`; `:666-669` `stdioConfig`.
- `:689-756` the camera-frame pump.
- `:887-895` the frame push: `lastPushedFrame = {…}` then `publisher.pushFrame(frameCopy, …, VIDEO_BUFFER_TYPE_I420)`.
- `:988-993` camera reader cancel inside `cleanup()`.

`src/adapters/video-compositor/types.ts`:
- `:2,4` imports; `:45-48` `camera-resolution-changed` / `camera-resolution-invalid`; `:56-66` the `startPlayback` signature.

`src/logic/presentation-manager/component.ts`:
- `:15` `ICameraOverlayCompositor` import; `:10` the `OverlayConfig` import; `:21` `RemoteVideoTrack`.
- `:38-76` `InternalSession`: `cameraOverlayCompositor`, `presenterCameraActive`, `lastPresenterCameraTrack`, `startCameraOverlayPump` at `:42-58`.
- `:103-109` `COMPOSITOR_ERROR_MESSAGES`, which lists the two camera reasons at `:107-108`.
- `:160-183` the components `Pick` and destructure, including `'cameraOverlayCompositor'`.
- `:236-271` `setupSlideOutput`.
- `:314-321` the `createPresentation` signature, with `overlayConfig?` at `:320`.
- `:390-408` `restartPlaybackOnCameraFlip`; `:410-432` `startCameraOverlayPump`; `:434-483` `setPresenterCameraTrackHandler`.
- `:497-536` the session literal (`overlayConfig,` `cameraOverlayCompositor: null,` … `startCameraOverlayPump,` at `:512-516`), `sessions.set` and the first `setupSlideOutput`.
- `:885-901` the pump stop and `presenterCamera` build before `compositor.startPlayback` at `:904-914`.
- `:945-975` `compositor.onEnd`; `:977-994` `compositor.onError`.
- `:1026-1056` `pauseVideoSession`, with the frozen-frame push at `:1038-1047`.
- `:1088-1093` compositor stop in `stopSession`.

`src/logic/presentation-manager/types.ts`: `:5-15` `OverlayCorner` / `OverlaySize` / `OverlayConfig`; `:31-32` `PresentationSession.overlayConfig`; `:84-100` the `createPresentation` JSDoc and signature.

`src/controllers/handlers/create-presentation-handler.ts`: `:6` the overlay type import; `:27-48` `VALID_CORNERS`, `VALID_SIZES` and the two parse functions; `:67` `let overlayConfig`; `:90` and `:127` the parse calls; `:163` the argument.

`src/components.ts:13,79,89,106` and `src/types.ts:8,36`: `cameraOverlayCompositor` wiring.

Tests:
- `test/unit/presentation-manager.spec.ts:83-89` the `cameraOverlayCompositor` mock; `:41-50` `createMockCompositor`, which has `getIsPlaying` and `getLastFrame` with bufferType 5.
- `test/unit/build-filter-complex.spec.ts:10-39` the camera cases.

Publisher camera events are unchanged: `livekit-publisher/component.ts:91-114` emits `{ kind: 'active', track }` and `{ kind: 'inactive' }` on subscribe/unmute and mute/unsubscribe/leave.

## Steps

**Test-first.** Write the tests in steps 22–24 first, against the target interfaces. Run them and record the failing output in the learning JSON, then do steps 1–21 until they pass.

### video-compositor

1. In `types.ts`:
   - Delete the `OverlayConfig` and `RemoteVideoTrack` imports (`:2`, `:4`) and the two camera reasons with their JSDoc (`:45-48`).
   - Replace the last `startPlayback` parameter `presenterCamera?: { track: RemoteVideoTrack; overlayConfig: OverlayConfig }` (`:65`) with `decorateFrame?: (frame: Buffer, width: number, height: number) => Buffer`, and add a JSDoc line: "Returns the frame to publish; the undecorated frame is kept for `getLastFrame`."

2. In `component.ts`, change `buildFilterComplex` (`:76-134`) to take `opts: { videoOverlay: { x; y; w; h } }` and always return the two-input string currently at `:91`. Delete `SIZE_RATIO` and `MARGIN_RATIO` (`:69-74`), and update its JSDoc to describe the two-input graph only.

3. In `component.ts`, delete:
   - `readFirstCameraFrame` (`:305-342`);
   - the `cameraReader` declaration (`:143`) and both cancel blocks (`:493-498`, `:988-993`);
   - `cameraInit` (`:547-560`) and `cameraInputArgs` (`:610-627`), plus its spread at `:653`;
   - the camera pump (`:689-756`).

   Make `stdioConfig` the constant `['ignore', 'pipe', 'pipe']`. Remove the `camera` argument from the `buildFilterComplex` call (`:588-598`). Drop the now-unused imports (`VideoBufferType`, `VideoStream`, `RemoteVideoTrack`, `RtcVideoFrame`, `OverlayConfig`). Keep `validateMediaDimensions`, which is exported and used by `camera-overlay`.

4. In the frame loop at `:887-895`, keep `lastPushedFrame` pointing at the unstamped `frameCopy`. Then compute the frame to push:
   - `let out = frameCopy`
   - if `decorateFrame` is set, `try { out = decorateFrame(frameCopy, slideWidth, slideHeight) } catch (err) { logger.warn(...); out = frameCopy }`
   - then `publisher.pushFrame(out, …, VIDEO_BUFFER_TYPE_I420)`.

   The guard is load-bearing: this runs inside the ffmpeg stdout listener, and the Dockerfile runs Node with `--abort-on-uncaught-exception` (`Dockerfile:53`), so an unguarded throw kills every session. It mirrors the `onAudioData` guard at `:799-811`. `decorateFrame` is the renamed ninth `startPlayback` parameter.

### presentation-manager types and handler

5. In `presentation-manager/types.ts`, delete `OverlayCorner`, `OverlaySize` and `OverlayConfig` (`:5-15`) and `PresentationSession.overlayConfig` (`:31-32`). Remove the `overlayConfig` parameter and its `@param` from `createPresentation` (`:84-100`).

6. In `create-presentation-handler.ts`:
   - Delete the `:6` import, `VALID_CORNERS`, `VALID_SIZES`, `parseOverlayConfigFromBody` and `parseOverlayConfigFromFields` (`:27-48`).
   - Delete the `let overlayConfig` declaration (`:67`) and the two assignments (`:90`, `:127`).
   - Call `createPresentation` with five arguments (`:157-164`).

   Extra body fields such as `overlayCorner` are now ignored, like any other unknown field.

### Wiring

7. In `src/types.ts`, replace the `ICameraOverlayCompositorComponent` import and the `cameraOverlayCompositor` field (`:8`, `:36`) with `ICameraOverlayComponent` from `./adapters/camera-overlay` and the field `cameraOverlay: ICameraOverlayComponent`.

   In `src/components.ts`, replace the import (`:13`) with `createCameraOverlayComponent`, `const cameraOverlayCompositor = …` (`:79`) with `const cameraOverlay = createCameraOverlayComponent()`, and both object entries (`:89`, `:106`) with `cameraOverlay`.

8. Delete `src/adapters/camera-overlay-compositor/` entirely.

### presentation-manager component

9. **`InternalSession` (`:38-76`).**
   - Replace the four camera fields (`:42-58`) with:
     - `cameraOverlay: ICameraOverlay`
     - `baseFrame: VideoFrameSnapshot | null`, the frame shown when no video is playing: the RGBA slide or the unstamped I420 frozen video frame
     - `baseI420: { source: Buffer; i420: Buffer } | null`, a conversion cache
   - Import `ICameraOverlay` from `../../adapters/camera-overlay`, `VideoFrameSnapshot` from `../../adapters/video-compositor/types`, and `rgbaToI420` from `../color-convert`.
   - Remove the `OverlayConfig`, `ICameraOverlayCompositor` and `RemoteVideoTrack` imports.
   - Remove `'cameraOverlayCompositor'` from the `Pick`/destructure (`:171`, `:182`) and add `'cameraOverlay'`.

10. **`COMPOSITOR_ERROR_MESSAGES` (`:103-109`).** Delete the two camera entries.

11. **Output helpers.** Add three functions next to `setupSlideOutput`. They are the idle-output state machine:
    - **`baseAsI420(session): Buffer | null`**
      - Returns `null` when `baseFrame` is null.
      - Returns `baseFrame.buffer` when `baseFrame.bufferType === 5`.
      - Otherwise returns `baseI420.i420` when `baseI420?.source === baseFrame.buffer`. If not cached, it sets `baseI420 = { source, i420: rgbaToI420(source, w, h) }` and returns that.
    - **`pushIdleFrame(session): void`**
      - Returns early when `session.compositor?.getIsPlaying()`, when `!session.cameraOverlay.isActive()`, or when `baseAsI420` is null.
      - Otherwise it computes `const i420 = baseAsI420(session)` outside the `try` (returning early when `null`). Then, inside `try`, it copies the buffer (`Buffer.from(i420)`) and calls `session.cameraOverlay.stamp(copy, w, h)`. On a throw, it logs `logger.warn` and uses a fresh unstamped copy `Buffer.from(i420)` instead. Then it calls `session.publisher.pushFrame(copy, w, h, 5)` and `session.publisher.startHeartbeat(copy, w, h, 5)`.
      - The guard is load-bearing: `pushIdleFrame` runs from the compositor's `onEnd`/`onError` callbacks through `setupSlideOutput`, and the compositor ignores the promise those callbacks return. The Dockerfile runs with `--unhandled-rejections=strict` (`Dockerfile:53`), so an unguarded throw there aborts every session.
      - `startHeartbeat` replaces any running interval (`livekit-publisher/component.ts:345-350`). While camera frames flow, the 500 ms heartbeat never fires. If the camera stalls without muting, the heartbeat keeps repeating the last stamped frame, which preserves the invariant in `docs/video-playback-lifecycle.md:82-101`.
    - **`refreshIdleOutput(session): void`**
      - Returns early when `session.compositor?.getIsPlaying()` or when `!session.baseFrame`.
      - If `session.cameraOverlay.isActive()`, calls `pushIdleFrame(session)`.
      - Otherwise calls `pushFrame(base.buffer, base.width, base.height, base.bufferType)` and then `startHeartbeat(...)` with the same arguments.

12. **`setupSlideOutput` (`:236-271`).**
    - Keep the `lastFrame*` assignments and additionally set `session.baseFrame = { buffer, width, height, bufferType: 0 }`, where 0 is `VideoBufferType.RGBA` and the slide's existing format.
    - Keep the `playing`/`loading` early return.
    - Replace the rest of the body (`:253-270`) with `refreshIdleOutput(session)`.
    - Delete the stale "Phase 5" comment at `:247-248`.
    - The function becomes synchronous work; keep it `async` so its call sites stay unchanged.

13. **Delete `restartPlaybackOnCameraFlip` and `startCameraOverlayPump` (`:390-432`).**

14. **Move and replace the presenter camera handler (`:434-483`).** The publisher fires `active` once per track, during or right after `connect`, and never replays it (`livekit-publisher/component.ts:91-107`, `:408-410`). The session only enters `sessions` at `:535`, after several awaits. So the handler must not depend on the session existing.
    - Delete the old handler block.
    - Register the new one in `createPresentation` **before** `await publisher.connect(...)` (`:338`), right after the per-session overlay is created (step 15). It closes over `overlay`, not the session.
    - `active`: `overlay.start(event.track)`.
    - `inactive`: `await overlay.stop()`, then `const session = sessions.get(id); if (session) refreshIdleOutput(session)`.
    - Keep the outer `try/catch` warn.

15. **`createPresentation`.** Create the overlay before `connect` so the step-14 handler can use it.
    - Drop the `overlayConfig` parameter (`:320`).
    - Set `cameraOverlay: overlay, baseFrame: null, baseI420: null` in the literal, replacing `:512-516`.
    - Immediately after `sessions.set(id, session)` (`:535`), call `overlay.onCameraFrame(() => pushIdleFrame(session))`.
    - Create `const overlay = cameraOverlay.createOverlay(publisherLogger)` directly after `publisherLogger`/`publisher` are created (`:330-331`), ahead of `connect`. `cameraOverlay` is the component destructured in step 9.
    - On the `createPresentation` failure path (`:558-571`), before `await publisher.disconnect()`, add `publisher.setPresenterCameraTrackHandler(null)` followed by `await overlay.stop().catch(() => undefined)`, using the local `publisher` and `overlay`. A camera may already have started it.

16. **`playVideoSession`.**
    - Delete `:885-901`, the pump stop and the `presenterCamera` build.
    - Pass `(frame, w, h) => { if (!session.cameraOverlay.isActive()) return frame; const out = Buffer.from(frame); session.cameraOverlay.stamp(out, w, h); return out }` as the ninth `startPlayback` argument (`:913`).

17. **`compositor.onEnd` (`:945-975`).** As its first statement after the stale-callback guard, before any `await`, set `session.baseFrame = { buffer: session.lastFrameBuffer, width: session.lastFrameWidth, height: session.lastFrameHeight, bufferType: 0 }` when `lastFrameBuffer` is set, so a camera frame that lands during the awaits never stamps a stale frozen video frame. Then replace the pump restart block (`:953-968`) with `if (session.lastFrameBuffer) await setupSlideOutput(session, session.lastFrameBuffer, session.lastFrameWidth, session.lastFrameHeight)`. This restores slide output, whether stamped or on the heartbeat, after the compositor's own `stopPlayback` pushed the plain slide.

18. **`compositor.onError` (`:977-994`).** Apply the same synchronous `baseFrame` reset as step 17 before the first `await`. After `session.compositor = null`, add the same `setupSlideOutput` call.

19. **`pauseVideoSession` (`:1038-1047`).** Replace the push/heartbeat block:
    - with a frozen frame (`lastFrame`), set `session.baseFrame = lastFrame`;
    - otherwise leave `baseFrame` as the slide;
    - then call `refreshIdleOutput(session)` after `session.compositor = null`.

    Delete the stale comment at `:1039-1040`.

20. **`stopSession` (`:1088-1093`).** Replace the `if (session.cameraOverlayCompositor) { … }` block with `session.publisher.setPresenterCameraTrackHandler(null)` followed by `await session.cameraOverlay.stop().catch(() => undefined)`. Leave the video `session.compositor.cleanup()` block at `:1077-1080` unchanged. Clearing the handler first means a late camera `active` event cannot restart the overlay.

21. Replace every `/* noop */` or `/* best-effort cleanup */` catch body in lines you touched with `.catch(() => undefined)`.

### Tests

22. **`test/unit/build-filter-complex.spec.ts`.** Delete the three camera cases (`:10-39`). Rewrite the remaining two-input case as `describe('when building the filter graph') / it('should return the two-input overlay filter')`, calling `buildFilterComplex({ videoOverlay })`. Keep the `validateMediaDimensions` block.

23. **`test/unit/presentation-manager.spec.ts`.**
    - Replace the `cameraOverlayCompositor` mock (`:83-89`) with `cameraOverlay: { createOverlay: jest.fn().mockReturnValue(overlay) }`. Here `overlay` is a `jest.Mocked<ICameraOverlay>`: `isActive` returns false, `stop` resolves, and `onCameraFrame` stores its callback for the test to invoke.
    - Expose `_overlay` on the returned components.
    - Capture the camera handler via `publisher.setPresenterCameraTrackHandler.mock.calls[0][0]`.
    - Add `describe('when the presenter camera …')` blocks asserting:

| Scenario | Expected |
|---|---|
| `active` event | `overlay.start` called with the track |
| camera `active` fired from inside the mocked `publisher.connect` (before the session exists), then a camera frame after `createPresentation` resolves | `overlay.start` called with the track; the frame callback pushes a stamped I420 frame |
| camera frame callback, idle, `isActive` true | `overlay.stamp` called; `pushFrame` and `startHeartbeat` both called with the same I420-size stamped buffer and bufferType `5` |
| `createPresentation` fails after `connect` | `setPresenterCameraTrackHandler(null)` called, then `overlay.stop` |
| camera frame callback while compositor `getIsPlaying` true | no `pushFrame` from the callback |
| `inactive` event | `overlay.stop` called; `pushFrame` and `startHeartbeat` called with the slide buffer and bufferType `0` |
| video playing, `decorateFrame` passed to `startPlayback` | overlay inactive: returns the same buffer; active: returns a different buffer and calls `stamp` |
| pause with camera active | next camera frame pushes a stamped copy sized from `getLastFrame()` |
| compositor `onEnd` callback | heartbeat restored with the slide when overlay inactive |
| compositor `onEnd` with overlay active and `stamp` throwing | the callback resolves without rejecting; `pushFrame` is called with an unstamped I420 copy; a warning is logged |
| `stopSession` | `setPresenterCameraTrackHandler(null)` is called before `overlay.stop` |

    - Fix any existing assertion that referenced `presenterCamera` or the camera compositor. The pinned `startPlayback` arity assertion noted in `docs/specs/loom-camera-overlay/learnings/phase-5.md` must now expect a function or `undefined` as the ninth argument.

24. **`test/unit/video-compositor.spec.ts`.** Copy the stdout-driven pattern from `describe('when onAudioData throws inside the stdout data handler')` (`:216-240`). Add `describe('when a decorateFrame callback is passed')` with these cases:
    - emitting one full I420 frame on the composite stdout calls `publisher.pushFrame` with the buffer `decorateFrame` returned, while `getLastFrame().buffer` is the undecorated frame;
    - a throwing `decorateFrame` does not throw from `stdout.emit`, pushes the undecorated frame, and logs a warning.

## Edge cases

| Scenario | Handling |
|---|---|
| Camera activates during video download (`loading`, compositor not yet playing) | Camera frames keep stamping over `baseFrame`; the bubble never disappears. |
| ffmpeg starting (compositor playing, no frame yet) | Idle pushes stop; the last stamped heartbeat repeats until the compositor's first frame stops it (`video-compositor/component.ts:883-886`). |
| Compositor error or end runs its own `stopPlayback` (plain slide + heartbeat) | The manager's `onError`/`onEnd` resets `baseFrame` synchronously, then calls `setupSlideOutput`, whose `pushIdleFrame` replaces that heartbeat with the stamped slide. No interleaving. |
| Camera stalls without muting | The heartbeat keeps repeating the last stamped frame every 500 ms. |
| Camera already on before the session exists | The handler is registered before `connect` and starts the overlay; the first `setupSlideOutput` after `sessions.set` pushes the stamped slide. |
| `decorateFrame` throws | The compositor logs a warning and pushes the undecorated frame; the process survives. |
| Camera muted while paused | `refreshIdleOutput` restarts the heartbeat on the frozen frame. |
| Navigate while camera active | `setupSlideOutput` swaps `baseFrame`; the next camera frame stamps the new slide. |
| Camera never sends a frame after `active` | `isActive()` stays false; the heartbeat keeps running. |

## Verification

```sh
npx --yes yarn@1.22.22 lint:fix && npx --yes yarn@1.22.22 typecheck && npx --yes yarn@1.22.22 lint
npx --yes yarn@1.22.22 test test/unit/presentation-manager.spec.ts test/unit/build-filter-complex.spec.ts test/unit/video-compositor.spec.ts
npx --yes yarn@1.22.22 test
git diff --quiet HEAD -- yarn.lock package.json
rg -n "camera-overlay-compositor|cameraOverlayCompositor|OverlayConfig|OverlayCorner|readFirstCameraFrame|restartPlaybackOnCameraFlip|startCameraOverlayPump|camera-resolution|presenterCamera\b|pipe:3" src test
```

The final `rg` must print nothing.

## Completion criteria

- All steps are applied, and the directory `src/adapters/camera-overlay-compositor/` no longer exists.
- Every scenario in the step 23 table has a passing test, and the full suite passes.
- `buildFilterComplex` has exactly one shape (two inputs).
- The diff stays inside write ownership. `docs/` is untouched; phase 4 owns it.

## Learning output

Write only `docs/specs/loom-overlay-runtime/learnings/phase-3.json` using plan-plus `docs/learning-schema.md` (schema v2, `scope: "project"`). Record any state-machine transition you had to add beyond the edge-case table as `kind: gotcha`.
