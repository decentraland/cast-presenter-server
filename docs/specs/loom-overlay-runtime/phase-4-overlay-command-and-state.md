# Phase 4: Overlay command and state

## Outcome

- Presenters can send `presentation:overlay:update` to move or resize the bubble at runtime.
- The current layout travels in `presentation:state` and in bot metadata as `overlay`.
- State broadcasts caused by overlay updates are throttled: at most one per 250 ms, carrying the latest layout.
- The docs describe the new behaviour, and the dead `describe.skip` integration file is removed.

## Dependencies

Phase 3.

## Write ownership

- `src/logic/presentation-manager/component.ts`, `src/logic/presentation-manager/types.ts`
- `test/unit/presentation-manager.spec.ts`, `test/mocks/context.ts`
- `test/integration/loom-overlay.spec.ts` (delete)
- `docs/architecture.md`, `docs/ai-agent-context.md`, `docs/video-playback-lifecycle.md`

## Context

Anchors are from base sha `2c6cdd12e0267306818af9540eede56d67203655`. Phase 3 shifted lines in `component.ts`, so locate each one by its cited token.

- **Command switch:** `publisher.setDataHandler(async (message) => {` → `switch (message.type)`. The `case 'presentation:navigate':` (base `:354-366`) shows the validation idiom: check each field and `break` on bad input. `case 'presentation:get-state':` is the last case (base `:381-383`).
- **Authorization** already happens before dispatch (`livekit-publisher/component.ts:255-260`). Add no extra check.
- **State:** `getStateFromSession(session)` (base `:1117-1131`) builds `PresentationState` (`types.ts:45-61`). `broadcastState` (base `:273-288`) publishes `presentation:state` and calls `updateMetadataState`.
- **Session fields:** `InternalSession` holds `preDownloadTimer: ReturnType<typeof setTimeout> | null` (base `:69`), and `stopSession` clears it (base `:1066-1069`). Mirror that pattern for the broadcast timer.
- **Overlay API from phase 2/3:** `session.cameraOverlay.getLayout()` / `setLayout(layout)`, `OverlayLayout`, `OVERLAY_SIZES` and `DEFAULT_OVERLAY_LAYOUT` from `../../adapters/camera-overlay`.
- **Existing command tests:** `test/unit/presentation-manager.spec.ts`. The pattern captures `publisher.setDataHandler.mock.calls[0][0]` and asserts `publisher.publishData`. It covers invalid input with `describe.each` (base `:236-318`).
- **Docs:** `docs/architecture.md:138-167` is the "Loom-style camera overlay" section, which is now wrong. `:169-209` holds the commands and state JSON. `docs/ai-agent-context.md:60-63` lists the commands. `test/integration/loom-overlay.spec.ts:38` is an empty `describe.skip`.

## Steps

**Test-first.** Write step 6's tests first, run them, and record the failing output in the learning JSON. Then do steps 1–5 and 7–9.

1. **`types.ts`.** Add `overlay: OverlayLayout` to `PresentationState` (`:45-61`), with the JSDoc "Camera-bubble layout; bubble centre as fractions of the slide." Import the type from `../../adapters/camera-overlay`.

2. **`component.ts`, state builder.** In `getStateFromSession`, add `overlay: session.cameraOverlay.getLayout()` after `videoState`.

3. **`component.ts`, module-level parser.** Add `parseOverlayUpdate(message: Record<string, unknown>): Partial<OverlayLayout> | null`:
   - For each of `x` and `y` that is present (`!== undefined`): return `null` unless `typeof v === 'number' && Number.isFinite(v)`. Otherwise include it clamped to `[0, 1]`.
   - For `size` when present: return `null` unless `typeof size === 'string' && (OVERLAY_SIZES as readonly string[]).includes(size)`.
   - Return the partial, which may be empty.

4. **`component.ts`, broadcast throttle.** Add `overlayBroadcastTimer: ReturnType<typeof setTimeout> | null` to `InternalSession`, initialised to `null` in the session literal. Add `scheduleOverlayBroadcast(session)`:
   - If a timer is pending, return.
   - Otherwise set `session.overlayBroadcastTimer = setTimeout(() => { session.overlayBroadcastTimer = null; broadcastState(session).catch(() => undefined) }, OVERLAY_BROADCAST_INTERVAL_MS)` with `const OVERLAY_BROADCAST_INTERVAL_MS = 250` at module top.
   - In `stopSession`, clear it next to `preDownloadTimer`.

