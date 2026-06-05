# Spec: Fix-spec 2 for loom-camera-overlay

## Problem

Iteration-2 review of `loom-camera-overlay-fixes-1` reports **security clean** (severity-counts all zero — the High and Medium findings closed in fix-spec 1 stayed closed, and no new vulnerabilities were found). The residual cluster is small code-quality cleanups in the same area. This fix-spec closes them so iteration-3 review can pass with no Critical+High+Medium findings on either side.

Source reports (do not modify):
- `docs/specs/loom-camera-overlay-fixes-1/review.md`
- `docs/specs/loom-camera-overlay-fixes-1/security-review.md` (clean — only a `track`-priority systemic-risk note about ffmpeg stderr fragments in thrown error messages; out of scope for this fix-spec and recorded in **Future work** below)

### Current state

| # | Detail | Location |
|---|--------|----------|
| 1 | `_cameraStream` is write-only: declared, assigned in `startPlayback`, nulled in `stopPlayback` + `cleanup`, but never read. The `VideoStream` lifecycle is driven entirely through `cameraReader.cancel()`. | `src/adapters/video-compositor/component.ts:143,500,715,1008` |
| 2 | Pre-spawn `validateMediaDimensions(cameraInit.width, cameraInit.height, 'ffmpegCameraInput')` re-runs the same validation `readFirstCameraFrame` already performed (no mutation between the two sites). | `src/adapters/video-compositor/component.ts:562` (re-validates values from `:327`) |
| 3 | Camera pump's `validateMediaDimensions(value.frame.width, value.frame.height, 'cameraPump')` is unreachable behind the equality check on line 724 — if dimensions match `camWidth`/`camHeight` they were already validated at `:327`; if they differ the prior branch already breaks out. The `camera-resolution-invalid` reason has no live path. | `src/adapters/video-compositor/component.ts:724-737` |
| 4 | `playVideoSession`'s `compositor.onEnd` callback duplicates the create-compositor + stopHeartbeat + `overlay.start` (with the `/* I420 */ 5` push callback) sequence that lives in the `setPresenterCameraTrackHandler` 'active' branch, and re-resolves the publisher logger inline (`logs.getLogger(\`livekit-publisher:${session.id}\`)`) instead of reusing the closure-captured `publisherLogger`. | `src/logic/presentation-manager/component.ts:422-433` vs `932-958` |

## Solution

1. Delete the dead `_cameraStream` variable and its three assignment sites in `video-compositor/component.ts` (Phase 1).
2. Drop the two redundant `validateMediaDimensions` calls in `video-compositor/component.ts` — pre-spawn `:562` and the pump's `:732` + its try/catch (keep the equality check at `:724`, which is the load-bearing one) (Phase 1).
3. Extract a `startCameraOverlayPump(session, logger)` helper in `presentation-manager/component.ts` that runs the create-compositor → assign → stopHeartbeat → `overlay.start(…/* I420 */ 5)` sequence. Call it from both the `'active'` branch and the `onEnd` block, reusing the closure-captured `publisherLogger` at both sites (Phase 2).

## Phase dependency graph

```
Phase 1 (video-compositor cleanups: _cameraStream + 2 redundant validations) ─┐
Phase 2 (presentation-manager: extract startCameraOverlayPump helper) ────────┴──> done
```

Phases 1 and 2 are independent (disjoint files) and may run in parallel.

## Execution protocol

