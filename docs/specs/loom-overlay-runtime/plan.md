# Loom overlay: runtime layout

## Goal

The presenter can move their circular camera bubble on the presentation track at runtime: two sizes, four corner presets, and free drag. Turning the camera off hides the bubble. One stamping step draws the bubble onto every outgoing frame (slide, frozen paused video, playing video), so changes apply on the next frame without restarting ffmpeg and with less CPU than today.

Success:
- A `presentation:overlay:update` from a presenter moves or resizes the bubble within one frame, in slide, playing-video and paused-video states, with no ffmpeg respawn.
- `presentation:state` and bot metadata carry the current `overlay`.
- Every session shows the bubble whenever a presenter camera is active and unmuted, and hides it when the camera is muted or unpublished.
- ffmpeg never receives a camera input. The `camera-overlay-compositor` adapter, `restartPlaybackOnCameraFlip` and `OverlayConfig` no longer exist.

Base: `feat/loom-camera-overlay` at `2c6cdd12e0267306818af9540eede56d67203655`. The matching frontend spec is `sites/docs/specs/loom-overlay-runtime/`.

Exploration: two read-only explorers (backend overlay runtime control; frontend cast2 presenter UI) plus a network-only research agent (library releases). The coordinator re-read the load-bearing ranges first-hand at the base sha.

## Wire contract

This section is identical in the frontend spec.

- **Command** (presenter → bot, LiveKit topic `presentation`): `{ type: 'presentation:overlay:update', x?: number, y?: number, size?: 'small' | 'large' }`.
  - `x` and `y` are the bubble centre as fractions of slide width and height. The server clamps them to `[0, 1]`.
  - An omitted field keeps its current value.
  - A present field that is invalid drops the whole command. Invalid means a non-number, `NaN` or `±Infinity` for `x`/`y`, or a size other than `small`/`large`.
  - A command with none of the three fields is a no-op.
  - Only presenters are allowed, via the existing `presenters` check in `src/adapters/livekit-publisher/component.ts:255-260`.
- **State:** `presentation:state` and the bot's participant metadata always include `overlay: { x: number, y: number, size: 'small' | 'large' }`. The default is `{ x: 0, y: 1, size: 'small' }`, which is bottom-left.
- **Geometry:** `overlayRect(layout, w, h) → { left, top, d }` in pixels.
  - `even(n) = n - (n % 2)`
  - `margin = round(w * 0.02)`
  - `d = even(min(round(w * RATIO[size]), h - 2 * margin))`, with `RATIO = { small: 0.15, large: 0.25 }`
  - `cx = clamp(x * w, margin + d / 2, w - margin - d / 2)`, and `cy` the same with `y` and `h`
  - `left = even(round(cx - d / 2))`, `top = even(round(cy - d / 2))`
  - Because of the clamping, the corner presets are `(0,0)`, `(1,0)`, `(0,1)` and `(1,1)`.
- **Visibility:** the bubble is drawn if and only if a presenter camera track is active and unmuted, using the existing publisher events. There is no visibility flag.
- **`POST /presentations`:** no longer accepts `overlayCorner`/`overlaySize`. No client ever sent them.

## Constraints and guardrails

- **One stamping path.** Every frame the bot publishes gets the bubble blended in just before `publisher.pushFrame`. No camera input goes into ffmpeg. Do not add `zmq`, `sendcmd`, `alphamerge`, or any ffmpeg restart for a layout change.
- **Yarn v1 only.** Every yarn invocation in this spec is `npx --yes yarn@1.22.22 …`, including tests and lint. Never run a bare `yarn`. Dependency bumps use `npx --yes yarn@1.22.22 add --exact <pkg>@<ver>`. `yarn.lock` must keep its first comment line `# yarn lockfile v1`, and phases 2–4 must leave `yarn.lock` and `package.json` unchanged (`git diff --quiet HEAD -- yarn.lock package.json`). The local yarn is 4.14.1, while CI (`.github/workflows/node.yml:19`) and the Dockerfile (`Dockerfile:8,15`) run v1 `--frozen-lockfile`. Never commit a Berry-format `yarn.lock`, `.yarnrc.yml`, or `.yarn/`: the launch checkout has uncommitted ones that are not part of this work.
- **No code comments** (user rule). Allowed: JSDoc on public functions, interfaces and modules, and toolchain directives. Empty catches become `.catch(() => undefined)` rather than a `/* noop */` body. Delete banned comments inside the ranges you modify, and only there.
- **Skills.** Load `dcl-wkc-components` and `dcl-backend-standards` before editing `src/`, and `dcl-testing` before editing `test/`. New and rewritten tests use `describe('when …')` / `it('should …')` with `beforeEach`-scoped mocks.
- **Keep the security control.** Camera frame dimensions are always checked with `validateMediaDimensions` (`src/adapters/video-compositor/component.ts:60`). An invalid frame is dropped with a `logger.warn`. It never allocates a canvas or buffer.
- **Carried learnings** (from `docs/specs/loom-camera-overlay/learnings/`):
  - `npx --yes yarn@1.22.22 lint:fix` fixes `import/order`.
  - Any change to the `ILiveKitPublisher`, `IVideoCompositor` or AppComponents shape requires updating the mocks in `test/unit/presentation-manager.spec.ts:11-100`.
  - `RemoteVideoTrack` and `RemoteTrack` are imported with `import type`.
  - The I420 buffer type is `5`, `VideoBufferType.I420`.
