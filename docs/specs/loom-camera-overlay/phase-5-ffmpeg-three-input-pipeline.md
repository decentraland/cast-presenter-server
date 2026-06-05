# Phase 5: Extend `video-compositor`'s ffmpeg pipeline with a camera input

## Dependencies

- Phase 4 (relies on `session.cameraOverlayCompositor` and `session.presenterCameraActive` being authoritative).

## Goal

When an embedded video plays **and** the presenter camera is active, ffmpeg composites three layers: slide background (input 0) + embedded video (input 1) + circular camera bubble (input 2, fed via an auxiliary stdin pipe). When the camera is inactive, the existing 2-input path runs unchanged.

State transitions inside an active playback (camera flips on/off) force an ffmpeg restart with the appropriate filter graph, using the existing `-ss` resume mechanism to preserve video position.

## Files to modify (2)

| File | Change |
|------|--------|
| `src/adapters/video-compositor/component.ts` | Extend `startPlayback` to optionally take a camera `RemoteVideoTrack` + `OverlayConfig`; build the 3-input ffmpeg args + extended `filter_complex`; pump RGBA camera frames into `proc.stdio[3]`. |
| `src/logic/presentation-manager/component.ts` | Pass `session.overlayConfig` and the active camera track into `startPlayback`; restart playback when camera state changes mid-video. |

## Steps

### 1. `src/adapters/video-compositor/component.ts` — Extend imports

The file imports `VideoBufferType, VideoStream` would help but we keep all imports relative to the existing structure. Add to the existing `@livekit/rtc-node` imports (currently the file has none — `livekit-publisher` is the only place that touches the SDK). Add:

```typescript
import { VideoStream, VideoBufferType } from '@livekit/rtc-node'
import type { RemoteVideoTrack, VideoFrame as RtcVideoFrame } from '@livekit/rtc-node'
import type { OverlayConfig } from '../../logic/presentation-manager/types'
```

### 2. `src/adapters/video-compositor/component.ts` — Extend `IVideoCompositor` interface

The interface lives in `src/adapters/video-compositor/types.ts`. The `startPlayback` declaration there matches the implementation. Add two new optional trailing parameters:

```typescript
  startPlayback(
    videoPath: string,
    videoInfo: SlideVideoInfo,
    slideBuffer: Buffer,
    slideWidth: number,
    slideHeight: number,
    publisher: ILiveKitPublisher,
    onAudioData?: (pcmChunk: Buffer) => void,
    seekSeconds?: number,
    presenterCamera?: { track: RemoteVideoTrack; overlayConfig: OverlayConfig }
  ): Promise<void>
```

(Import `RemoteVideoTrack` and `OverlayConfig` at the top of `types.ts` to match.)

### 3. `src/adapters/video-compositor/component.ts` — Extend the `startPlayback` implementation signature

The function starts at line 390. Update its parameter list to match the interface:

```typescript
    async startPlayback(
      videoPath: string,
      videoInfo: SlideVideoInfo,
      slideBuffer: Buffer,
      slideWidth: number,
      slideHeight: number,
      publisher: ILiveKitPublisher,
      onAudioData?: (pcmChunk: Buffer) => void,
      seekSeconds?: number,
      presenterCamera?: { track: RemoteVideoTrack; overlayConfig: OverlayConfig }
    ): Promise<void> {
```

### 4. `src/adapters/video-compositor/component.ts` — Pre-read the camera's first frame to learn its dimensions

Right after the existing `validateFilterParam(...)` block (currently lines 404-407 — the four validateFilterParam calls), but **before** the `compositeFrameSize` calculation at line 409, insert:

```typescript
      // Pre-read one camera frame to learn its resolution. ffmpeg needs `-s WxH` at
      // spawn time for the raw RGBA input; we can't change it later without restart.
      // Lifetime: this reader is closed here on success/failure; the long-lived
      // VideoStream for ongoing frames is constructed below after ffmpeg starts.
      let cameraInit: { width: number; height: number; firstFrameRgba: Buffer } | null = null
      if (presenterCamera) {
        cameraInit = await readFirstCameraFrame(presenterCamera.track)
      }
```

