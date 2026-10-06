# AI agent context

**Service purpose:**

Cast Presenter Server is a real-time presentation streaming service
for Decentraland. It renders PDF/PPTX slides as video frames and
publishes them to a LiveKit room so scene participants can watch a
live presentation. It also supports embedded video playback and
remote control through LiveKit data channels.

**Key capabilities:**

- Accept PDF/PPTX uploads and stream rendered slides as a LiveKit
  video track.
- Navigate slides (next, prev, goto) with instant keyframe updates.
- Detect video annotations in PDFs and composite them onto slides
  using ffmpeg.
- Proxy public Google Drive files for embedded video playback.
- Respond to data channel commands from authorized participants.
- Broadcast presentation state to all room participants on every
  mutation and on explicit `get-state` requests.

**Communication pattern:**

- HTTP REST API for presentation lifecycle (create, navigate,
  play/pause, stop, get state).
- LiveKit WebRTC data channels for real-time bidirectional control
  between the bot and scene participants.
- LiveKit video track publishing for slide and video output.

**Technology stack:**

- Runtime: Node.js 24 (Alpine Linux, non-root container)
- Language: TypeScript (strict mode)
- HTTP framework: @well-known-components/http-server
- WebRTC: @livekit/rtc-node
- PDF rendering: pdfjs-dist + @napi-rs/canvas
- Video processing: ffmpeg (spawned as child process)
- File upload: busboy
- Observability: Prometheus metrics, structured JSON logging,
  distributed tracing

**External dependencies:**

- LiveKit SFU (WebRTC room connection and media publishing)
- comms-gatekeeper (issues LiveKit bot tokens)
- Google Drive (public file streaming for embedded videos)
- ffmpeg (system binary for video transcoding and compositing)

**Key concepts:**

- **Session:** An in-memory object representing an active
  presentation. Each session holds the PDF renderer, LiveKit
  publisher, video compositor, and cached video paths. Sessions are
  identified by a UUID.
- **Bot token:** A LiveKit JWT issued by comms-gatekeeper with
  identity `presentation-bot:{roomId}:{timestamp}` and role
  `presentation`. The server uses this token to join the room. A
  successful connection acts as implicit authentication.
- **Data channel protocol:** The bot listens on the `presentation`
  topic for JSON commands (`navigate`, `video:play`, `video:pause`,
  `stop`, `get-state`, `overlay:update`) and broadcasts
  `presentation:state` messages after every mutation.
- **SSRF protection:** Video URLs extracted from PDF annotations are
  validated against an HTTPS-only domain allowlist before download.
- **Idle cleanup:** Sessions with no remote participants for 5
  minutes are automatically stopped and cleaned up.
- **Client composition (v2):** With `CLIENT_COMPOSITION_ENABLED=true`
  the bot publishes slide PNGs, `presenterIdentity` and pre-baked
  video through the per-session Go sidecar `cast-sidecar`
  (`src/adapters/sidecar-publisher/`, JSON-lines IPC), and never
  composites a frame; see
  [architecture.md](architecture.md#client-composition-v2).

**Video playback lifecycle:**

See [video-playback-lifecycle.md](video-playback-lifecycle.md) for the
full play/pause/resume/stop lifecycle, FFmpeg process architecture,
heartbeat mechanism, seek warmup logic, and video caching flow.

**Architecture notes:**

- The server is stateless across restarts (all sessions are
  in-memory).
- PDF rendering and video compositing happen server-side; clients
  only receive a standard video track.
- Presentation commands are authorized by checking the sender's
  identity against the `presenters` array in LiveKit room metadata,
  which is managed exclusively by comms-gatekeeper via the server-side
  API. Room participants cannot modify room metadata.
