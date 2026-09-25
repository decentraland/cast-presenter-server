# Code-quality review — loom-overlay-runtime

## Review summary

- **Scope:** the integrated run checkout `.worktrees/loom-overlay-runtime/run` at HEAD `b2a6209`, base `2c6cdd1`. Run `run-881c573a`. Lens: code-quality, no persona.
- **Areas covered:**
  1. `src/adapters/camera-overlay/{types,component,index}.ts`: geometry, blend, pump and reader lifecycle, patch cache, and the `validateMediaDimensions` control.
  2. `src/adapters/video-compositor/{component,types}.ts`: the two-input graph, the `decorateFrame` guard, and the `lastPushedFrame` invariant.
  3. `src/logic/presentation-manager/{component,types}.ts`: the idle-output state machine (`baseAsI420`, `pushIdleFrame`, `refreshIdleOutput`, `resetBaseToSlide`) traced across create, navigate, play, resume, pause, stop, `onEnd`, `onError` and `stopSession`; the camera handler ordering; the overlay command, parser and broadcast throttle.
  4. Wiring and cleanup: `src/components.ts`, `src/types.ts`, `create-presentation-handler.ts`, and the deleted compositor and integration file.
  5. Phase 1: `pdf-renderer/component.ts`, `.eslintrc.json`, pins in `package.json`, and the v1 header in `yarn.lock`.
  6. Tests: `camera-overlay`, `presentation-manager` (overlay and camera blocks), `video-compositor` (`decorateFrame`) and `build-filter-complex`, each checked against the spec's required tables.
  7. Docs: `architecture.md`, `ai-agent-context.md`, `video-playback-lifecycle.md`.
  8. Conventions: no new code comments, the `.catch(() => undefined)` idiom, dcl test naming, and write ownership. The Completion `rg` (for `src`, `test`, and `docs` minus specs) is clean by static search.
- **What checks out:**
  - `overlayRect` matches the wire-contract formula exactly, and the spec's 960×540 fixtures hold.
  - `blendPatch` bounds and chroma indexing are correct for the even rects that `overlayRect` produces.
  - The pump re-checks ownership after `read()`. `stop()` detaches synchronously before its await.
  - The camera handler is registered before `connect` and cleared before `overlay.stop()` on both the failure path and the stop path.
  - `decorateFrame` is guarded inside the stdout listener. `lastPushedFrame` stays unstamped.
  - `pushIdleFrame` guards `stamp` and falls back to a fresh unstamped copy.
  - `onEnd` and `onError` reset `baseFrame` synchronously before any await.
  - `parseOverlayUpdate` follows the wire contract: a present-but-invalid field drops the whole command, and an empty command is a no-op.
  - The throttle timer is cleared in `stopSession`.
  - The spec-table tests can fail. The mutation evidence for `clearRect` is in `learnings/phase-2.json`.
- **Counts:** Critical 0, High 0, Medium 1, Low 6, Informational 5.
- **Blocking threshold:** medium.
- **Verdict: `fail`.** There is one blocking Medium finding (M1). It is small and in scope for phase 2's write ownership.

## Findings

### [MEDIUM] M1 A throw inside `acceptFrame` kills the pump, freezes the bubble, and leaves an unread `VideoStream` buffering frames without bound

- **Evidence:**
  - `src/adapters/camera-overlay/component.ts:103-104`: `event.frame.convert(VideoBufferType.RGBA)` runs outside any per-frame guard.
  - `:111-121`: so do `createCanvas`, `new ImageData`, the full-frame `slice`, and `putImageData`.
  - `:133-146`: the only guard is the loop-wide `try/catch`. Its `catch` logs and returns, but leaves `running = true`, `hasFrame = true`, and `reader`/`stream` set, and never cancels `ownReader`.
  - `:213-215`: `isActive()` therefore stays `true`.
  - rtc-node 1.1.0 `dist/video_frame.cjs:93-99`: `convert` throws on an FFI error response.
  - `dist/video_stream.cjs:30-50,77-83`: the source `enqueue`s every decoded frame (a JS copy via `copyBuffer`) with no `pull`/backpressure, and only a `cancel()` unhooks the FFI listener.
