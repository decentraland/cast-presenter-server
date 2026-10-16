# Drive video proxy

HTTP endpoint that streams **public** Google Drive files so a web app can use them as the `src` of a native `<video>` tag (e.g. in a PPTX viewer). No Google credentials are required; files must be shared as "Anyone with the link".

## Endpoint

- **Method:** `GET`
- **Path:** `/api/drive-video`
- **Query:** `fileId` (required) — Google Drive file ID (e.g. from `drive.google.com/file/d/{fileId}/view`).

Example:

```http
GET /api/drive-video?fileId=1VlZPOUWlTwd6yCkepEafaZPmj9OMrkN-
```

## Frontend usage

Set the video `src` to the proxy URL:

```js
const API_BASE = 'https://your-server.com' // or same origin
const fileId = '1VlZPOUWlTwd6yCkepEafaZPmj9OMrkN-'

video.src = `${API_BASE}/api/drive-video?fileId=${fileId}`
```

- Range requests are supported: the server forwards the `Range` header to Drive and returns `Accept-Ranges: bytes` and `Content-Range` when applicable, so the `<video>` element can seek.
- Every response carries `Content-Disposition: attachment`, so a browser that opens the URL directly downloads the file instead of rendering it from this origin. A `<video>` element ignores the header. The upstream `Content-Type` is passed through as is: Drive often answers `application/octet-stream` even for a video, so the relay cannot require `video/*`.
- A plain `<video src>` loads cross-origin without CORS. Set `DRIVE_VIDEO_CORS_ORIGIN` (see below) only when the frontend reads the response from script or sets `crossorigin` on the element.

## Environment variables

| Variable                       | Required | Description                                                                                                                        |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DRIVE_VIDEO_ALLOWED_FILE_IDS` | No       | Comma-separated list of Drive file IDs that can always be requested. Other IDs are served only while a presentation plays them.   |
| `DRIVE_VIDEO_CORS_ORIGIN`      | No       | Value for `Access-Control-Allow-Origin` on this endpoint (e.g. `https://your-frontend.com` or `*`). Omit for same-origin only.     |

## Errors

- **400** — Missing or invalid `fileId` (only alphanumeric, `-`, and `_` allowed).
- **403** — File ID neither in the allowlist nor the active client-played video of a running presentation.
- **404** — File not found or not accessible (e.g. not shared publicly).
- **502** — Upstream error (e.g. Drive unavailable).

## How it works

The server fetches the file from the public Drive download URL (`drive.usercontent.google.com/download?id=...&export=download&authuser=0`) and streams the response to the client. It does not buffer the full file and forwards range requests for seeking.
