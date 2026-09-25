# Architecture

Cast Presenter Server renders presentation slides as a live video
stream and publishes them to a LiveKit room. This document covers
the system architecture, data channel protocol, session lifecycle,
and security model.

## System overview

The following diagram shows how a presentation is created and
streamed to participants.

```mermaid
sequenceDiagram
    participant Scene as Decentraland Scene
    participant Cast2 as cast2 webapp
    participant GK as comms-gatekeeper
    participant PS as cast-presenter-server
    participant LK as LiveKit SFU

    Scene->>GK: 1. signed-fetch (request streaming key)
    GK-->>Scene: 2. streaming key

    Cast2->>GK: 3. validate streaming key
    GK-->>Cast2: 4. bot-token (LiveKit JWT)

    Cast2->>PS: 5. POST /presentations (file + bot-token)
    PS->>LK: 6. connect with bot-token
    LK-->>PS: 7. connection established (token valid)
    PS->>PS: 8. parse PDF, render first slide
    PS->>LK: 9. publish video track

    Note over LK: Room participants see the presentation

    LK-->>Scene: video track (slide frames)
    Scene->>LK: data channel commands
    LK-->>PS: data channel commands
    PS->>LK: state broadcasts
    LK-->>Scene: state broadcasts
```

## Workflow diagram

This diagram shows the internal processing flow when the server
handles a presentation request.

```mermaid
flowchart LR
    A(["POST /presentations"]):::start --> B["Rate limit"]

    B --> C1["Extract file\nfrom payload"]
    B --> C2["Download file\nfrom URL"]

    C1 --> D["Validate file\nextension + magic bytes"]
    C2 --> D

    D --> E["Connect to\nLiveKit"]
    E --> F["Parse PDF"]
    F --> G["Render\nfirst slide"]
    G --> H["Publish\nvideo track"]
    H --> I["Pre-download\nembedded videos"]
    I --> J(["201 Created"]):::finish

    classDef start fill:#4a9eff,color:#fff,stroke:none
    classDef finish fill:#34d399,color:#fff,stroke:none
```

Once the presentation is live, participants control it through
data channel commands:

```mermaid
flowchart LR
    A(["Session active"]) --> B{"Command received"}

    B -- navigate --> C["Render target slide\n+ broadcast state"]
    B -- "video:play" --> D["Composite video\nwith ffmpeg\n+ broadcast state"]
    B -- "video:pause" --> E["Pause ffmpeg\n+ broadcast state"]
    B -- get-state --> F["Broadcast\ncurrent state"]
    B -- stop --> G["Disconnect\n+ cleanup"]

    C --> B
    D --> B
    E --> B
    F --> B

    H{"No participants\nfor 5 minutes"} --> G
```

## Components

The server is built with the well-known-components pattern.
Each component is created during initialization and injected into
handlers.

| Component | Purpose |
|-----------|---------|
| `config` | Environment variable resolution with fallback chain |
| `logs` | Structured JSON logging with tracing |
| `server` | HTTP server with CORS and security headers |
| `metrics` | Prometheus metrics registry |
| `fetcher` | Traced HTTP client for outbound requests |
| `presentationManager` | Core business logic and session management |

### Adapters

Adapters wrap external systems and provide clean interfaces to the
presentation manager.

- **PDFRenderer:** Parses PDF/PPTX files using pdfjs-dist, renders
  slides to RGBA buffers using @napi-rs/canvas, and extracts video
  annotations with geometry information.
- **LiveKitPublisher:** Connects to a LiveKit room, publishes a
  video track from raw RGBA frames, handles data channel message
  routing, and manages bot metadata.
- **VideoCompositor:** Downloads videos (with SSRF protection),
  transcodes them with ffmpeg, and composites video frames onto
  slide backgrounds for real-time overlay playback.

## Session lifecycle

Each presentation runs as an in-memory session identified by a UUID.

1. **Create:** The server connects to LiveKit first (validating the
   token), then parses the PDF, renders the first slide, and starts
   publishing a video track.
2. **Pre-download:** In the background, all video URLs across all
   slides are downloaded and optionally pre-transcoded.
3. **Navigate:** Stops any active video, renders the target slide,
   forces a high-quality keyframe, and broadcasts updated state.
4. **Play video:** Loads or streams the video, composites it onto
   the slide canvas using ffmpeg, and pushes frames to LiveKit.
5. **Pause/Resume:** Sends SIGSTOP/SIGCONT to the ffmpeg process.
6. **Stop:** Disconnects from LiveKit, destroys the PDF renderer,
   cleans up the temporary directory, and removes the session.
7. **Idle cleanup:** A periodic check (every 60 seconds) terminates
   sessions with no remote participants for 5 minutes.

## Loom-style camera overlay

Every session draws the first presenter's camera as a circular bubble
on the presentation track while that camera track is active and
unmuted. Muting or unpublishing the camera hides the bubble; there is
no separate visibility flag.

One stamping step in `src/adapters/camera-overlay/` blends the bubble
into each I420 frame just before `publisher.pushFrame`. ffmpeg never
receives a camera input:

- **Slide or paused video:** each camera frame (up to ~20 fps) stamps
  the bubble over the current slide or the frozen video frame and
  pushes the result. The heartbeat repeats the last stamped frame, so
  a stalled camera still yields output.
- **Playing video:** ffmpeg frames drive output, and each one is
  decorated with the bubble before it is pushed.