- **Test-first** (user rule). In phases 1–4, write the phase's tests first, run them, and record the failing run (or, for phase 1's smoke gate, the passing baseline) in the phase learning JSON before implementing.
- **Pushing.** The pre-push hook runs a bare `yarn typecheck && yarn test`. Executors do not push. Whoever ships runs the hook's checks with v1 (`npx --yes yarn@1.22.22 typecheck && npx --yes yarn@1.22.22 test`) first. If the hook's bare `yarn` then fails under yarn 4, stop and ask the user rather than bypassing the hook.
- **Verification.** Every phase runs `npx --yes yarn@1.22.22 lint:fix && npx --yes yarn@1.22.22 typecheck && npx --yes yarn@1.22.22 lint && npx --yes yarn@1.22.22 test`.

## Key design decisions

- **Patch caching.** `ICameraOverlay` caches the latest camera frame as RGBA and rebuilds the `d×d` patch (circular clip, I420 plus alpha) lazily inside `stamp()` when the camera frame or `d` changed. That way the patch always matches the output width.
- **Anti-aliased edge.** Stamping blends Y per pixel and U/V per 2×2 block using the patch alpha. Even `left`, `top` and `d` keep chroma aligned.
- **Idle output.** When no video is playing, camera frames (≤20 fps) drive output, stamping over `session.baseFrame`. That is the slide as I420 (converted once per slide change with `rgbaToI420`) or the unstamped frozen video frame while paused. With the camera inactive, the heartbeat pushes `baseFrame` as before.
- **Video output.** While a video plays, ffmpeg frames drive output. `startPlayback` receives a `decorateFrame` callback that returns either a stamped copy or the original frame. `lastPushedFrame` stays unstamped, so pause re-stamps the live bubble on the frozen frame.
- **Throttled broadcast.** State broadcasts after overlay updates are throttled to at most one per 250 ms, carrying the latest layout, so a drag does not flood `setMetadata`. Other mutations keep broadcasting immediately.
- **No public manager method.** The data-channel handler is the only caller, so `IPresentationManager` gets no `updateOverlay` method.
- **Camera handler before connect.** The publisher fires `active` once per track, during or right after `connect`, and never replays it. The manager therefore creates each session's overlay and registers the camera handler before `connect`, and the handler never looks up the session to start the overlay.
- **Heartbeat on the stamped frame.** Idle output pushes the stamped frame and restarts the heartbeat with it, so a stalled camera still yields frames.

## Scope challenge

