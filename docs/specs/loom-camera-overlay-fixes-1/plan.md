# Spec: Fix-spec 1 for loom-camera-overlay

## Problem

The first `/plan-plus:review` pass over the `loom-camera-overlay` feature surfaced two security findings of Medium-or-higher severity and several code-quality findings (dead code, redundant per-frame allocations, duplicated branches, over-broad helper signatures). This fix-spec closes those findings so a second review iteration can run cleanly.

Source reports (do not modify):
- `docs/specs/loom-camera-overlay/review.md`
- `docs/specs/loom-camera-overlay/security-review.md`

### Current state

| # | Detail | Location |
|---|--------|----------|
| 1 | Camera frame dimensions (`rgba.width`/`rgba.height`) are taken directly from remote presenters with no upper bound, then used for `Buffer.from(rgba.data)`, `createCanvas(...)`, and ffmpeg `-s WxH` argv. High-severity DoS. | `src/adapters/video-compositor/component.ts:286-309,574-588`; `src/adapters/camera-overlay-compositor/component.ts:71-122` |
| 2 | `livekit-publisher` connect-time fallback eagerly subscribes to every `SOURCE_CAMERA` publication regardless of presenters allowlist. Medium-severity bandwidth amplification. | `src/adapters/livekit-publisher/component.ts:264-276` |
| 3 | `ICameraOverlayCompositor.getTrack()` and its closure variable `currentTrack` are dead — never called; Phase 5 reads `session.lastPresenterCameraTrack` instead. | `src/adapters/camera-overlay-compositor/types.ts:31-32`; `src/adapters/camera-overlay-compositor/component.ts:50,131,144-146,160` |
| 4 | `composeFrame` allocates a redundant intermediate `camCanvas` (and a `fullCam` canvas) per frame, on top of the slide canvas, at 20 fps. | `src/adapters/camera-overlay-compositor/component.ts:71-122` |
| 5 | `startPlayback` opens a `VideoStream` to read one frame for dimensions, cancels it, then opens a *second* `VideoStream` on the same track for the pump. | `src/adapters/video-compositor/component.ts:286-309,668-705` |
| 6 | `setupSlideOutput` takes `cameraOverlayCompositor` and `logger` as parameters that shadow its enclosing closure — every call site passes the same closure references. | `src/logic/presentation-manager/component.ts:229-236,525,682,1020` |
| 7 | Restart-on-camera-flip blocks at active/inactive branches are byte-identical except for a log message. | `src/logic/presentation-manager/component.ts:420-432,455-466` |
| 8 | Low-severity hardening: ffmpeg stderr logged verbatim; RGBA buffers aliased without copy; empty-string `presenters` entries accepted; `videoUrl` echoed over the data channel in error broadcasts. | `src/adapters/video-compositor/component.ts:633-636,859-863`; `src/adapters/camera-overlay-compositor/component.ts:83-88,97-101`; `src/adapters/livekit-publisher/component.ts:61-71`; `src/logic/presentation-manager/component.ts:296-307,749,776,913,993` |

## Solution

1. Introduce a shared media-dimension validator and apply it at every boundary where camera width/height are sourced from remote tracks (Phase 1, security).
2. Narrow the camera subscription fallback in `livekit-publisher` to participants present in the `presenters` allowlist (Phase 2, security).
3. Drop the dead `getTrack()` API and its closure variable from the camera-overlay compositor (Phase 3, cleanup).
4. Hoist the per-frame canvas allocations in `composeFrame` into closure state, drop the intermediate `camCanvas`, and reuse the first opened `VideoStream` for the pump in `video-compositor` (Phase 3, cleanup).
5. Drop the redundant parameters from `setupSlideOutput` and extract the duplicated restart-on-camera-flip block into a local helper (Phase 4, cleanup).
6. Apply defense-in-depth fixes for the four Low-severity findings (Phase 5).

## Phase dependency graph

```
Phase 1 (security: dim validation) ─┐
Phase 2 (security: narrow subscribe) ┤
Phase 3 (cleanup: allocations + dead getTrack) ─┐
Phase 4 (cleanup: helper signatures + extract dup) ─┤
Phase 5 (defense-in-depth lows) ─────────────────────┴──> done
```

Phases 1–5 are independent of one another and may run in parallel. Each touches a disjoint set of locations (Phase 1: video-compositor + camera-overlay-compositor argv/allocation paths; Phase 2: livekit-publisher subscribe block; Phase 3: camera-overlay-compositor closure + video-compositor `readFirstCameraFrame`/pump; Phase 4: presentation-manager helper + handler; Phase 5: scattered low-severity fixes across files).

> Note on overlap: Phase 1 and Phase 3 both edit `src/adapters/camera-overlay-compositor/component.ts`. The Phase 3 canvas-hoisting changes are upstream of where Phase 1's validation gate fires, so the two diffs are co-located but non-conflicting. If the executor encounters a merge conflict, apply Phase 1 first (security takes priority) and re-derive Phase 3's edits from the prose anchors.

