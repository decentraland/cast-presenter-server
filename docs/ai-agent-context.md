# AI agent context

**Service purpose:**

Cast Presenter Server is a real-time presentation streaming service
for Decentraland. It renders PDF/PPTX slides as PNG images and, through
a per-session Go sidecar, publishes the presentation to a LiveKit room
so scene participants can watch a live presentation. It also supports embedded video playback and
remote control through LiveKit data channels.

**Key capabilities:**

- Accept PDF/PPTX uploads and serve rendered slides as PNGs that
  clients draw.
- Navigate slides (next, prev, goto).
- Detect video annotations in PDFs and bake videos embedded in PPTX
  files with ffmpeg.
- Proxy public Google Drive files for embedded video playback.
- Respond to data channel commands from authorized participants.
- Broadcast presentation state to all room participants on every
  mutation and on explicit `get-state` requests.

**Communication pattern:**

- HTTP REST API for creating presentations and serving slide
  images.
- LiveKit WebRTC data channels for real-time bidirectional control
  between the bot and scene participants.
- LiveKit video track publishing for embedded video output, through
  the sidecar.

**Technology stack:**

- Runtime: Node.js 24 (Debian slim, non-root container)
- Language: TypeScript (strict mode)
- HTTP framework: @well-known-components/http-server
- WebRTC: per-session Go sidecar (`sidecar/`, built on the LiveKit
  server SDK)
- Slide rendering: pdfjs-dist + @napi-rs/canvas, in a per-session
  child process
- Video processing: ffmpeg (spawned as child process)
- File upload: busboy
- Observability: Prometheus metrics, structured JSON logging,
  distributed tracing

**External dependencies:**

- LiveKit SFU (WebRTC room connection and media publishing, through the sidecar)
- comms-gatekeeper (issues LiveKit bot tokens)
- Google Drive (public file streaming for embedded videos)
- ffmpeg (system binary for video transcoding)

**Key concepts:**

- **Session:** An in-memory object representing an active
  presentation. Each session holds its rendered slides, its sidecar,
  and its extracted media. Sessions are identified by a UUID.
- **Bot token:** A LiveKit JWT issued by comms-gatekeeper with
  identity `presentation-bot:{roomId}:{timestamp}` and role
  `presentation`. The server uses this token to join the room. A
  successful connection acts as implicit authentication.
- **Data channel protocol:** The bot listens on the `presentation`
  topic for JSON commands (`navigate`, `video:play`, `video:pause`,
  `stop`, `get-state`, `overlay:update`) and broadcasts
  `presentation:state` messages after every mutation.
- **SSRF protection:** Outbound downloads are validated against
  private IP ranges.
- **Idle cleanup:** Sessions with no remote participants for 5
  minutes are automatically stopped and cleaned up.
- **Client composition:** The bot publishes slide PNGs,
  `presenterIdentity` and pre-baked video through the per-session Go
  sidecar `cast-sidecar` (`src/adapters/sidecar-publisher/`, JSON-lines
  IPC), and never composites a frame; see
  [architecture.md](architecture.md#client-composition).
- **Slide renderer process:** Each session forks one child process
  (`src/adapters/slide-renderer/`) that writes every slide of the deck
  to disk as a PNG and then exits. The server process loads no native
  rendering or LiveKit code; see
  [architecture.md](architecture.md#slide-renderer-process).
- **Client-played videos:** YouTube, Google Drive and Vimeo
  `.m3u8` links are played by the clients from their canonical URL
  (`slideVideos[i].source: 'client'`); the server only tracks the
  state and `videoPositionMs`/`videoPositionAt`, and ends them on a
  timer when `video-duration` knows their length. Only embedded PPTX
  videos are baked.

**Video playback lifecycle:**

See [video-playback-lifecycle.md](video-playback-lifecycle.md) for the
full play/pause/resume/stop lifecycle for embedded and client-played
videos.

**Architecture notes:**

- The server is stateless across restarts (all sessions are
  in-memory).
- Slide rendering happens server-side in a child process; clients
  receive slide PNGs and draw the presentation themselves.
- Presentation commands are authorized by checking the sender's
  identity against the `presenters` array in LiveKit room metadata,
  which is managed exclusively by comms-gatekeeper via the server-side
  API. Room participants cannot modify room metadata.
