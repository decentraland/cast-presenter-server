# Cast Presenter Server

Real-time presentation streaming server for Decentraland. It accepts
PDF and PPTX uploads, renders slides as PNG images, and a per-session
sidecar publishes the presentation to a LiveKit room. Clients draw the
slides and can control the presentation through data channel commands.

## Features

- **Slide rendering:** Renders PDF/PPTX slides to PNG images in a
  short-lived child process per deck and serves them to clients.
- **Embedded video playback:** Bakes videos embedded in PPTX files with
  ffmpeg and publishes them through the sidecar; clients play
  YouTube, Google Drive and Vimeo links themselves.
- **Data channel control:** Participants with the right role can
  navigate slides, play/pause videos, and stop the presentation
  through LiveKit data channels.
- **Google Drive proxy:** Streams public Drive files so web clients
  can use them as native `<video>` sources.
- **Security hardening:** Rate limiting, SSRF protection, file
  validation, security headers, and non-root container execution.

## Dependencies and related services

This service interacts with the following:

- **[comms-gatekeeper](https://github.com/decentraland/comms-gatekeeper):**
  Issues LiveKit bot tokens that this server uses to join rooms.
  Also manages presenter role promotion (planned).
- **LiveKit:** WebRTC SFU that the per-session Go sidecar connects to
  as a publishing participant.
- **Google Drive:** Public files are proxied through the
  `/api/drive-video` endpoint for embedded video playback.

External runtime dependencies:

- **ffmpeg:** Required for video transcoding.
- **cast-sidecar:** Go binary that talks to LiveKit; see the
  Local runs note in [AGENTS.md](AGENTS.md#gotchas) for how to build it.
- **Node.js 24:** Runtime environment.

## API documentation

The API is documented using the
[OpenAPI standard](https://swagger.io/specification/). The schema is
at [docs/openapi.yaml](docs/openapi.yaml).

## Architecture

For a detailed architecture overview, data channel protocol, and
security model, see [docs/architecture.md](docs/architecture.md).

## Getting started

### Prerequisites

Before running this service, make sure you have the following
installed:

- **Node.js:** Version 24.x or higher
- **Yarn:** Version 1.22.x or higher
- **ffmpeg:** Required for video processing
- **Docker:** For containerized deployment (optional). The image uses
  `node:24-trixie-slim` (Debian).

### Installation

1. Clone the repository:

```bash
git clone https://github.com/decentraland/cast-presenter-server.git
cd cast-presenter-server
```

2. Install dependencies:

```bash
yarn install
```

3. Build the project:

```bash
yarn build
```

### Configuration

The service uses environment variables for configuration. Create a
`.env` file in the root directory using `.env.default` as a reference.
All available variables and their defaults are documented in
`.env.default`. `PUBLIC_BASE_URL` is required, and `SIDECAR_BINARY_PATH`
must point to a built `cast-sidecar` binary.

### Running the service

Run in development mode:

```bash
yarn start:dev
```

Run with Docker:

```bash
docker build -t cast-presenter-service .
docker run -p 3000:3000 cast-presenter-service
```

## Testing

Run all tests with coverage:

```bash
yarn test
```

Run only unit tests:

```bash
yarn test test/unit
```

Run only integration tests:

```bash
yarn test test/integration
```

### Test structure

- **Unit tests** (`test/unit/`): Test individual components in
  isolation.
- **Integration tests** (`test/integration/`): Test the complete
  request and response cycle.

## AI agent context

For AI agent context, see
[docs/ai-agent-context.md](docs/ai-agent-context.md).

### AI Skills

This project uses [skills](https://skills.sh/docs) to manage AI agent standards from [decentraland/ai-toolkit](https://github.com/decentraland/ai-toolkit). See the `skills-lock.json` file for installed skills.