The layout is the bubble centre `x`, `y` as fractions of the slide
width and height, plus a `size` of `small` (15% of slide width) or
`large` (25%). The bubble keeps a margin of 2% of the slide width from
every edge, so `(0, 0)`, `(1, 0)`, `(0, 1)` and `(1, 1)` are the four
corner presets. The default is `{ "x": 0, "y": 1, "size": "small" }`,
bottom-left.

Presenters move or resize the bubble at runtime with
`presentation:overlay:update`. The next frame uses the new layout,
with no ffmpeg restart.

## Data channel protocol

The bot communicates with Decentraland scenes through LiveKit data
channels on the `presentation` topic. Messages are UTF-8 JSON
strings sent with reliable delivery.

### Commands (scene to bot)

```json
{ "type": "presentation:navigate", "action": "next" }
{ "type": "presentation:navigate", "action": "prev" }
{ "type": "presentation:navigate", "action": "goto", "slideIndex": 3 }
{ "type": "presentation:video:play", "videoIndex": 0 }
{ "type": "presentation:video:pause" }
{ "type": "presentation:video:stop" }
{ "type": "presentation:stop" }
{ "type": "presentation:get-state" }
{ "type": "presentation:overlay:update", "x": 0.5, "y": 0.5, "size": "large" }
```

`presentation:overlay:update` changes only the fields it carries, and
the bot drops the whole command if any field is invalid.

### State broadcast (bot to all participants)

After every state mutation and in response to `get-state`, the bot
broadcasts:

```json
{
  "type": "presentation:state",
  "id": "uuid",
  "fileName": "Quarterly Review",
  "currentSlide": 2,
  "slideCount": 15,
  "fileType": "pdf",
  "slideVideos": [
    {
      "url": "https://drive.google.com/...",
      "geometry": { "x": 100, "y": 200, "width": 640, "height": 360 }
    }
  ],
  "videoState": "idle",
  "overlay": { "x": 0, "y": 1, "size": "small" }
}
```

The state is also stored in the bot's LiveKit participant metadata
so late joiners can read it immediately without waiting for a
broadcast.

### Authorization

Commands are accepted only from participants whose identity appears in
the `presenters` array within LiveKit room metadata. This array is
managed exclusively by comms-gatekeeper via the server-side Room API
— room participants cannot modify room metadata, making this
authorization model tamper-proof.

### Bot identity

The bot's LiveKit participant identity starts with
`presentation-bot:` (for example,
`presentation-bot:scene:realm:sceneId:1234567890`). Scenes detect
the bot by this prefix to display presentation controls.

## Security model

### Authentication

The server doesn't have the LiveKit API secret. Authentication is
implicit: if the LiveKit connection succeeds, the token is valid
(issued by comms-gatekeeper, verified by the LiveKit SFU). If
connection fails, the request is rejected before any file processing.

### MITM protection

LiveKit tokens are sent in the `POST /presentations` request body.
In production, the server must run behind a TLS-terminating reverse
proxy to protect tokens in transit.

### Input validation

- **File size:** 100 MB maximum, checked via Content-Length header
  and busboy stream limits.
- **Magic bytes:** PDF files must start with `%PDF`, PPTX files
  must start with `PK\x03\x04` (ZIP header).
- **Filename sanitization:** `path.basename()` plus special
  character stripping.
- **File type:** Only `.pdf` and `.pptx` extensions are accepted.

### SSRF protection

Video URLs extracted from PDF annotations are validated before
download:

- Protocol must be `https://`.
- Domain must be in the allowlist: `drive.google.com`,
  `drive.usercontent.google.com`, `docs.google.com`,
  `youtube.com`, `youtu.be`, `vimeo.com`.
- DNS resolution (both A and AAAA records) is checked to block
  private IP ranges: IPv4 loopback (127/8), RFC 1918 (10/8,
  172.16/12, 192.168/16), link-local (169.254/16), multicast
  (224/4), broadcast; and IPv6 loopback (::1), unique local
  (fc00::/7), link-local (fe80::/10), mapped-IPv4 (::ffff:x.x.x.x).

### Download limits

- Maximum video download size: 500 MB.
- Download timeout: 60 seconds.

### Drive proxy allowlist

The `DRIVE_VIDEO_ALLOWED_FILE_IDS` configuration uses a default-deny
posture. If the variable is empty or unset, all requests to
`/api/drive-video` are denied.

### Security headers

All responses include:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- `Content-Security-Policy: default-src 'none'`

### HTTP control endpoints (removed)

The server previously exposed HTTP endpoints for controlling
presentations: navigate, video play/pause, stop, and get-state.
These were removed because they lacked authentication — any client
that knew the presentation UUID could control it.

All presentation control now flows exclusively through the LiveKit
data channel, which enforces presenter authorization via room
metadata (see [Authorization](#authorization) above). This makes
the data channel the single control plane.

**Re-adding HTTP control in the future:** If HTTP endpoints are
needed again (for example, for a webapp without LiveKit access),
they must require authentication. Options include:
- A session token returned at creation time (only the creator has
  it), sent as a `Bearer` header on control requests.
- Signed-fetch using the caller's wallet identity, checked against
  the presenters list.

### Container hardening

The Docker image is based on `node:24-trixie-slim` (Debian). Alpine
Linux is not supported because `@livekit/rtc-node` only ships
glibc-compatible native binaries — there is no musl build available.

The image runs as a non-root user (`appuser:1001`) and uses Tini as
PID 1 for proper signal handling.