## Execution protocol

Before starting any phase, read **every file** in the `learnings/` directory (alphabetical = phase order). After finishing — pass, fail, or partial — append a dated section to `learnings/phase-N.md` (create it if it doesn't exist) following the format in `learnings/README.md`. The directory is the bridge between fresh-context agents; keep entries terse and load-bearing.

If the executor is run with `--worktree`, each phase runs in its own git worktree branched off the launch branch and is eagerly merged back on pass. Spec authors don't encode anything special — phase files write to repo-relative paths exactly as in the non-worktree mode.

## Phases

| Phase | File | Summary | Status |
|-------|------|---------|--------|
| 1 | [phase-1-camera-dimension-validation.md](phase-1-camera-dimension-validation.md) | Validate remote camera frame dimensions before allocation and ffmpeg argv. | done |
| 2 | [phase-2-narrow-camera-subscribe.md](phase-2-narrow-camera-subscribe.md) | Gate `setSubscribed(true)` on the presenters allowlist. | done |
| 3 | [phase-3-allocation-and-dead-code-cleanup.md](phase-3-allocation-and-dead-code-cleanup.md) | Hoist per-frame canvases, reuse first VideoStream, remove dead `getTrack()`. | done |
| 4 | [phase-4-helper-shape-cleanup.md](phase-4-helper-shape-cleanup.md) | Drop redundant `setupSlideOutput` params; extract restart-on-flip helper. | done |
| 5 | [phase-5-defense-in-depth.md](phase-5-defense-in-depth.md) | Filter empty presenters, copy RGBA buffers, drop `videoUrl` from broadcasts, redact ffmpeg stderr. | done |

## Key design decisions

| Decision | Rationale |
|----------|-----------|
| Centralize camera-dimension validation in a single helper (`validateMediaDimensions`) co-located with `validateFilterParam` in `video-compositor/component.ts` | The systemic-risk section of `security-review.md` recommends a single boundary helper; `validateFilterParam` already lives there and is exported, so adding a sibling keeps the validation surface in one place. |
| Phase 1 uses the same numeric cap as `validateFilterParam` (max 7680) | Matches the existing slide-side cap and the security review's explicit recommendation. |
| Phase 3 reuses the first `VideoStream`/`reader` opened to learn camera dimensions for the pump | The review report calls out the dual-construction as a literal interpretation of the design comment; reusing the live reader removes a redundant allocation and an artificial dependency on the camera delivering its first frame before ffmpeg can spawn. |
| Drop `getTrack()` rather than wire it up | Phase 5 already reads the track from `session.lastPresenterCameraTrack` (per `learnings/phase-5.md` from the parent spec); the getter has no caller. |
| Defense-in-depth Lows live in one phase (Phase 5) rather than per-finding | Each individual Low is a few-line edit; bundling keeps the spec light and verifies as a unit. |
| Order: security before cleanup | Per `/plan-plus:one-shot` convention, Medium+ security findings are the gating reason this iteration exists. Cleanup phases can run in parallel after the security phases land. |

## Future work

Deferred from the prior code-quality review (`docs/specs/loom-camera-overlay/review.md`) because they fall outside this fix-spec's required scope. Each is a self-contained edit that can be picked up later:

- `parseOverlayConfigFromFields` is a one-line wrapper over `parseOverlayConfigFromBody` (`src/controllers/handlers/create-presentation-handler.ts:46-48`). Could be inlined or `parseOverlayConfigFromBody` widened to accept the union.
- `pump()`'s opening `if (!reader) return` guard (`src/adapters/camera-overlay-compositor/component.ts:52-53`) is dead-on-arrival because `start()` assigns `reader` synchronously before invoking `pump`.
- The `&& session.pausedVideoIndex >= 0` clause in the restart-on-flip guards (`src/logic/presentation-manager/component.ts:422,456`) is always true when `videoState === 'playing'`.
- `overlayConfig` is on the public `PresentationSession` interface (`src/logic/presentation-manager/types.ts:18-33`) but never read across the public boundary — move to an `InternalSession`-only field.
- Architectural opportunity from the review's Section 2 ("Hoist canvas allocations out of the per-frame hot path") is partially addressed in Phase 3; the optional deferred `test/unit/camera-overlay-compositor.spec.ts` benchmark to lock the budget is not included here.

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
   - **Reusable utilities / patterns** — note in the doc with `file:line` references (e.g., the new `validateMediaDimensions` helper).
   - **Gotchas, surprising constraints, war stories** — main body of the lessons doc.
   - **Drop**: transient stuff (flaky test on retry 2), spec-specific facts already in `plan.md`, or anything obvious from the code.

The raw `learnings/phase-*.md` files stay alongside the spec as the unfiltered record.