Before starting any phase, read **every file** in the `learnings/` directory (alphabetical = phase order). After finishing — pass, fail, or partial — append a dated section to `learnings/phase-N.md` (create it if it doesn't exist) following the format in `learnings/README.md`. The directory is the bridge between fresh-context agents; keep entries terse and load-bearing.

## Phases

| Phase | File | Summary | Status |
|-------|------|---------|--------|
| 1 | [phase-1-video-compositor-deadcode.md](phase-1-video-compositor-deadcode.md) | Remove `_cameraStream` write-only variable and two redundant `validateMediaDimensions` calls. | pending |
| 2 | [phase-2-extract-camera-overlay-pump-helper.md](phase-2-extract-camera-overlay-pump-helper.md) | Extract `startCameraOverlayPump` helper, share between active-branch and onEnd; reuse `publisherLogger`. | pending |

## Key design decisions

| Decision | Rationale |
|----------|-----------|
| Drop both redundant `validateMediaDimensions` calls rather than keeping one as defense-in-depth | The boundary validation at `readFirstCameraFrame:327` is the canonical entry-point check; the equality check at `:724` is the load-bearing guard for "ffmpeg can't change input resolution mid-stream." Re-validating the same values is dead defense, not extra safety — the security review already confirmed the boundary is correct. |
| Helper lives co-located with `restartPlaybackOnCameraFlip` in `presentation-manager/component.ts` (not a separate module) | The duplicated block is local to one file and one closure; both call sites need access to `cameraOverlayCompositor` (from the closure), `publisherLogger` (from the closure), and `session.publisher.pushFrame`. A local helper keeps the closure captures implicit, matches the existing `restartPlaybackOnCameraFlip` pattern, and avoids an exported surface that would force passing all the closure values explicitly. |
| Reuse `publisherLogger` (closure-captured) at both call sites | Finding 5 from the review (the logger-construction inconsistency between the two `createCompositor` call sites) collapses into the same fix once the helper is extracted — both sites pass through the helper, which uses the closure-captured `publisherLogger`. The `logs.getLogger(\`livekit-publisher:${session.id}\`)` inline call in `onEnd` resolves to the same logger object as `publisherLogger`. |
| Delete `_cameraStream` outright (no replacement) | The `VideoStream` lifecycle is already managed via `cameraReader.cancel()`; the variable was kept "for resource-ownership tracking" per `learnings/phase-3.md` of fix-spec 1, but no code consults it. If a future need to dispose the stream separately arises, reintroduce it then. |

## Future work

Deferred from this iteration's reports:
- **Systemic-risk note from `security-review.md` Section 2** (priority: track) — ffmpeg stderr fragments still leak into thrown `Error` messages (`video-compositor/component.ts:280`, "Remux failed"). The raw `err.message` is logged at `presentation-manager/component.ts:766`. Recommended approach: introduce a typed `RemuxFailedError` with `code` + private `tail`; have `classifyVideoError` and log sites consume only the stable code; reserve raw stderr for one `logger.debug` at capture time. Not in scope here because it requires touching the error-classification surface, not just the loom-camera-overlay diff.

## Verification

After every phase status reaches `done`, run from the repository root:

```bash
yarn install
yarn typecheck
yarn lint
yarn test
yarn build
```

## When shipping (consolidation step)

Once all phases are `done` and the fix-spec is verified, distill the per-phase learnings into the project's lessons doc.

1. **Read** every file in `learnings/phase-*.md`.
2. **Locate the project's lessons convention.** Default: `docs/learning/loom-camera-overlay.md` (the same file the parent spec writes to). Before defaulting, check for existing dirs in this order: `docs/learning/`, `docs/lessons/`, `docs/postmortems/`, or any path documented in `AGENTS.md` / `CLAUDE.md`. If one is in use, follow it.
3. **Append** to that doc (do not overwrite the parent spec's section). Sort learnings into:
   - **Codebase conventions discovered** — promote to `CLAUDE.md` / `AGENTS.md` instead of the lessons doc.
   - **Reusable utilities / patterns** — note in the doc with `file:line` references (e.g., the new `startCameraOverlayPump` helper).
   - **Gotchas, surprising constraints, war stories** — main body of the lessons doc.
   - **Drop**: transient stuff (flaky test on retry 2), spec-specific facts already in `plan.md`, or anything obvious from the code.

The raw `learnings/phase-*.md` files stay alongside the spec as the unfiltered record.
