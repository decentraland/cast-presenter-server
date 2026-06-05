# Security review — loom-camera-overlay

Generated 2026-05-21 by `/plan-plus:review` (red-team agent).

## Scope

Files reviewed:
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/camera-overlay-compositor/component.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/camera-overlay-compositor/index.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/camera-overlay-compositor/types.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/livekit-publisher/component.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/livekit-publisher/types.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/adapters/video-compositor/component.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/controllers/handlers/create-presentation-handler.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/logic/presentation-manager/component.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/src/logic/presentation-manager/types.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/test/integration/loom-overlay.spec.ts
- /Users/gabriel.diazdecentraland.org/Projects/cast-presenter-server/test/unit/build-filter-complex.spec.ts

## Section 1 — Vulnerabilities

### 🟠 High — Unbounded camera frame size enables memory DoS
- **File + line**: `src/adapters/video-compositor/component.ts:286-309` (`readFirstCameraFrame`, `firstFrameRgba` allocation) and `src/adapters/video-compositor/component.ts:582-588` (camera `-s ${width}x${height}` argv) and `src/adapters/camera-overlay-compositor/component.ts:71-122` (`composeFrame` allocates `createCanvas(rgba.width, rgba.height)` and `Buffer.from(rgba.data)`).
- **Attack vector**: A user whose identity is listed in the room's `presenters` metadata can publish a `SOURCE_CAMERA` track at any resolution they choose. `cameraInit.width`/`height` and `rgba.width`/`height` are taken directly from the remote track with no upper bound. RGBA byte size is `4 * width * height`; a presenter publishing a 8192×8192 (or pathological) frame causes the server to allocate ~256 MB per frame in `Buffer.from(rgba.data)` and `createCanvas(rgba.width, rgba.height)`, repeated at 20 fps. The `validateFilterParam` cap of 7680 is applied to the *slide* dimensions only — never to the camera dimensions before they reach `-s ${camWidth}x${camHeight}` or the canvas allocator.
- **Impact**: Memory exhaustion / OOM crash of the cast-presenter-server process; trivially weaponizable by any attacker who can act as a presenter (the threat model includes hostile participants in the LiveKit room).
- **Remediation**: Validate `cameraFrame.width`/`height` against a hard cap (e.g. ≤ 1920×1080 or ≤ 7680 to match `validateFilterParam`) at the boundary in both `readFirstCameraFrame` and the camera pump loop and in `camera-overlay-compositor/component.ts::composeFrame`. Reject (or downscale) frames exceeding the cap, surface an error reason like `camera-resolution-invalid`, and add the same check to the canvas-only path before allocating.

### 🟡 Medium — Eager `setSubscribed(true)` on every camera publication enables bandwidth amplification
- **File + line**: `src/adapters/livekit-publisher/component.ts:264-276`
- **Attack vector**: On connect, the publisher loops over every remote participant and unconditionally calls `publication.setSubscribed(true)` on every `SOURCE_CAMERA` publication, regardless of whether the participant is in the presenters allowlist. A room with N hostile participants (each streaming a high-bitrate camera) coerces the server to subscribe to all N tracks. Only the *first* presenter gates the `presenterCameraHandler` activation, but the SFU still delivers every subscribed stream onto the wire and into `@livekit/rtc-node` decode buffers.
- **Impact**: Bandwidth and CPU exhaustion of the server; cost amplification on the LiveKit egress side. Each unauthorized subscription decodes media the application never uses.
- **Remediation**: Gate `setSubscribed(true)` on `presenters.has(participant.identity.toLowerCase())`. Mirror the same filter inside `RoomMetadataChanged`, `TrackSubscribed`, and `TrackUnmuted` so newly-recognized presenters get subscribed and non-presenters get unsubscribed when removed from the presenters list.

### 🟡 Medium — Camera dimensions are interpolated into ffmpeg argv without integer / range validation
- **File + line**: `src/adapters/video-compositor/component.ts:574-588`
- **Attack vector**: `cameraInit.width` and `cameraInit.height` come straight from the LiveKit `VideoFrame` and are interpolated into `-s ${cameraInit.width}x${cameraInit.height}`. While `spawn` argv is not a shell-injection sink, missing validation here means: (a) zero/negative/NaN-shaped values (if a future SDK release changes types) could cause ffmpeg to misparse the input descriptor and silently fall back; (b) huge values cause ffmpeg itself to allocate framebuffers that exceed the slide-side `validateFilterParam` cap. The slide path uses `validateFilterParam` for `slideWidth`/`slideHeight`; the camera path bypasses that check entirely.
- **Impact**: Defense-in-depth gap: relies on `@livekit/rtc-node` always returning sane integers. Combined with the High finding above, it materially worsens the DoS surface.
- **Remediation**: Reuse `validateFilterParam(cameraInit.width, 'camWidth')` and the same for height; reject the playback path (fire `'camera-resolution-invalid'`) when validation fails, rather than spawning ffmpeg with attacker-influenced argv.

### 🔵 Low — ffmpeg stderr (last 500 bytes) is logged on abnormal exit and may include file paths
- **File + line**: `src/adapters/video-compositor/component.ts:633-636, 859-863`
- **Attack vector**: When the composite ffmpeg process exits non-zero, `compositeStderr` (which can contain the temp slide path, the downloaded video path, and `-filter_complex` content including camera config) is written to the logger. If logs are shipped to a less-trusted destination than the cast-presenter-server, this widens the disclosure perimeter.
- **Impact**: Information disclosure (server-side temp paths, presentation IDs embedded in temp dir names). No direct exploitability.
- **Remediation**: Redact or whitelist what gets logged: log only the exit code and a fixed-format reason, and keep the raw stderr at debug level (or scrubbed of `currentSlidePath` / `videoPath`).