- **Defect:** one throwing frame permanently ends the pump without detaching it. The pump dies silently: it logs one warning, the manager still sees an active overlay, and nothing reads the stream again or cancels it.
- **Impact:**
  - The bubble freezes on the last camera image. Idle output stops being driven by camera frames and falls back to the 500 ms heartbeat.
  - The worse effect is memory. The still-subscribed `VideoStream` keeps enqueuing decoded I420 copies into an unread `ReadableStream` queue. For 720p at 30 fps that is roughly 40 MB/s, until the presenter mutes or unpublishes, or the session stops.
  - That can OOM the process and every session on it.
  - Likelihood is low, because a conversion failure or an allocation failure in `createCanvas` for a large validated frame is rare. The blast radius is process-wide.
- **Remediation (bounded):**
  - Wrap the body of each accepted frame (`acceptFrame(value)`) in its own `try/catch` with `logger.warn` and `continue`, so one bad frame never ends the pump.
  - In the outer `catch`, detach if still current: `if (reader === ownReader) { reader = null; stream = null; running = false; hasFrame = false }`, then `ownReader.cancel().catch(() => undefined)`.
  - Add one test with a `convert` that throws once and then succeeds. Assert that the second frame still fires the callbacks.
- **Scope:** in-scope (phase 2 owns `src/adapters/camera-overlay/` and `test/unit/camera-overlay.spec.ts`). The spec step (`phase-2:106`, "Wrap the loop in try/catch") permits this reading, so the fix tightens the spec rather than contradicting it.

### [LOW] L1 The camera frame is converted to RGBA before its dimensions are validated

- **Evidence:**
  - `src/adapters/camera-overlay/component.ts:104-106`: `convert(RGBA)` runs first, then `validateMediaDimensions(rgba.width, rgba.height, …)`.
  - The guardrail in `plan.md:44` says an invalid frame "never allocates a canvas or buffer".
- **Defect:**
  - `convert` allocates a native `w*h*4` buffer and copies it into JS before the check. `event.frame.width`/`height` are available up front.
  - `phase-2:103` orders it convert-then-validate, which conflicts with the guardrail. The implementation follows the step.
- **Impact:** an oversized presenter camera frame causes one extra RGBA allocation of about 2.7× the I420 size before it is dropped. The attack surface is presenter-only. This is defence-in-depth, not an exploit.
- **Remediation:**
  - Call `validateMediaDimensions(event.frame.width, event.frame.height, 'camera-overlay')` before `convert`.
  - Keep the post-convert check if desired.
  - Point the existing `width: 99999` test at the source frame's dimensions and assert that `convert` was not called.
- **Scope:** in-scope (phase 2).

### [LOW] L2 A stale frozen frame is stamped while navigating away from a resumed video

- **Evidence:**
  - `src/logic/presentation-manager/component.ts:966`: pause sets `baseFrame = lastFrame`.
  - `:698-707` and `:765-887`: resume never resets it.
  - `:642-653`: `navigateSession` tears down the compositor, then awaits `stopAudioPublishing` and `renderSlide` before `setupSlideOutput`.
  - During that await, `pushIdleFrame` (`:239-254`) passes all its gates (`compositor` is null) and stamps the old frozen I420 frame.
- **Defect:** after pause → resume → navigate, camera frames push a frozen video frame from minutes earlier until the new slide renders. This extends the carried adversary L4 (previous-slide flash). A resume that fails (`videoState = 'error'` at `:743`/`:865`) likewise keeps stamping the old frozen frame instead of the slide.
- **Impact:** a cosmetic flash of an out-of-date frame lasting about one `renderSlide`. The error case is a persistent but plausible still frame.
- **Remediation:**
  - In `navigateSession`, set `session.baseFrame = null` right after `session.compositor = null` (`:645`). Idle pushes then pause until `setupSlideOutput` installs the new slide.
  - Optionally call `resetBaseToSlide` on the resume error paths.
  - Add one test row: navigate while resumed with the camera active, and assert no `stamp` with the frozen dimensions.
- **Scope:** in-scope (phase 3 owns `presentation-manager/`).

### [LOW] L3 First-wins camera selection means a second live presenter camera never gets the bubble

- **Evidence:**
  - `src/adapters/livekit-publisher/component.ts:102-104`: `activePresenterCameraSid` is first-wins.
  - `:109-114`: `deactivatePresenterCamera` emits `inactive` and does not promote another presenter's unmuted camera.
  - `docs/architecture.md:140` documents "the first presenter's camera".
