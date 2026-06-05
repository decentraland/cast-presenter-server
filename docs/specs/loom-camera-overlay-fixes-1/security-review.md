# Security review — loom-camera-overlay-fixes-1

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

## Prior-iteration findings — verification

| Iteration-1 finding | Status | Evidence |
|---|---|---|
| High — Unbounded camera frame size enables memory DoS | **Closed** | `validateMediaDimensions` defined at `video-compositor/component.ts:60-67` (7680 cap). Applied in `readFirstCameraFrame` (`:327`), pre-spawn (`:562`), camera-pump loop (`:732`), and `composeFrame` (`camera-overlay-compositor/component.ts:88`). Invalid dimensions surface as the typed `camera-resolution-invalid` reason and fire `abortPlayback`. |
| Medium — Eager `setSubscribed(true)` on every camera publication | **Closed** | Connect-time loop now skips non-presenters: `if (!presenters.has(identity)) continue` at `livekit-publisher/component.ts:292`. `RoomMetadataChanged` mirrors the filter and explicitly unsubscribes non-presenter publications (`:151-184`). |
| Medium — Camera dimensions interpolated into ffmpeg argv without validation | **Closed** | Pre-spawn `validateMediaDimensions(cameraInit.width, cameraInit.height, 'ffmpegCameraInput')` at `video-compositor/component.ts:562` runs before the `-s ${width}x${height}` interpolation at `:622-624`. |
| Low — ffmpeg stderr logged verbatim on abnormal exit | **Closed (partial — see Section 2)** | `compositeProcess` close handler now warns with only `{ code }` and routes raw stderr to `logger.debug` (`:925-926`). Audio path mirrors the pattern (`:830-831`). Remux-failure message (`:280`) still embeds `stderr.slice(-300)` into the thrown `Error` message; this is downgraded but not redacted. |
| Low — Slide / RGBA buffers aliased without copy | **Closed** | `composeFrame` now copies via `ArrayBuffer.slice` on both the slide (`camera-overlay-compositor/component.ts:103`) and the camera RGBA (`:123`), detaching from LiveKit / renderer-owned memory before constructing `ImageData`. |
| Low — Empty-string `presenters` entries accepted | **Closed** | Filter at `livekit-publisher/component.ts:68` (`typeof p === 'string' && p.length > 0`). Anonymous-identity guard at `:100`. |
| Low — `videoUrl` echoed in error broadcasts | **Closed** | `broadcastError` now carries only `{ code, message, videoIndex? }` at `presentation-manager/component.ts:287-303`. No `videoUrl` field anywhere in the broadcast call sites. |

## Section 1 — Vulnerabilities

No findings.

## Section 2 — Systemic Risk

### Pattern: ffmpeg stderr fragments still leak into thrown error messages
- **Examples in codebase**:
  - `src/adapters/video-compositor/component.ts:280` (`new Error(\`Remux failed (code ${code}): ${stderr.slice(-300)}\`)`) — the rejected error propagates to `classifyVideoError` which inspects `err.message` and re-emits user-facing copy, but the raw `err.message` is also passed through `logger.warn` at `presentation-manager/component.ts:766`. Any local file path or `-filter_complex` body present in remux stderr ends up in the application log line alongside the `videoPath`.
- **Recommended approach**: Hold raw stderr behind a private context field on a typed error class (e.g. `RemuxFailedError` with `code` + `tail`), and have `classifyVideoError` / log sites consume only the stable code. Reserve raw stderr for `logger.debug` once, at the point it is captured. This closes the residual leak while keeping the operator-visible reason intact.
- **Priority**: track.