Then add `readFirstCameraFrame` as a private function inside the `createVideoCompositor` closure (drop it adjacent to the existing `tryDownload` helper around line 214):

```typescript
async function readFirstCameraFrame(
  track: RemoteVideoTrack
): Promise<{ width: number; height: number; firstFrameRgba: Buffer }> {
  const stream = new VideoStream(track)
  const reader = stream.getReader()
  try {
    const { value, done } = await reader.read()
    if (done || !value) {
      throw new Error('Camera stream ended before first frame')
    }
    const rgba = value.frame.convert(VideoBufferType.RGBA)
    return {
      width: rgba.width,
      height: rgba.height,
      firstFrameRgba: Buffer.from(rgba.data)
    }
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* already cancelled */
    }
  }
}
```

### 5. `src/adapters/video-compositor/component.ts` — Build the extended filter graph

Replace the single `filterComplex` line at line 434 with a branch:

```typescript
      const filterComplex = buildFilterComplex({
        videoOverlay: { x, y, w: vw, h: vh },
        camera:
          presenterCamera && cameraInit
            ? {
                config: presenterCamera.overlayConfig,
                slideWidth,
                slideHeight
              }
            : null
      })
```

And add the `buildFilterComplex` helper next to `validateFilterParam` (currently at lines 40-44 — top-level exported function). AFTER:

```typescript
const SIZE_RATIO: Record<OverlayConfig['size'], number> = {
  small: 0.15,
  medium: 0.2,
  large: 0.25
}
const MARGIN_RATIO = 0.02

export function buildFilterComplex(opts: {
  videoOverlay: { x: number; y: number; w: number; h: number }
  camera: { config: OverlayConfig; slideWidth: number; slideHeight: number } | null
}): string {
  const { x, y, w: vw, h: vh } = opts.videoOverlay
  if (!opts.camera) {
    return `[1:v]scale=${vw}:${vh}[vid];[0:v][vid]overlay=${x}:${y}:shortest=1`
  }
  const { config, slideWidth, slideHeight } = opts.camera
  const D = Math.round(slideWidth * SIZE_RATIO[config.size])
  const margin = Math.round(slideWidth * MARGIN_RATIO)
  const r = D / 2
  let cx = 0
  let cy = 0
  switch (config.corner) {
    case 'TL':
      cx = margin
      cy = margin
      break
    case 'TR':
      cx = slideWidth - margin - D
      cy = margin
      break
    case 'BL':
      cx = margin
      cy = slideHeight - margin - D
      break
    case 'BR':
      cx = slideWidth - margin - D
      cy = slideHeight - margin - D
      break
  }
  validateFilterParam(D, 'D')
  validateFilterParam(cx, 'cx', Math.max(slideWidth, slideHeight))
  validateFilterParam(cy, 'cy', Math.max(slideWidth, slideHeight))

  // [2:v] is the raw RGBA camera; crop to a center square, scale to D, add alpha plane,
  // then mask via geq so pixels outside the inscribed circle become transparent.
  const cam =
    `[2:v]crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':'(ih-min(iw,ih))/2',` +
    `scale=${D}:${D},format=yuva420p,` +
    `geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lte(hypot(X-${r},Y-${r}),${r}),255,0)'[cam]`

  return (
    `[1:v]scale=${vw}:${vh}[vid];` +
    `[0:v][vid]overlay=${x}:${y}:shortest=1[bg];` +
    cam +
    `;[bg][cam]overlay=${cx}:${cy}`
  )
}
```

The exported `buildFilterComplex` is reusable from unit tests in Phase 6.

### 6. `src/adapters/video-compositor/component.ts` — Extend the ffmpeg args with the camera input

The existing `ffmpegArgs` array is at lines 447-480. Replace it with a builder that conditionally appends a third input. AFTER (replace the whole `const ffmpegArgs = [...]` block at lines 447-480):

```typescript
      const cameraInputArgs = cameraInit
        ? [
            '-threads',
            '1',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'rgba',
            '-s',
            `${cameraInit.width}x${cameraInit.height}`,
            '-r',
            String(FRAME_RATE),
            '-i',
            'pipe:3'
          ]
        : []

      const ffmpegArgs = [
        '-protocol_whitelist',
        protocols,
        '-threads',
        '1',
        '-stream_loop',
        '-1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        '-s',
        `${slideWidth}x${slideHeight}`,
        '-r',
        String(FRAME_RATE),
        '-i',
        currentSlidePath,
        '-threads',
        '1',
        ...seekArgs,
        '-re',
        '-i',
        videoPath,
        ...cameraInputArgs,
        '-filter_complex',
        filterComplex,
        '-an',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(FRAME_RATE),
        'pipe:1'
      ]