- **Defect:** `plan.md:10` requires the bubble "whenever a presenter camera is active and unmuted". With two presenters, if A mutes while B's camera is live, the bubble disappears and never returns for B, unless B re-publishes or unmutes.
- **Impact:** multi-presenter rooms lose the bubble. This is pre-existing publisher behaviour, not a regression from this spec.
- **Remediation:**
  - On deactivate, rescan remote presenters for a subscribed, unmuted `SOURCE_CAMERA` track and emit `active` for it.
  - Or narrow the success criterion to "the first presenter camera".
- **Scope:** `replan`. `livekit-publisher/` is owned only by phase 1 (dependency upgrade), and changing camera selection is outside every phase's acceptance criteria.

### [LOW] L4 The phase-2 test never exercises the `start()` reader-replacement path

- **Evidence:**
  - `test/unit/camera-overlay.spec.ts:327-351`: the restart case runs `start(A)`, then `stop()`, then `start(B)`. `stop()` itself nulls `reader` and cancels `readerA`.
  - So the `old?.cancel()` in `start()` (`src/adapters/camera-overlay/component.ts:181-183`) always sees `null`.
  - The edge table row "`start` called twice → old reader cancelled" (`phase-2:156`) has no test.
- **Defect:** deleting the cancel in `start()` still passes the suite.
- **Impact:** a leaked `VideoStream` (FFI handle plus listener, per `video_stream.cjs:77-83`) on a direct re-`active` would go undetected. That happens when the publisher re-fires `active` for the same sid on unmute (`livekit-publisher/component.ts:103`).
- **Remediation:** add a case that calls `start(trackA)`, then `start(trackB)` without `stop()`, flushes, and asserts `readerA.cancel` was called and frames come from B.
- **Scope:** in-scope (phase 2).

### [LOW] L5 A floating `loadingTask.destroy()` promise under `--unhandled-rejections=strict`

- **Evidence:**
  - `src/adapters/pdf-renderer/component.ts:136`: `void doc.loadingTask.destroy()`.
  - `Dockerfile:53`: `--unhandled-rejections=strict`.
- **Defect:** in pdfjs 6, `PDFDocumentLoadingTask.destroy()` is async (it tears down the transport and the worker). A rejection has no handler.
- **Impact:** a rare pdfjs teardown rejection aborts the whole process, and with it every session. The phase-1 rewrite kept the same shape as the old `void doc.destroy()`, so this is not new risk, but the line was rewritten in this run.
- **Remediation:** use `doc.loadingTask.destroy().catch(() => undefined)`, the spec's own empty-catch idiom.
- **Scope:** in-scope (phase 1 owns `src/adapters/pdf-renderer/`).

### [LOW] L6 Missing guard tests: `onError` idle restoration with the overlay, and invalid commands scheduling no broadcast

- **Evidence:**
  - `src/logic/presentation-manager/component.ts:907-918` (step 18: synchronous `resetBaseToSlide`, then `setupSlideOutput`) has no overlay-aware test. The `onError` block at `test/unit/presentation-manager.spec.ts:1310-1400` runs with the default inactive overlay and asserts only the error broadcasts.
  - `test/unit/presentation-manager.spec.ts:417-430` (the invalid `describe.each`) asserts `setLayout` was not called, but not that no `presentation:state` was scheduled. Only the `{}` case at `:432-445` checks the broadcast.
- **Defect:** these assertions are not required by the spec tables, but they guard the transitions that phase 3 calls load-bearing.
  - Dropping `resetBaseToSlide` from `onError`, or the `setupSlideOutput` call, passes the suite.
  - Scheduling a broadcast before validation also passes.
- **Impact:** a regression guard is missing for the flicker/stale-frame class that motivated phase 3's `deep` rating.
- **Remediation:**
  - Add one `onError` case with the overlay active after a pause/resume. Assert that the next camera frame stamps at slide dimensions.
  - Add `advanceBroadcastInterval()` plus `expect(stateBroadcasts()).toHaveLength(0)` to the invalid `describe.each`.
- **Scope:** in-scope (phases 3 and 4 own the spec file).

### [INFORMATIONAL] I1 The bubble lingers briefly after a mute during video startup or seek warmup

- **Evidence:**
  - `src/logic/presentation-manager/component.ts:369-371`: the `inactive` handler calls `refreshIdleOutput`.
  - `:258`: `refreshIdleOutput` returns early while `compositor.getIsPlaying()`.
  - `src/adapters/video-compositor/component.ts:653-656`: the heartbeat, which holds the last stamped frame, is stopped only on ffmpeg's first delivered frame.
