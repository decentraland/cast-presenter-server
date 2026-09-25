# Code-quality re-review — loom-overlay-runtime (repair-1)

## Review summary

- **Scope:** the repair delta `b2a6209..c17591a` (`src/adapters/camera-overlay/component.ts`, `src/adapters/pdf-renderer/component.ts`, `test/unit/camera-overlay.spec.ts`), read in the run checkout `.worktrees/loom-overlay-runtime/run`. The camera handler and idle-output paths in `src/logic/presentation-manager/component.ts` were read for context only. Lens: code-quality, no persona.
- **State machine traced:** every pump exit (loop-head ownership loss, post-read ownership loss, `done`, `read()` rejection), `start()` replacing a live reader, `start()` with a constructor failure, `stop()` during a pending read, and `stop()`/`start()` after the pump has detached itself.
  - The tail guard `if (reader !== ownReader) return` (`component.ts:151`) is sound. `running` is only ever set to `false` together with `reader` being nulled or reassigned in the same synchronous block (`:194-196`, `:215-217`, `:152-154`). So `reader === ownReader` at the tail means this pump still owns the reader and nobody else has cancelled it.
  - **No double cancel:** `stop()` and `start()` null or replace `reader` before cancelling, so a superseded pump returns at `:151`. After a self-detach `reader` is `null`, so a later `stop()` or `start()` cancels nothing.
  - **No restart race:** when `start(B)` runs while A's `read()` is pending, A resumes, fails `isCurrent`, and returns at `:151` without touching B's state. When B's constructor throws, `reader` stays `null` and `running` stays `false`, so A's pump also returns and the overlay is inactive.
  - The definite assignment of `let ownReader` through `try`/`catch { return }` (`:198-206`) is valid TypeScript.
- **Tests can fail:** each new case fails against `b2a6209`.
  - `:432-434` fails because the old code converted before validating.
  - `:464-467` fails because the old outer `catch` ended the pump.
  - `:478-484` fails because the old pump left `running`/`hasFrame` set and never cancelled.
  - `:505-511` fails because the old `start()` threw with `running` still `true`.
  - The `Date.now` spy is restored by `jest.restoreAllMocks()` (`:252`).
- **Conventions:** the diff adds no code comments. `describeError` (`component.ts:9`) replaces three inline copies in the lines the repair already touched. That is shared-logic extraction, not scope creep. The `pdf-renderer` change is the one-line fix and nothing else.
- **Counts (new findings only):** Critical 0, High 0, Medium 0, Low 1, Informational 2.
- **Blocking threshold:** medium.
- **Verdict: `pass`.** M1, L1 and L5 are resolved. The repair introduced no blocking finding.

## Prior findings

| Id | Title | Status | Evidence |
|---|---|---|---|
| M1 (`f-bbd736635e088b5b`) | One bad frame kills the pump; unbounded `VideoStream` backlog; `start()` construction failure | **resolved** | See below |
| L1 | Convert before validating dimensions | **resolved** | `component.ts:105-111` validates `event.frame.width`/`height` before `convert`. `camera-overlay.spec.ts:432-434` asserts `convert` is not called for a 99999-wide frame. |
| L5 | Floating `loadingTask.destroy()` promise | **resolved** | `pdf-renderer/component.ts:136` is `doc.loadingTask.destroy().catch(() => undefined)`. |

M1 was resolved in three parts:

- **One bad frame no longer ends the pump.** `component.ts:142-146` wraps each `acceptFrame` call in its own `try`/`catch`. `camera-overlay.spec.ts:441-468` throws on the first `convert` and asserts that the second frame fires the callback and the overlay stays active.
- **A pump that exits on its own now detaches and cancels.** On a `read()` rejection or `done`, the tail at `component.ts:151-157` nulls `reader`/`stream`, clears `running`/`hasFrame`/`patch`, and calls `ownReader.cancel().catch(() => undefined)`. This unhooks the FFI listener, so the unread-queue growth is gone. `spec:470-485` covers the rejection.
- **A `start()` construction failure is contained.** `component.ts:192-211` cancels the old reader, clears `running`/`hasFrame` before construction, catches a throw from `VideoStream`/`getReader`, logs, and returns inactive. `spec:487-516` covers it.

