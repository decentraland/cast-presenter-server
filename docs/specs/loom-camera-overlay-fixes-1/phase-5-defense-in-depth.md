# Phase 5: Low-severity defense-in-depth cluster

## Dependencies

- None (can run in parallel with Phases 1, 2, 3, 4)

## Goal

Close the four Low-severity findings from `security-review.md` as a single defense-in-depth pass. None individually rises to gating severity, but bundling keeps the cumulative surface tidy ahead of the next review iteration.

The four findings:

1. **Empty/non-string `presenters` entries** — filter them out at parse time, and reject falsy identities at lookup time.
2. **`videoUrl` echoed over the data channel** — replace it with `videoIndex` only in `broadcastError` payloads (presigned URL fan-out concern).
3. **ffmpeg stderr (last 500 bytes) logged verbatim** — keep at `debug` level only; surface a stable short reason at `warn` level.
4. **RGBA buffers aliased into `Uint8ClampedArray` without copy** — Phase 3 already adds copies for `composeFrame`'s slide and camera image data; this phase confirms and adds a similar copy on the `firstFrameRgba` path (defense-in-depth for the canvas+ffmpeg path overlap).

## Files to modify (3)

| File | Change |
|------|--------|
| `src/adapters/livekit-publisher/component.ts` | Filter empty/non-string `presenters` entries; reject falsy identities in `maybeActivatePresenterCamera`. |
| `src/logic/presentation-manager/component.ts` | Remove `videoUrl` from the four `broadcastError` call sites; drop the `videoUrl` field from `broadcastError`'s context arg. |
| `src/adapters/video-compositor/component.ts` | Lower ffmpeg stderr `warn` log to `debug` for full body; keep a short stable reason at `warn` level. |

## Steps

### 1. `src/adapters/livekit-publisher/component.ts` — filter `presenters` parse output

Replace the body of `parsePresentersFromRoomMetadata` (lines 61–71). The new body filters out non-string and empty entries before lowercasing. AFTER:

```typescript
function parsePresentersFromRoomMetadata(metadata: string | undefined): Set<string> {
  try {
    if (!metadata) return new Set()
    const parsed = JSON.parse(metadata)
    if (!Array.isArray(parsed?.presenters)) return new Set()
    return new Set(
      parsed.presenters
        .filter((p: unknown): p is string => typeof p === 'string' && p.length > 0)
        .map((p: string) => p.toLowerCase())
    )
  } catch {
    return new Set()
  }
}
```

### 2. `src/adapters/livekit-publisher/component.ts` — reject falsy identities in `maybeActivatePresenterCamera`

Inside `maybeActivatePresenterCamera` (currently lines 88–103), add an explicit early return when `participant.identity` is empty *before* the `presenters.has(identity)` check. The existing line `const identity = (participant.identity || '').toLowerCase()` already coerces a missing identity to `''`; we want to bail before the set lookup so a misconfigured `presenters: ['']` cannot match. AFTER (the function in full — replace lines 88–103):

```typescript
  function maybeActivatePresenterCamera(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void {
    if (!(track instanceof RemoteVideoTrack)) return
    if (publication.source !== TrackSource.SOURCE_CAMERA) return
    if (publication.muted) return
    const identity = (participant.identity || '').toLowerCase()
    if (!identity) return // never trust an anonymous participant against the presenters set
    if (!presenters.has(identity)) return
    // First-wins: if another presenter already has an active camera, ignore.
    if (activePresenterCameraSid && activePresenterCameraSid !== track.sid) return
    activePresenterCameraSid = track.sid ?? null
    logger.info(`[presenter-camera] active: ${participant.identity} sid=${track.sid}`)
    presenterCameraHandler?.({ kind: 'active', track, participant })
  }
```

### 3. `src/logic/presentation-manager/component.ts` — drop `videoUrl` from `broadcastError` signature

Modify the `broadcastError` function (lines 291–308). Remove the `videoUrl` field from the `context` parameter type and from the spread into the published payload. The `videoIndex` field stays. AFTER:

