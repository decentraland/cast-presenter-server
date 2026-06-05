# Spec: Loom-style circular camera overlay on the presentation track

## Problem

Loom popularised a UX pattern: the presenter's webcam appears as a small circular bubble overlaid on top of the screen recording. LiveKit transmits camera and presentation as **separate tracks**, so the circular composition has to happen *somewhere*. This spec composes the presenter's camera onto the **presentation track** (the slide stream produced by `cast-presenter-server`). Screen-share composition is out of scope.

### Current state

| # | Detail | Location |
|---|--------|----------|
| 1 | Server publishes one video track at H.264 / 6 Mbps via LiveKit. | `src/adapters/livekit-publisher/component.ts:187-205` |
| 2 | When no embedded video plays, a static slide buffer is re-pushed every 500 ms (heartbeat). | `src/adapters/livekit-publisher/component.ts:213-218` |
| 3 | When an embedded video plays, ffmpeg composites with `[1:v]scale=…[vid];[0:v][vid]overlay=x:y:shortest=1`. | `src/adapters/video-compositor/component.ts:434, 447-480` |
| 4 | Presenter identity is already parsed from room metadata into a `Set<string>`. | `src/adapters/livekit-publisher/component.ts:57-67, 112-120` |
| 5 | Server has no subscriber path — it only publishes. No `trackSubscribed` listener exists. | `src/adapters/livekit-publisher/component.ts:80-185` |
| 6 | `POST /presentations` accepts JSON `{ url, livekitToken, livekitUrl }` or multipart. No overlay-related fields. | `src/controllers/handlers/create-presentation-handler.ts:44-112` |
| 7 | `PresentationSession` carries no overlay config. | `src/logic/presentation-manager/types.ts:6-19` |
| 8 | `ILiveKitPublisher` exposes `pushFrame` + `startHeartbeat`; no per-frame callback for an external pump. | `src/adapters/livekit-publisher/types.ts:9-23` |

## Solution

1. Plumb a session-scoped `overlayConfig` (`corner` + `size`) from the `POST /presentations` payload all the way into the session record.
2. Subscribe to the presenter's `SOURCE_CAMERA` track in `livekit-publisher`; expose lifecycle callbacks for when the track becomes active or inactive.
3. Build a new `camera-overlay-compositor` adapter that, given a slide buffer and a camera `VideoStream`, draws each camera frame onto the slide via `@napi-rs/canvas` with a circular clip and converts the result to I420.
4. Wire the new compositor into the publisher's slide-only flow — replacing the 500 ms heartbeat with a ~20 fps camera frame pump while the camera is active. Fall back to the existing heartbeat when the camera goes away.
5. Extend `video-compositor` to take an optional third ffmpeg input (camera frames via a FIFO) so the camera circle also appears during embedded-video playback.
6. Cover the four 2×2 mode-transition cells with integration tests.

## Phase dependency graph

```
Phase 1 ──┬──> Phase 2 ──┐
          └──> Phase 3 ──┴──> Phase 4 ──> Phase 5 ──> Phase 6
```

Phases 2 and 3 are independent of each other after Phase 1 lands and can run in parallel.

## Execution protocol