- **P1** stops at rung 5 (newer versions of installed dependencies). The user asked for it; it brings the rtc-node FD/memory leak fixes (0.13.25–0.13.26) and the canvas `drawImage` no-copy change (1.0.8, #1325). `pdfjs-dist` 4.10 → 6.3.289 is included only because canvas 1.x otherwise installs a second canvas copy (pdfjs < 6 pins `^0.1.x`). The user chose the co-upgrade over keeping canvas 0.1.x. Cut: codec, encoder and degradation tuning (simulcast is already off and H.264 already set at `livekit-publisher/component.ts:326-331`).
- **P2** stops at rung 2 (reuses the crop and arc-clip drawing from `camera-overlay-compositor/component.ts:115-142` and `rgbaToI420` from `src/logic/color-convert.ts:15`). The module is new only because two diverging geometry copies exist (`camera-overlay-compositor/component.ts:10-40`, `video-compositor/component.ts:69-116`). Cut: native YUV scaling and SIMD.
- **P3** is deletion-first: it removes the ffmpeg camera plumbing (`pipe:3`, `readFirstCameraFrame`, the camera pump), the camera branch of `buildFilterComplex`, the restart-on-flip, and the whole canvas compositor. Cut: sidecar and encode-once work, which stays in `docs/specs/sidecar-publisher/`.
- **P4** stops at rung 2 (the existing command switch, state builder and validation style). Cut: a visibility flag (camera mute covers it), rate limiting (presenter-only), and a public manager method.
- **Out of scope:** the bubble over a real browser screen share, which never reaches this server.

## Phases

| Phase | Name | Depends on | Writes | Role | Model | Status |
|---|---|---|---|---|---|---|
| 1 | [Dependency upgrade](phase-1-dependency-upgrade.md) | — | `package.json`, `yarn.lock`, `.eslintrc.json`, `src/adapters/livekit-publisher/`, `src/adapters/pdf-renderer/`, `test/unit/livekit-publisher.spec.ts`, `test/fixtures/one-slide.pdf` | developer | balanced | done |
| 2 | [Camera overlay stamper](phase-2-camera-overlay-stamper.md) | 1 | `src/adapters/camera-overlay/`, `test/unit/camera-overlay.spec.ts` | developer | balanced | done |
| 3 | [Stamp all output paths](phase-3-stamp-all-paths.md) | 2 | `src/adapters/video-compositor/`, `src/adapters/camera-overlay-compositor/`, `src/logic/presentation-manager/`, `src/controllers/handlers/create-presentation-handler.ts`, `src/components.ts`, `src/types.ts`, `test/unit/presentation-manager.spec.ts`, `test/unit/build-filter-complex.spec.ts`, `test/unit/video-compositor.spec.ts` | developer | deep | done |
| 4 | [Overlay command and state](phase-4-overlay-command-and-state.md) | 3 | `src/logic/presentation-manager/`, `test/unit/presentation-manager.spec.ts`, `test/mocks/context.ts`, `test/integration/loom-overlay.spec.ts`, `docs/architecture.md`, `docs/ai-agent-context.md`, `docs/video-playback-lifecycle.md` | developer | balanced | done |

Phase 3 is `deep` because it rewires the camera / play / pause / end / error state machine in `presentation-manager/component.ts`, where a missed transition leaves a stale heartbeat interleaving with stamped frames (flicker) or a bubble that never returns.

## Integration order

Strictly serial: 1 → 2 → 3 → 4. Each later phase builds on the previous phase's types and dependency versions, and phases 3 and 4 both write `presentation-manager/`. The frontend spec can run in parallel with any of these phases. End-to-end checks need phase 4 plus frontend phase 1.

## Completion

- `npx --yes yarn@1.22.22 lint && npx --yes yarn@1.22.22 typecheck && npx --yes yarn@1.22.22 test` pass on the integrated branch.
- `docker build .` succeeds.
- `rg -n "camera-overlay-compositor|OverlayConfig|OverlayCorner|overlayCorner|readFirstCameraFrame|restartPlaybackOnCameraFlip|camera-resolution-changed|pipe:3" src test docs --glob '!docs/specs/**'` returns nothing.
- Manual smoke, run if a dev LiveKit room is available (otherwise recorded as skipped in `learnings/phase-4.json`): `npx --yes yarn@1.22.22 start:dev`, start a presentation from the sites streamer view with the camera **already on before starting**, then check:
  - the bubble appears bottom-left;
  - `presentation:overlay:update` moves it on slides, on a playing video and on a paused video;
  - turning the camera off hides it.
- Shipping: one PR on top of `feat/loom-camera-overlay` (or stacked PRs per phase with `gh-stack`), before merging to `main`.

## Follow-ups (not in this spec)

- `docs/specs/sidecar-publisher/` (untracked, unsigned) bakes composites at download time. A live bubble can't be baked, so that spec must keep the live single-encode path whenever a presenter camera is active. Update it when that work resumes.
- Subscribe to the presenter camera's lowest simulcast layer if rtc-node exposes it: the bubble is at most 25% of slide width, so a full-resolution decode and `convert` is wasted CPU.
- Reuse a scratch buffer in `decorateFrame` instead of a full-frame copy per frame, once it is confirmed that `VideoSource.captureFrame` copies synchronously.
- Check whether `livekit-publisher/component.ts:446-479`'s manual FFI dispose workaround is still needed on rtc-node 1.1.0.