Still open, unchanged by this repair: L2 (stale frozen frame on navigate after resume), L3 (first-wins presenter camera, replan), L4 (no test for `start()` replacing a live reader; the new restart-failure case at `spec:487-516` does not assert `readerA.cancel`), L6 (missing `onError`-overlay and invalid-command broadcast guards), and I1–I4.

## New findings

### [LOW] N1 A pump that detaches itself leaves the last stamped frame on the idle heartbeat

- **Evidence:**
  - `src/adapters/camera-overlay/component.ts:151-157`: the self-detach path clears state and cancels, but tells no one.
  - The same is true of the `start()` failure return at `:202-205`.
  - `src/logic/presentation-manager/component.ts:252-253`: the last `pushIdleFrame` started the publisher heartbeat on a stamped copy.
  - `:493`: the only overlay callback is `pushIdleFrame`, and it runs only on accepted frames.
  - `:240`: `pushIdleFrame` returns early once `isActive()` is false.
  - `:363-371`: `refreshIdleOutput` runs only on the publisher's `inactive` event. It does not run when the overlay goes inactive on its own.
- **Defect:** when the pump exits on a `read()` rejection, on `done` without a matching `inactive` event, or when a re-`active` `start()` fails to construct, the overlay reports inactive. But the idle output keeps repeating the last stamped frame through the heartbeat. Nothing restores the plain slide until an unrelated `refreshIdleOutput`, such as a pause, navigate, or `inactive` event.
- **Impact:** a frozen camera bubble on the slide, which is the same visible symptom M1 listed. The memory and liveness half of M1 is fixed. The visual half remains on these rare paths. This is cosmetic and bounded to one session. It was not part of M1's stated remediation, so it is not a regression of that finding.
- **Remediation (bounded):**
  - Have the overlay run its callbacks once after the self-detach at `:151-157` and after the `start()` failure return.
  - In the manager, register `() => refreshIdleOutput(session)` instead of `pushIdleFrame` at `:493`. When the overlay is active, `refreshIdleOutput` delegates to `pushIdleFrame`, so the hot path does not change. When it is inactive, it pushes the plain base frame and restarts the heartbeat on it.
  - Add one manager test: with the camera active, make the overlay go inactive without an `inactive` event, and assert that the heartbeat restarts on the unstamped base.
- **Scope:** in-scope (phases 2 and 3). Not blocking.

### [INFORMATIONAL] N2 A persistent `convert` failure now logs a warning on every accepted frame

- **Evidence:** `component.ts:139-146`. `lastAcceptedAt` is set before `acceptFrame`, so a `convert` that fails every time logs `camera-overlay frame error` up to 20 times a second until the presenter mutes or the session stops.
- **Impact:** log volume only. The stream is drained, so memory stays bounded. This matches the existing per-frame `dropped frame` warning for invalid dimensions (`:107-108`).
- **Remediation, optional:** count consecutive frame errors and `break` into the detach tail after a small N (for example 20), or log only the first error of each streak.
- **Scope:** in-scope, not required.

### [INFORMATIONAL] N3 The new `done` → inactive transition has no test

- **Evidence:**
  - `component.ts:138,151-157`: a stream that ends with `done: true` now detaches the overlay. Before, the overlay stayed active on a frozen frame.
  - The only self-detach test (`camera-overlay.spec.ts:470-485`) drives a `read()` rejection.
- **Impact:** moving the tail inside the `catch` block would still pass the suite, and it would restore the old frozen-but-active behaviour at end of stream.
- **Remediation, optional:** add a case that pushes `{ done: true }` after one frame, and assert that `isActive()` is `false` and `readerA.cancel` was called.
- **Scope:** in-scope, not required.

## Severity counts

| Severity | Count | Blocking |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 1 | — |
| Informational | 2 | — |

Prior blocking M1 (`f-bbd736635e088b5b`): resolved.
