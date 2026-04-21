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
- If the frontend is on a different origin, set `DRIVE_VIDEO_CORS_ORIGIN` (see below) so the browser allows the request.

## Environment variables

| Variable                       | Required | Description                                                                                                                        |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DRIVE_VIDEO_ALLOWED_FILE_IDS` | No       | Comma-separated list of Drive file IDs. If set, only these IDs can be requested; if empty or unset, any public file ID is allowed. |
| `DRIVE_VIDEO_CORS_ORIGIN`      | No       | Value for `Access-Control-Allow-Origin` on this endpoint (e.g. `https://your-frontend.com` or `*`). Omit for same-origin only.     |

## Errors

- **400** — Missing or invalid `fileId` (only alphanumeric, `-`, and `_` allowed).
- **403** — File ID not in the allowlist (when `DRIVE_VIDEO_ALLOWED_FILE_IDS` is set).
- **404** — File not found or not accessible (e.g. not shared publicly).
- **502** — Upstream error (e.g. Drive unavailable).

## How it works

The server fetches the file from the public Drive download URL (`drive.usercontent.google.com/download?id=...&export=download&authuser=0`) and streams the response to the client. It does not buffer the full file and forwards range requests for seeking.
