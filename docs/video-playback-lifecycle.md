# Video playback lifecycle

Slides can contain video annotations (hyperlinks to YouTube, Google
Drive, Vimeo, or direct media URLs). When a presenter triggers
playback, the server composites the video onto the slide using FFmpeg
and streams the result as a single LiveKit video track.

## State machine

```
         play            pause           play (resume)
idle ──────────► playing ──────► paused ──────────► playing
  ▲                │                │
  │    stop/nav    │    stop/nav    │
  └────────────────┴────────────────┘
  ▲                │
  │  natural end   │
  └────────────────┘
```

## Play (initial)

The presentation manager creates a new `IVideoCompositor` and spawns
two FFmpeg processes:

1. **Composite process** — reads the static slide (RGBA rawvideo loop)
   as input 0 and the video as input 1, applies an overlay filter at
   the PDF annotation coordinates, and outputs I420 frames at 20fps
   to stdout. The `-re` flag on the video input provides real-time
   pacing.
2. **Audio process** — extracts PCM audio (s16le, 48kHz stereo) from
   the same video source and outputs to stdout.

A `dataListener` on the composite process accumulates raw bytes and
pushes complete I420 frames to the LiveKit video track. Audio chunks
are split into strict 10ms frames (1920 bytes) before being pushed
to the LiveKit audio track.

**Key files:**
- `src/logic/presentation-manager/component.ts` — `playVideoSession()`
- `src/adapters/video-compositor/component.ts` — `startPlayback()`

## Pause

The compositor captures the last pushed video frame via
`getLastFrame()`, then `cleanup()` kills both FFmpeg processes.

The last video frame is used to start a **heartbeat** (re-publishing
the same frame every 500ms) so viewers see a frozen video instead of
a blank stream.

The LiveKit audio track stays published but goes silent (no FFmpeg
feeding it). Elapsed playback time is recorded for resume seeking.

**Why kill-and-restart instead of soft pause?** Keeping FFmpeg running
during pause wastes CPU and memory (two processes idling). The
kill-and-restart approach with seek is more resource-efficient, at the
cost of requiring the heartbeat and warmup logic described below.

**Key file:** `src/logic/presentation-manager/component.ts` — `pauseVideoSession()`

## Resume (play after pause)

A new compositor is created and `startPlayback` is called with
`-ss <elapsed>` for input seeking.

Because the audio track was kept alive during pause,
`startAudioPublishing` is **skipped** — the new FFmpeg audio process
feeds into the existing `AudioSource`. Tearing down and re-creating
the LiveKit audio track on each pause/resume cycle causes the audio
to silently fail on resume.

### Seek warmup

The composite process's `dataListener` skips the first ~10 frames
(`SEEK_WARMUP_FRAMES`) because the FFmpeg overlay filter passes
through the slide background (with the black video placeholder)
before the video decoder is ready after seeking. Without this
warmup skip, viewers would see a brief flash of the slide placeholder
between the frozen frame and the live video.

The heartbeat from pause continues running during this warmup and is
stopped only when the first real composite frame is ready to push,
ensuring a seamless visual transition:

```
[pause]
  └─ heartbeat: frozen video frame (I420, 2fps)
       │
[resume → startPlayback]
       │
  ┌────┴─ FFmpeg starts, seeks to -ss position
  │       overlay filter passes slide-only frames
  │       dataListener discards first 10 frames
  │       heartbeat still running ──────────────────┐
  │                                                 │
  └────── video decoder ready                       │
          overlay produces real composite frames     │
          dataListener pushes first real frame ──────┘
          stopHeartbeat() called
          normal 20fps video streaming
```

**Key files:**
- `src/logic/presentation-manager/component.ts` — `playVideoSession()` (seekSeconds branch)
- `src/adapters/video-compositor/component.ts` — `SEEK_WARMUP_FRAMES`, `firstFrameDelivered`

## Stop

`stopAudioPublishing()` tears down the LiveKit audio track. The
compositor is cleaned up. The static slide frame (RGBA) is restored
via `pushFrame` + `startHeartbeat`.

**Key file:** `src/logic/presentation-manager/component.ts` — `stopVideoSession()`

## Navigate away

Same as stop — audio track torn down, compositor cleaned up, new
slide rendered and heartbeated.

## Natural end

The composite process exits, triggering its `close` handler which
calls `stopPlayback` (restores the slide frame) and the `onEnd`
callback (tears down the audio track and broadcasts idle state).

## Video caching

On first play of a streaming URL, the video is played directly via
FFmpeg's HTTPS input. A background download runs in parallel: raw
bytes are fetched via `https.get` (handles Google Drive redirects),
then remuxed into a clean MP4 with `-c copy -movflags +faststart`.
Subsequent plays and resumes use the local cached file for faster
seeking.

## Failure handling

Playback failures are surfaced over the LiveKit data channel on two
paths:

1. **`presentation:state`** (persistent) — on failure the session moves
   to `videoState: 'error'` with `videoErrorReason` set to a
   human-readable message. The state is cleared back to `loading` on
   the next play attempt.