- **Impact:** after a mute during ffmpeg startup and the 10-frame warmup, the stamped bubble stays visible for about 0.5–1.5 s. It heals itself when the first composite frame arrives.
- **Remediation, optional:** in the `inactive` handler, when the compositor is playing but has no `getLastFrame()`, restart the heartbeat on the plain `baseFrame`.
- **Scope:** in-scope, not required.

### [INFORMATIONAL] I2 Every accepted camera frame is copied one extra time

- **Evidence:** `src/adapters/camera-overlay/component.ts:116-120` calls `rgba.data.buffer.slice(...)` before `new ImageData`, and `putImageData` copies again.
- **Impact:** about 3.7 MB of extra copying per accepted 720p frame, 20 times a second, against the plan's goal of "less CPU than today".
- **Remediation:** wrap the buffer without copying it, using `new Uint8ClampedArray(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength)`.
- **Scope:** in-scope.

### [INFORMATIONAL] I3 Small redundancies

- **Evidence:**
  - `src/adapters/camera-overlay/component.ts:86,184,198`: `stream` is only ever written, never read.
  - `src/logic/presentation-manager/component.ts:138` clamps x/y, and `setLayout` (`camera-overlay/component.ts:206`) clamps them again. The spec asked for both.
  - `presentation-manager/component.ts:240-242` checks `!session.baseFrame` and then `!i420`.
- **Impact:** none functionally.
- **Remediation, optional:** drop the parser clamp and rely on `setLayout`. Drop the `stream` variable.

### [INFORMATIONAL] I4 Layering and coupling

- **Evidence:**
  - `src/adapters/camera-overlay/component.ts:5` imports `validateMediaDimensions` from the video-compositor component module, an adapter-to-adapter runtime import that pulls in `child_process` and the network validator.
  - `src/logic/presentation-manager/component.ts:7` imports the runtime value `OVERLAY_SIZES` from an adapter module that loads `@livekit/rtc-node` and `@napi-rs/canvas`.
  - `:361` gives the overlay `publisherLogger`, so camera-overlay warnings are attributed to `livekit-publisher:<id>`.
- **Impact:** tighter coupling, heavier test imports, and misattributed logs. The spec dictated the locations.
- **Remediation:** a follow-up (see below).

### [INFORMATIONAL] I5 The adversary's L3 is now resolved

`test/unit/camera-overlay.spec.ts:383-412` advances `Date.now` past the throttle and asserts two callbacks before comparing bytes. Together with the mutation run recorded in `learnings/phase-2.json`, this makes the edge-alpha test able to fail.

## Follow-ups (not blocking)

- Move `validateMediaDimensions` into a shared logic module (for example `src/logic/media-dimensions.ts`). Move `OVERLAY_SIZES` and `DEFAULT_OVERLAY_LAYOUT` into `camera-overlay/types.ts` or a constants file with no native imports. Give the overlay its own `camera-overlay:<id>` logger (I4).
- `livekit-publisher/component.ts:251-253,267` logs two `info` lines per command. A drag that streams `presentation:overlay:update` will flood the logs. Consider logging this command at `debug`. Out of scope for this spec.
- `docs/architecture.md:104-117` (the Adapters list) does not mention the new `camera-overlay` adapter. `:132` still says pause/resume uses SIGSTOP/SIGCONT, which predates this spec and is stale.
- The `/* noop */` catch bodies at `presentation-manager/component.ts:791-793,869-871` sit next to the modified `startPlayback` call but outside the modified lines. Convert them to `.catch(() => undefined)` the next time those blocks are touched.
- Carried from `plan.md` "Follow-ups" and the adversary's "Needs verification":
  - reuse a scratch buffer in `decorateFrame`;
  - add a PPTX runtime gate on canvas 1.x;
  - decide whether `ffiHandle.dispose()` is still needed;
  - subscribe to the lowest simulcast layer;
  - run the manual dev-room smoke, which was skipped (see `learnings/phase-4.json`).
- L3 needs a product decision on multi-presenter camera selection before the publisher changes.

## Severity counts

| Severity | Count | Blocking |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | M1 |
| Low | 6 | — |
| Informational | 5 | — |