### 🔵 Low — Slide buffer aliased into a Uint8ClampedArray without copy, exposed to canvas APIs
- **File + line**: `src/adapters/camera-overlay-compositor/component.ts:83-88`
- **Attack vector**: `new Uint8ClampedArray(slideBuffer.buffer, slideBuffer.byteOffset, slideBuffer.byteLength)` aliases the renderer's slide buffer. If a future code path swaps `slide` while `pump` is mid-`composeFrame`, the alias keeps pointing into the previous slide's memory. Today the swap is atomic at the `slide` reference level, but the cropped-camera path (`fullCam.getContext('2d').putImageData(camImageData, 0, 0)`) similarly aliases `rgba.data.buffer`, which is owned by the underlying LiveKit native frame; reading after `convert()` returns may race with native release.
- **Impact**: Defense-in-depth — torn reads or use-after-free in native code. No demonstrable attack path on `@napi-rs/canvas` today.
- **Remediation**: `Buffer.from(rgba.data)` (copy) before constructing `camImageData`; do the same for the slide. The current canvas-pump path already discards the source frame each iteration, so the copy cost is bounded.

### 🔵 Low — `presenters` allowlist normalizes only on the read side
- **File + line**: `src/adapters/livekit-publisher/component.ts:61-71, 96, 251`
- **Attack vector**: `parsePresentersFromRoomMetadata` lowercases identities on parse, and checks use `(participant.identity || '').toLowerCase()` on lookup. The empty-string fallback means a participant with no identity (`identity === ''` or `null`) is compared against a set that could in theory contain `''` if the room metadata's `presenters` array contained an empty string. JSON-parsed array entries are not validated to be non-empty strings before being inserted via `.map((p: string) => p.toLowerCase())`. A misconfigured room metadata `presenters: ['']` would auto-trust anonymous participants.
- **Impact**: Auth bypass *only* if room metadata is misconfigured upstream; no direct compromise of the server itself.
- **Remediation**: Filter out empty/non-string entries: `.filter((p): p is string => typeof p === 'string' && p.length > 0).map(p => p.toLowerCase())`. Also reject participants whose identity is falsy in `maybeActivatePresenterCamera` *before* the `presenters.has` check.

### 🔵 Low — `videoUrl` echoed back over the data channel in error broadcasts
- **File + line**: `src/logic/presentation-manager/component.ts:296-307, 749, 776, 913, 993`
- **Attack vector**: Error broadcasts include `videoUrl`, which may be a third-party URL extracted from the uploaded PDF/PPTX. While the PDF/PPTX is presenter-supplied (already trusted to be loaded server-side), echoing the URL into a chatty data-channel message gives every room participant the raw URL, which may be a signed/short-lived URL (e.g. Google Drive temporary download link). No direct compromise of the server, but a Drive-style signed URL pasted into a Loom-style overlay PDF gets fanned out to all viewers.
- **Impact**: Disclosure of presigned URLs to viewers who would not otherwise see them.
- **Remediation**: Replace `videoUrl` with `videoIndex` only in the broadcast payload, or hash/strip the URL before broadcast. Presenters can correlate `videoIndex` with the local presentation; viewers don't need the URL.

## Section 2 — Systemic Risk (follow-up PRs)

### Pattern: External media dimensions are interpolated into resource allocations and ffmpeg argv without bounds checks
- **Examples in codebase**:
  - `src/adapters/video-compositor/component.ts:286-309` (`readFirstCameraFrame` allocates `Buffer.from(rgba.data)` with unchecked width × height)
  - `src/adapters/video-compositor/component.ts:574-588` (camera `-s WxH` argv)
  - `src/adapters/camera-overlay-compositor/component.ts:81, 95, 103` (`createCanvas(slideWidth, slideHeight)`, `createCanvas(diameter, diameter)`, `createCanvas(rgba.width, rgba.height)`)
- **Recommended approach**: Centralize a `validateMediaDimensions(width, height, ctx)` helper that enforces hard caps (matching the existing `validateFilterParam`'s `max = 7680`) and a minimum (≥ 1). Call it at every boundary where width/height come from external media (downloaded video probes, remote camera frames, render outputs). Fail closed with a typed error that surfaces as a user-visible `presentation:error` rather than a process-level OOM.
- **Priority**: before next release.

### Pattern: Sub-component output paths echo through to the data channel without sanitization
- **Examples in codebase**:
  - `src/logic/presentation-manager/component.ts:749, 776, 913, 993` (`videoUrl` in `broadcastError`)
  - `src/logic/presentation-manager/component.ts:1092` (`session.id` in `presentation:stopped` — lower sensitivity but same pattern)
- **Recommended approach**: Define an allowlist of fields safe to broadcast (slide index, video index, opaque error codes, redacted reasons) and route broadcasts through a single serializer that drops everything else. Treat the data channel as a public bus.
- **Priority**: this quarter.

### Pattern: ffmpeg stderr buffers logged verbatim
- **Examples in codebase**:
  - `src/adapters/video-compositor/component.ts:633-636, 766-769` (composite + audio stderr aggregation and warn-level logging on abnormal exit)
- **Recommended approach**: Keep ffmpeg stderr at debug level only, or run it through a redactor that strips absolute paths and the `-filter_complex` body. Surface a short stable reason (`'remux-failed' | 'decode-failed' | …`) to operators.
- **Priority**: track.