```

### 7. `src/adapters/video-compositor/component.ts` — Spawn ffmpeg with an extra stdio fd, then pump camera frames into it

The existing spawn is at line 482. Update it to include `'pipe'` for `fd:3` when camera is configured:

```typescript
      const stdioConfig: ('ignore' | 'pipe')[] = cameraInit
        ? ['ignore', 'pipe', 'pipe', 'pipe']
        : ['ignore', 'pipe', 'pipe']
      compositeProcess = spawn('ffmpeg', ffmpegArgs, { stdio: stdioConfig })
```

Then, after the existing `compositeProcess.on('error', ...)` block (around line 497-500), add the camera-frame pump. AFTER:

```typescript
      let cameraStream: VideoStream | null = null
      let cameraReader: ReadableStreamDefaultReader<{ frame: RtcVideoFrame }> | null = null

      if (presenterCamera && cameraInit && compositeProcess.stdio[3]) {
        const cameraStdin = compositeProcess.stdio[3] as NodeJS.WritableStream

        // Write the pre-read first frame so ffmpeg gets data immediately.
        cameraStdin.write(cameraInit.firstFrameRgba)

        cameraStdin.on('error', (err: Error) => {
          // ffmpeg may EPIPE this fd on its own shutdown — we don't want it to crash us.
          logger.warn(`Camera stdin error: ${err.message}`)
        })

        cameraStream = new VideoStream(presenterCamera.track)
        cameraReader = cameraStream.getReader()

        void (async () => {
          try {
            while (isPlaying && cameraReader) {
              const { value, done } = await cameraReader.read()
              if (done) break
              if (value.frame.width !== cameraInit.width || value.frame.height !== cameraInit.height) {
                // Resolution changed mid-stream — we need to restart ffmpeg with new -s.
                // Bubble up as a recoverable error; presentation-manager restarts playback.
                logger.warn(
                  `Camera resolution changed (${cameraInit.width}x${cameraInit.height} → ${value.frame.width}x${value.frame.height}), aborting`
                )
                abortPlayback('camera-resolution-changed', publisher, slideBuffer, slideWidth, slideHeight)
                break
              }
              const rgba = value.frame.convert(VideoBufferType.RGBA)
              const ok = cameraStdin.write(Buffer.from(rgba.data))
              if (!ok) {
                // Back-pressure — wait for drain before reading more.
                await new Promise<void>((resolve) => cameraStdin.once('drain', resolve))
              }
            }
          } catch (err) {
            logger.warn(
              `Camera pump error: ${err instanceof Error ? err.message : String(err)}`
            )
          } finally {
            try {
              cameraStdin.end()
            } catch {
              /* already closed */
            }
          }
        })()
      }
```

### 8. `src/adapters/video-compositor/component.ts` — Add the new error reason

Find `src/adapters/video-compositor/types.ts`. The `CompositorErrorReason` type lists the existing reasons. Add `'camera-resolution-changed'`:

```typescript
export type CompositorErrorReason =
  | 'video-stream-error'
  | 'video-playback-interrupted'
  | 'audio-processing-failed'
  | 'camera-resolution-changed'