```typescript
  async function broadcastError(
    session: InternalSession,
    code: VideoErrorCode,
    message: string,
    context?: { videoIndex?: number }
  ): Promise<void> {
    try {
      await session.publisher.publishData({
        type: 'presentation:error',
        code,
        message,
        ...(context?.videoIndex !== undefined ? { videoIndex: context.videoIndex } : {})
      })
    } catch (err) {
      logger.warn(`Failed to broadcast error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
```

### 4. `src/logic/presentation-manager/component.ts` — drop `videoUrl` from the four call sites

Four call sites currently pass `{ videoIndex, videoUrl: videoInfo.url }` to `broadcastError`. Remove the `videoUrl` key at each site so the new signature compiles. The sites are at approximately:

- Line 749 — inside `playVideoSession`'s session-disk-quota branch
- Line 776 — inside `playVideoSession`'s download-failed branch
- Line 913 — inside `playVideoSession`'s `startPlayback` failure catch
- Line 993 — inside the compositor's `onError` callback

For each, edit the call so the final argument reads `{ videoIndex }`. AFTER (representative — apply the same edit at all four sites):

```typescript
        await broadcastError(session, info.code, info.message, { videoIndex })
```

```typescript
        await broadcastError(session, info.code, info.message, { videoIndex })
```

```typescript
      await broadcastError(session, info.code, info.message, { videoIndex })
```

```typescript
      await broadcastError(session, reason, message, { videoIndex })
```

> If `git grep -n 'broadcastError(' src/logic/presentation-manager/component.ts` returns additional sites beyond these four, apply the same `videoUrl` removal there too.

### 5. `src/adapters/video-compositor/component.ts` — redact ffmpeg composite stderr

The composite-process `close` handler (lines 859–875) currently does `logger.warn('Composite process exited with error', { code, stderr: compositeStderr })`. Split into a `warn`-level short reason (`code` only) and a `debug`-level full body so the verbose `compositeStderr` (which may contain temp paths and the `-filter_complex` body) stays off `warn`-level pipelines. AFTER:

```typescript
      compositeProcess.on('close', (code) => {
        const abnormal = code !== null && code !== 0
        if (abnormal && !cleanedUp) {
          logger.warn(`Composite process exited with error`, { code })
          logger.debug(`Composite process stderr`, { stderr: compositeStderr })
        }
        if (!cleanedUp && isPlaying) {
          stopPlayback(publisher, slideBuffer, slideWidth, slideHeight)
          if (abnormal) {
            // FFmpeg died mid-stream — treat as an error, not a natural end.
            fireError('video-playback-interrupted')
          } else if (onEndCallback) {
            onEndCallback()
          } else {
            endLatched = true
          }
        }
      })
```

### 6. `src/adapters/video-compositor/component.ts` — redact audio stderr the same way

The audio-process `close` handler (lines 766–769) does `logger.warn('Audio process exited with error', { code, stderr: audioStderr })`. Apply the same split. AFTER:

```typescript
        audioProcess.on('close', (code) => {
          if (code && code !== 0 && !cleanedUp) {
            logger.warn(`Audio process exited with error`, { code })
            logger.debug(`Audio process stderr`, { stderr: audioStderr })
          }
          audioProcess = null
        })
```

### 7. `src/adapters/camera-overlay-compositor/component.ts` — RGBA buffer copy confirmation

If Phase 3 has already landed, the `composeFrame` body now uses `new Uint8ClampedArray(rgba.data.buffer.slice(rgba.data.byteOffset, rgba.data.byteOffset + rgba.data.byteLength), ...)` rather than the aliased view — that closes the buffer-aliasing Low finding. **This step is a no-op if Phase 3 ran first.** If Phase 5 runs before Phase 3, apply the same `.slice(...)` copy to both the slide and the camera `ImageData` constructions (currently lines 83–88 and 97–101) so the finding is closed regardless of phase order. AFTER (the camera `ImageData` line — match for the slide line):

```typescript
    const camImageData = new ImageData(
      new Uint8ClampedArray(rgba.data.buffer.slice(rgba.data.byteOffset, rgba.data.byteOffset + rgba.data.byteLength)),
      rgba.width,
      rgba.height
    )
```

## Verification

```bash
yarn typecheck && yarn lint && yarn test
```

## Learnings (post-execution)

After running this phase, append to `learnings/phase-5.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
