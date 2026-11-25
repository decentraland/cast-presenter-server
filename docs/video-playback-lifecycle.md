# Video playback lifecycle

Slides can contain video annotations (hyperlinks to YouTube, Google
Drive, Vimeo, or embedded media). The server never composites a frame.
A slide video takes one of two paths, chosen on play by its URL and
announced as `slideVideos[i].source`:

- **Stream (`stream`):** a video embedded in the PPTX is baked once,
  and the session's `cast-sidecar` plays the baked files onto
  `presentation-video` and `presentation-audio`, which stay published
  for the whole session.
- **Client-played (`client`):** a YouTube, Google Drive or Vimeo
  `.m3u8` link is played by each client from its canonical URL. See
  "Client-played videos" below.

Any other link fails on play with `video-invalid-format` and the
message "Unsupported video link — use YouTube, Google Drive or a Vimeo
.m3u8 link". `playingVideoIndex` names the video while the state is
`loading`, `playing` or `paused`.

## Stream videos

The stream path runs this state machine:

```
idle ──play──► loading ──bake ready + sidecar play──► playing ──pause──► paused
                  │                                     ▲                  │
                  │                                     └─ play same index ┘
                  └─ stop / navigate ─► idle               (sidecar resume)

playing / paused ── natural end, stop, navigate ──► idle
any failure ──► error (the next play starts over)
```

- **Loading while baking:** a play waits in `loading` for the video's
  bake job. Each session prefetches its embedded videos one at a time
  right after creation; a play reuses a prefetch job for the same URL and
  raises it to play priority (a queued bake moves to the front of the
  process-wide queue; a running bake is never preempted). A finished
  bake is reused by every later play of that URL.
- **Bake cancellation:** stop or navigate during `loading` aborts the
  pending job: a queued bake is dropped, or a running bake is killed.
  Ending the session aborts every job. Navigating during a
  prefetch-only bake lets it finish.
- **Concurrent plays:** a play is ignored while the state is
  `playing` or `loading`. The check and the state write run with no
  `await` between them, so two rapid plays can never both start.
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
- **Early end or failure:** a short clip can end, or fail on its first
  read, before the server handles the `play` or `resume` ack. The
  server keeps that event and applies it instead of moving to
  `playing`, so viewers never see `playing` with no samples flowing.
  An event from a playback that a newer `play` replaced is ignored.
- **Commands while loading:** a play for any video, including another
  index, is ignored while a video is `loading`, and so is a pause.
  The presenter gets no error; the state still names the loading
  video in `playingVideoIndex`.
- **Bake failure:** the video goes to `error`, with
  `video-quota-exceeded` when the bake output would exceed the session
  quota and usually `video-playback-failed` for a failed or timed-out
  bake. The next play starts a new job.
- **RPC failure:** a rejected or timed-out sidecar `play`, `pause`,
  `resume` or `stop` puts the video in `error` with
  `video-playback-failed`, so the next play is never blocked by
  `loading`.
- **Sidecar crash:** a sidecar exit or a lost room stops the session.

## Client-played videos

The server never downloads, bakes or streams a client-played video,
and sends the sidecar no command for it. It keeps the playback state
and a position anchor, and clients follow them:

```
idle ──play──► playing ──pause──► paused ──play same index──► playing
playing / paused ── stop, navigate, end timer (playing only) ──► idle
```

- **Play:** the state goes straight to `playing`, with no `loading`
  step. `videoPositionMs` is 0 and `videoPositionAt` is the server's
  `Date.now()`.
- **Pause / resume:** pause folds the elapsed time into
  `videoPositionMs` and moves `videoPositionAt` to the pause time.
  Playing the same index resumes from `videoPositionMs` with a new
  `videoPositionAt`. The anchor changes only on play, resume and pause.
- **Switching from a paused embedded video:** the server stops the
  sidecar first, then announces the client video. If that stop fails,
  the video goes to `error` with `video-playback-failed`. Switching
  from a paused client video needs no sidecar call. Playing an
  unsupported link while an embedded video is paused also stops the
  sidecar before the video goes to `error`.
- **Natural end:** on every play and resume, the server looks up the
  duration through the `video-duration` component (an InnerTube
  `player` request for YouTube, ffprobe for Drive and Vimeo). When it
  is known, the server arms an end timer for the remaining time plus
  2 s; when it fires, the state goes to `idle` with
  `playingVideoIndex: null`. A duration over 24 hours counts as
  unknown. An unknown duration arms no timer, so the video plays
  until it is stopped or the slide changes. A lookup never fails
  playback. A failed lookup is remembered for a minute, so replaying
  the same link within that minute arms no timer without asking the
  provider again, and at most two ffprobe processes run at a time
  across all sessions.
- **Stale work:** every client play, stop, navigate and session stop
  clears the end timer, pause clears it too, and every play, stop,
  navigate and session stop bumps the play generation.
  A lookup that resolves after any of these, or while paused, is
  dropped. Late sidecar `playbackEnded` or `playback-failed` events
  never end or fail a client video.