```

(Confirm by grepping the existing union — copy verbatim from current file, add the new member.)

### 9. `src/adapters/video-compositor/component.ts` — Tear down the camera reader on stop

Inside the existing `stopPlayback` function (lines 340-368), right after the `if (audioProcess) { … }` block (lines 358-361), add:

```typescript
    if (cameraReader) {
      cameraReader.cancel().catch(() => {})
      cameraReader = null
    }
    cameraStream = null
```

`cameraReader` and `cameraStream` are closure variables declared inside `startPlayback` — they need to be hoisted to the same closure level as `compositeProcess`. Move the two `let` declarations from inside `startPlayback` up to the top of `createVideoCompositor`, alongside `let compositeProcess: ChildProcess | null = null` at line 51. The new top-of-closure block:

```typescript
  let compositeProcess: ChildProcess | null = null
  let audioProcess: ChildProcess | null = null
  let cameraStream: VideoStream | null = null
  let cameraReader: ReadableStreamDefaultReader<{ frame: RtcVideoFrame }> | null = null
```

Then remove the local `let cameraStream = null; let cameraReader = null` lines from inside `startPlayback` (the ones added in step 7) — they shadow the closure scope.

Apply the same teardown inside `cleanup()` (lines 712-745). Right after the existing `if (audioProcess) { … }` block (lines 729-732), add the same three lines as in stopPlayback.

### 10. `src/logic/presentation-manager/component.ts` — Pass overlay config + camera track into `startPlayback`

Find the `compositor.startPlayback(...)` call (currently at line 712, inside `playVideoSession`). The call currently passes `seekSeconds > 0 ? seekSeconds : undefined` as the eighth argument; add a ninth argument for `presenterCamera`. After the change, the call reads:

```typescript
      await compositor.startPlayback(
        videoPath,
        videoInfo,
        session.lastFrameBuffer,
        session.lastFrameWidth,
        session.lastFrameHeight,
        session.publisher,
        onAudioData,
        seekSeconds > 0 ? seekSeconds : undefined,
        session.overlayConfig && session.presenterCameraActive && session.cameraOverlayCompositor?.getTrack()
          ? { track: session.cameraOverlayCompositor.getTrack()!, overlayConfig: session.overlayConfig }
          : undefined
      )
```

Phase 3 already declares `getTrack()` on `ICameraOverlayCompositor` (added during self-review), so no Phase-3 back-fill is needed here.

While the ffmpeg pipeline owns the camera track for the duration of playback, the canvas pump in Phase 4 must NOT also be reading from it — two readers on a single `VideoStream` race. Right *before* this `startPlayback` call, if the canvas pump is running, stop it (without nulling `session.cameraOverlayCompositor`, so we can resume on video-end):

```typescript
      if (session.cameraOverlayCompositor && session.presenterCameraActive) {
        await session.cameraOverlayCompositor.stop().catch(() => {})
      }
```

And in the `compositor.onEnd(...)` handler (currently at line 752), right after `session.compositor = null` (line 755), restart the canvas pump if the camera is still active:

```typescript
      if (session.presenterCameraActive && session.overlayConfig && session.lastFrameBuffer) {
        // Re-create and restart the canvas pump for slide-only mode.
        const overlay = cameraOverlayCompositor.createCompositor(publisherLogger, session.overlayConfig)
        session.cameraOverlayCompositor = overlay
        // The original RemoteVideoTrack handle is still valid as long as the
        // presenter hasn't unpublished — pull it from the publisher.
        // (Phase 2 retained `activePresenterCameraSid`; expose a getter if
        // needed, or hold the last-seen track on the session itself.)
        // For v1, fire the canvas pump asynchronously without blocking onEnd.
      }