2. **`presentation:error`** (transient) — a separate event fires
   alongside the state update so clients can toast the error without
   diffing state. Shape:
   `{ type: 'presentation:error', code, message, videoIndex, videoUrl }`.
   Codes are stable strings (e.g. `video-permission-denied`,
   `video-invalid-format`, `video-playback-interrupted`) defined by the
   `VideoErrorCode` union in `src/logic/presentation-manager/component.ts`.

Triggers:

- **Presenter-initiated play fails** (download error, disk-quota cap,
  or `startPlayback` throw) — emitted from `playVideoSession`.
- **Mid-stream playback crashes** (FFmpeg exits non-zero, composite
  stdio stream errors, audio handler throws) — the compositor fires
  `onError(reason)` and the session re-broadcasts it as
  `presentation:error`.

The FFmpeg child processes defensively attach `error` listeners on
every piped stream (`stdout`/`stderr` on composite, audio, and remux
processes). Without them a transient stream error (e.g. EPIPE after
SIGKILL) would surface as an uncaught exception and crash the server
under the Dockerfile's `--abort-on-uncaught-exception` flag.

The audio-chunking path in `playVideoSession` uses a residual-buffer
accumulator (`Buffer.concat` + `subarray`) rather than a fixed ring
buffer — FFmpeg has been observed bursting chunks larger than any
sensibly-sized ring, and the previous write-past-capacity drift caused
a `Buffer.copy` `RangeError` mid-playback.

## Frame format

The composite process outputs I420 (yuv420p) frames. The heartbeat
on pause also uses I420 (the last captured composite frame). The
heartbeat on stop uses RGBA (the static slide buffer). LiveKit's
encoder handles both formats transparently — no manual conversion
needed on our side.

## FFmpeg process architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Composite Process                     │
│                                                         │
│  Input 0: slide.rgba (rawvideo, RGBA, looped, 20fps)   │
│  Input 1: video (-ss seek, -re real-time pacing)        │
│                                                         │
│  Filter: [1:v]scale=W:H[vid];[0:v][vid]overlay=X:Y     │
│  Output: pipe:1 (rawvideo, yuv420p, 20fps)              │
│                                                         │
│  -protocol_whitelist file,pipe (local)                  │
│                      file,pipe,http,https,tcp,tls,crypto│
│                      (streaming)                        │
└──────────────────────┬──────────────────────────────────┘
                       │ stdout → dataListener
                       │   accumulates I420 frames
                       │   pushFrame() → LiveKit video track
                       ▼
┌─────────────────────────────────────────────────────────┐
│                     Audio Process                        │
│                                                         │
│  Input: same video (-ss seek, -re real-time pacing)     │
│  Output: pipe:1 (s16le, 48kHz, stereo)                  │
│                                                         │
└──────────────────────┬──────────────────────────────────┘
                       │ stdout → onAudioData callback
                       │   chunks into 10ms frames (1920B)
                       │   pushAudioFrame() → LiveKit audio track
                       ▼
```

## v2 (client composition)

With `CLIENT_COMPOSITION_ENABLED=true` none of the above runs: there
is no compositor, no ffmpeg during playback, and no audio-track
churn. Each video is baked once, and the session's `cast-sidecar`
plays the baked files onto `presentation-video` and
`presentation-audio`, which stay published for the whole session.
`playingVideoIndex` names the video while the state is `loading`,
`playing` or `paused`.

```
idle ──play──► loading ──bake ready + sidecar play──► playing ──pause──► paused
                  │                                     ▲                  │
                  │                                     └─ play same index ┘
                  └─ stop / navigate ─► idle               (sidecar resume)

playing / paused ── natural end, stop, navigate ──► idle
any failure ──► error (the next play starts over)
```

- **Loading while baking:** a play waits in `loading` for the video's
  bake job. Each session prefetches its videos one at a time right
  after creation; a play reuses a prefetch job for the same URL and
  raises it to play priority (a queued bake moves to the front of the
  process-wide queue; a running bake is never preempted). A finished
  bake is reused by every later play of that URL.
- **Bake cancellation:** stop or navigate during `loading` aborts the
  pending job: an in-flight download stops, a queued bake is dropped,
  or a running bake is killed. Ending the session aborts every job.
  Navigating during a prefetch-only bake lets it finish.
- **Pause / resume:** pause stops the sidecar writing samples, so
  viewers hold the last frame. Playing the same index resumes from the
  paused sample; playing another index stops the paused one first and
  starts the new one from the beginning. Late joiners during a pause
  see an empty video rect until resume.
- **Navigate:** the sidecar playback is stopped together with the
  rest of the video teardown, before the next slide is rendered.
- **Natural end:** the sidecar sends `playbackEnded` and the state
  goes to `idle`.
- **Mid-stream failure:** a sidecar `playback-failed` puts the video
  in `error` with `video-playback-interrupted`.
- **Bake or download failure:** the video goes to `error`, classified
  like a v1 download failure (`video-quota-exceeded`,
  `video-not-found`, …); a failed or timed-out bake usually lands on
  `video-playback-failed`. The next play starts a new job.
- **RPC failure:** a rejected or timed-out sidecar `play`, `pause`,
  `resume` or `stop` puts the video in `error` with
  `video-playback-failed`, so the next play is never blocked by
  `loading`.
- **Sidecar crash:** a sidecar exit or a lost room stops the session.