5. **`component.ts`, command case.** Add `case 'presentation:overlay:update':` before `case 'presentation:get-state':`:
   - `const patch = parseOverlayUpdate(message)`
   - `if (!patch || Object.keys(patch).length === 0) break`
   - `session.cameraOverlay.setLayout({ ...session.cameraOverlay.getLayout(), ...patch })`
   - `scheduleOverlayBroadcast(session)`
   - `break`

   No frame push is needed. The next camera frame or ffmpeg frame applies the layout.

6. **Tests** in `test/unit/presentation-manager.spec.ts`. Make the phase-3 overlay mock keep real layout state (`setLayout` stores a copy; `getLayout` returns it, initialised to `DEFAULT_OVERLAY_LAYOUT`) and use `jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] })` in this block's `beforeEach` with `jest.useRealTimers()` in `afterEach`, so the file's `flushMicrotasks` helper (`test/unit/presentation-manager.spec.ts:112-114`, which awaits `setImmediate`) keeps working. Advance time with `await jest.advanceTimersByTimeAsync(250)`. Also add `overlay: { x: 0, y: 1, size: 'small' }` to `createMockPresentationState` in `test/mocks/context.ts:16-25`, because the type now requires it. Add `describe('when a presenter sends presentation:overlay:update', …)`:

| Case | Expected |
|---|---|
| `{ x: 0.5, y: 0.25, size: 'large' }` | `setLayout` called with `{ x: 0.5, y: 0.25, size: 'large' }` |
| `{ size: 'large' }` only | `setLayout` keeps the previous x/y |
| `{ x: 2, y: -1 }` | stored as `{ x: 1, y: 0 }` |
| `describe.each`: `{ x: NaN }`, `{ x: '0.5' }`, `{ y: Infinity }`, `{ size: 'medium' }` | `setLayout` not called |
| `{}` | `setLayout` not called and no broadcast scheduled |
| three valid updates within 100 ms, then advance timers 250 ms | exactly one `publishData` with `type: 'presentation:state'`, carrying the last `overlay`; `updateMetadataState` called once with that `overlay` |
| `presentation:get-state` after session creation | broadcast state includes `overlay: DEFAULT_OVERLAY_LAYOUT` |
| stop the session with a pending timer | no broadcast after advancing timers |

7. Delete `test/integration/loom-overlay.spec.ts`.

8. **`docs/architecture.md`.** Replace the "Loom-style camera overlay" section (`:138-167`) with a short section covering:
   - the bubble shows in every session while a presenter camera is active;
   - one stamping step in `src/adapters/camera-overlay/`, with camera frames driving slide and paused output and ffmpeg frames decorated during playback;
   - the geometry rule and default layout;
   - runtime moves via the command, with no ffmpeg restart.

   Add `{ "type": "presentation:overlay:update", "x": 0.5, "y": 0.5, "size": "large" }` to the commands block, with one sentence on partial updates and dropping invalid ones. Add `"overlay": { "x": 0, "y": 1, "size": "small" }` to the state JSON example.

9. **`docs/ai-agent-context.md` (`:60-63`).** Add `overlay:update` to the listed commands.

    **`docs/video-playback-lifecycle.md`.** After the pause/resume section (`:43-60`) and in the heartbeat section (`:82-101`), add one short paragraph each saying that while a presenter camera is active, idle output (slide or frozen frame) is pushed per camera frame with the bubble stamped, and the heartbeat repeats the last stamped frame.

## Verification

```sh
npx --yes yarn@1.22.22 lint:fix && npx --yes yarn@1.22.22 typecheck && npx --yes yarn@1.22.22 lint
npx --yes yarn@1.22.22 test test/unit/presentation-manager.spec.ts
npx --yes yarn@1.22.22 test
git diff --quiet HEAD -- yarn.lock package.json
rg -n "overlayCorner|overlaySize|camera-overlay-compositor" src test docs --glob '!docs/specs/**'
test ! -e test/integration/loom-overlay.spec.ts
```

The `rg` prints nothing and the file test succeeds.

## Completion criteria

- Every row of the step 6 table has a passing test, and the full suite passes.
- `presentation:state` and metadata include `overlay`.
- The docs match the wire contract in `plan.md`.
- The diff stays inside write ownership.

## Learning output

Write only `docs/specs/loom-overlay-runtime/learnings/phase-4.json` using plan-plus `docs/learning-schema.md` (schema v2, `scope: "project"`). Include whether the end-to-end manual smoke from `plan.md` "Completion" ran, or why it was skipped.