```

> **Note**: the `RemoteVideoTrack` handle is consumed by the ffmpeg path during playback. The canvas-pump restart in `onEnd` needs access to the same track. The straightforward fix is to **also hold the last-seen track on the session** (`session.lastPresenterCameraTrack: RemoteVideoTrack | null`), set inside the Phase 2 handler when 'active' fires and cleared on 'inactive'. The Phase-5 executor must add this field and wire it through. Treat this as part of Phase 5's scope.

### 11. `src/logic/presentation-manager/component.ts` — Restart playback when camera state flips mid-video

`playVideoSession` derives `seekSeconds` internally by checking `session.videoState === 'paused' && session.pausedVideoIndex === videoIndex` (component.ts:559-562). To restart cleanly mid-video, we push the session through the same 'paused' state machine: capture elapsed, set `videoState = 'paused'`, then re-enter `playVideoSession` with the same `videoIndex`.

In the presenter-camera handler registered in Phase 4 (step 6), inside both the `'active'` and `'inactive'` branches (after the existing body), add the conditional restart:

```typescript
            // If a video is currently playing, restart playback so ffmpeg picks up the new mode.
            // The session's elapsed-tracking fields are the same ones playVideoSession reads
            // for resume-from-pause (see component.ts:559-562, 707-709).
            if (session.videoState === 'playing' && session.pausedVideoIndex >= 0) {
              const elapsedMs = Date.now() - session.videoPlaybackStartedAt
              session.videoElapsedBeforePause += elapsedMs
              session.videoState = 'paused'
              const indexToResume = session.pausedVideoIndex
              await playVideoSession(session, indexToResume).catch((err) =>
                logger.warn(
                  `Playback restart on camera change failed: ${err instanceof Error ? err.message : String(err)}`
                )
              )
            }
```

A few seconds of stutter on a mid-video camera toggle is acceptable for v1 — ffmpeg fully restarts with `-ss` resume. Document the trade-off in `learnings/phase-5.md`.

## Edge cases

| Scenario | Handling |
|----------|----------|
| Camera goes inactive mid-video | Handler triggers a playback restart with the 2-input ffmpeg path; video position preserved via `-ss`. |
| Camera goes active mid-video | Handler triggers a playback restart with the 3-input path; brief stall (~500ms) acceptable. |
| Camera resolution changes mid-video | `cameraInit.width/height` mismatch in the pump → `abortPlayback('camera-resolution-changed')` → presentation-manager re-attempts playback in the next cycle. |
| Camera dies (track ends) mid-video | Reader returns `done: true`, pump exits, ffmpeg's `pipe:3` gets EOF → `geq` keeps drawing the last frame until ffmpeg exits. Acceptable for the rest of this video; on the next playback, camera will be re-checked. |
| Camera back-pressure (slow ffmpeg) | The `if (!ok) { await drain }` branch lets ffmpeg catch up rather than buffering frames in JS. |
| Spawn fails (e.g. ffmpeg version lacks `geq`) | `compositeProcess.on('error', …)` and stderr error path already fire `abortPlayback('video-stream-error')`. Add a probe in verification step (see below) so we discover this at deploy time, not at first user playback. |

## Verification

```bash
yarn typecheck
yarn lint
yarn test
```

**ffmpeg filter probe** — before the first integration run, the executor must confirm the project's ffmpeg build supports `geq` and `format=yuva420p`. Run this stand-alone command (no project deps needed):

```bash
ffmpeg -f lavfi -i 'color=red:size=640x480:duration=1:rate=20' \
  -filter_complex "[0:v]crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':'(ih-min(iw,ih))/2',scale=256:256,format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='if(lte(hypot(X-128,Y-128),128),255,0)'" \
  -frames:v 1 /tmp/circle-test.png
```

If `/tmp/circle-test.png` contains a red circle on a transparent background, the build is good. Log success/failure in `learnings/phase-5.md`. If `geq` is missing, the spec must be revisited — likely fallback: pre-compute the circular alpha mask in JS once at the start of playback, write it as a static rawvideo input, and use `alphamerge` instead of `geq`.

**Mode-flip stress** — once Phase 6's integration scaffolding is in place, run a session that:

1. Starts with camera off, plays a video for 5s.
2. Turns camera on at t=5s.
3. Turns camera off at t=10s.
4. Confirms the video position stays roughly contiguous (within a 1s glitch tolerance) across both restarts.

## Learnings (post-execution)

After running this phase, append to `learnings/phase-5.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