Before starting any phase, read **every file** in the `learnings/` directory (alphabetical = phase order). After finishing — pass, fail, or partial — append a dated section to `learnings/phase-N.md` (create it if it doesn't exist) following the format in `learnings/README.md`. The directory is the bridge between fresh-context agents; keep entries terse and load-bearing.

If the executor is run with `--worktree`, each phase runs in its own git worktree branched off the launch branch and is eagerly merged back on pass. Spec authors don't encode anything special — phase files write to repo-relative paths exactly as in the non-worktree mode.

## Phases

| Phase | File | Summary | Status |
|-------|------|---------|--------|
| 1 | [phase-1-overlay-config-plumbing.md](phase-1-overlay-config-plumbing.md) | Add `overlayConfig` to the create-presentation payload and the session record. | done |
| 2 | [phase-2-camera-track-subscription.md](phase-2-camera-track-subscription.md) | Subscribe to the presenter's camera track and surface a lifecycle callback. | done |
| 3 | [phase-3-canvas-overlay-compositor.md](phase-3-canvas-overlay-compositor.md) | New `camera-overlay-compositor` adapter (canvas-based, no ffmpeg). | done |
| 4 | [phase-4-slide-only-camera-wire-up.md](phase-4-slide-only-camera-wire-up.md) | Replace heartbeat with the camera frame pump when the camera is active. | done |
| 5 | [phase-5-ffmpeg-three-input-pipeline.md](phase-5-ffmpeg-three-input-pipeline.md) | Extend `video-compositor`'s ffmpeg pipeline with a third (camera FIFO) input. | done |
| 6 | [phase-6-integration-tests.md](phase-6-integration-tests.md) | End-to-end tests covering the four 2×2 mode cells. | done |

## Key design decisions

| Decision | Rationale |
|----------|-----------|
| Composition lives in `cast-presenter-server`, not in the `cast2` client | The presentation track is rendered server-side. The screen-share track is rendered client-side in `cast2` (out of scope here). |
| Trigger is automatic (camera-track lifecycle), not a new data-channel command | One less wire-protocol surface to maintain. The existing presenter parsing already tells us *whose* track to watch. |
| Two composition paths — pure-canvas for slide+camera, ffmpeg for slide+video+camera | Mirrors the existing dichotomy (`startHeartbeat` vs `video-compositor`). Avoids spawning ffmpeg when there's no embedded video playing. |
| Frame rate stays at 20 fps (the existing `FRAME_RATE` constant) | Consistency with embedded-video composite output. If the camera arrives faster, drop; slower, repeat the last frame. |
| Multiple-presenters policy: subscribe to the first presenter whose camera is live | Simple, deterministic, no extra UI needed. Document the rule; revisit if multi-presenter UX becomes a real ask. |
| Camera frame is **center-square-cropped** before circular clip | Webcams are typically 16:9 or 4:3; centering the square keeps the face in the middle of the circle. |
| Overlay config is immutable per session | Set in `POST /presentations`; no `presentation:overlay:*` data-channel command. Keeps the per-session state machine flat. |
| Discrete size buckets (S/M/L → 15/20/25 % of slide width) | Matches user-friendly client UI and avoids exposing arbitrary floats the server must clamp. |
| Margin from edge = 2 % of slide width (a code constant, not a payload field) | Hidden tunable; one less knob in the public API. |

## Verification

For each phase, run the local checks listed in that phase's "Verification" section. Before declaring the spec done overall:

```bash
yarn install
yarn typecheck
yarn lint
yarn test
yarn build
```

Plus the manual end-to-end verification described in `phase-6-integration-tests.md`.

## When shipping (consolidation step)

Once all phases are `done` and the feature is verified end-to-end, distill the per-phase learnings into a single durable doc. The `learnings/` directory itself stays in place — do not delete it.

1. **Read** every file in `learnings/phase-*.md`.
2. **Locate the project's lessons convention.** Default: `docs/learning/loom-camera-overlay.md`. Before defaulting, check for existing dirs in this order: `docs/learning/`, `docs/lessons/`, `docs/postmortems/`, or any path documented in `AGENTS.md` / `CLAUDE.md`. If one is in use, follow it.
3. **Write the distilled doc**, sorting learnings into:
   - **Codebase conventions discovered** — promote to `CLAUDE.md` / `AGENTS.md` instead of the lessons doc.
   - **Reusable utilities / patterns** — note in the doc with `file:line` references.
   - **Gotchas, surprising constraints, war stories** — main body of the lessons doc.
   - **Drop**: transient stuff (flaky test on retry 2), spec-specific facts already in `plan.md`, or anything obvious from the code.

The raw `learnings/phase-*.md` files stay alongside the spec as the unfiltered record.

## Risks / open questions surfaced during planning

- **`@napi-rs/canvas` per-frame cost** at 20 fps on a 1920×1080 surface. Likely fine, but Phase 3 includes a smoke benchmark.
- **ffmpeg circular alpha mask** in the 3-input pipeline. The filter graph uses `geq` to build a per-pixel circular alpha; the spec includes the exact graph plus a stand-alone `ffmpeg` invocation an executor can copy/paste to verify locally.
- **Explicit subscription** in `@livekit/rtc-node`. The room may use auto-subscribe; if not, Phase 2 has to call `publication.setSubscribed(true)` on each presenter camera publication. Phase 2's verification step proves which path the room uses.
- **FIFO portability**. `mkfifo(3)` is POSIX. Phase 5 has to confirm the Docker image (Node 24 base, see `Dockerfile`) ships with the required permissions on `/tmp`. If a FIFO is awkward in CI, the fallback is to spawn ffmpeg with `stdio: ['pipe', …]` and feed the camera over an aux stdin FD — Phase 5 documents both options.
