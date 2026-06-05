# Phase 2: Subscribe to the presenter's camera track

## Dependencies

- Phase 1 (uses `OverlayConfig` to decide whether subscribing is needed at all).
- Can run in parallel with Phase 3.

## Goal

When a participant publishes a `SOURCE_CAMERA` track and their identity is in the presenter set, surface a lifecycle callback to the rest of the codebase. This phase does **not** consume frames — it only observes the track's existence and active/muted state, and exposes that observation as a new `ILiveKitPublisher` API.

## Files to modify (2)

| File | Change |
|------|--------|
| `src/adapters/livekit-publisher/types.ts` | Add `PresenterCameraTrackHandler` and `setPresenterCameraTrackHandler` on the `ILiveKitPublisher` interface. |
| `src/adapters/livekit-publisher/component.ts` | Wire `RoomEvent.TrackSubscribed`, `TrackUnsubscribed`, `TrackMuted`, `TrackUnmuted` for presenter camera publications; invoke the registered handler on state changes. |

## Steps

### 1. `src/adapters/livekit-publisher/types.ts` — Add handler type and interface method

After the existing `import` statements at line 1, add the rtc-node imports we'll need to reference:

```typescript
import type { RemoteVideoTrack, RemoteParticipant } from '@livekit/rtc-node'
```

Then, just before the `export interface ILiveKitPublisher` block at line 9, declare:

```typescript
/** Lifecycle event for the presenter's camera track. */
export type PresenterCameraEvent =
  | { kind: 'active'; track: RemoteVideoTrack; participant: RemoteParticipant }
  | { kind: 'inactive' }

export type PresenterCameraTrackHandler = (event: PresenterCameraEvent) => void
```

Inside `ILiveKitPublisher` (currently lines 9-23), add the new method right after `setDataHandler` (line 18). AFTER:

```typescript
  /**
   * Registers a handler that fires whenever the presenter's camera track becomes
   * active (subscribed + unmuted) or inactive (muted, unsubscribed, or presenter
   * left the room). The handler is invoked with the latest event; missed events
   * are not replayed if a previous handler unregistered.
   */
  setPresenterCameraTrackHandler(handler: PresenterCameraTrackHandler | null): void
```

### 2. `src/adapters/livekit-publisher/component.ts` — Import additional rtc-node symbols

The existing imports at lines 2-15 already pull `Room`, `RoomEvent`, `TrackSource`, etc. Add the additional symbols needed for camera-track filtering. Edit the existing destructured import from `@livekit/rtc-node` to include:

```typescript
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  LocalVideoTrack,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteVideoTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  VideoCodec,
  VideoFrame,
  VideoSource
} from '@livekit/rtc-node'
```

(Symbols added: `RemoteParticipant`, `RemoteTrack`, `RemoteTrackPublication`, `RemoteVideoTrack`, `TrackKind`.)

Update the `import type` from `./types` (line 17) to also bring in `PresenterCameraTrackHandler`:

```typescript
import type { ILiveKitPublisher, ILiveKitPublisherComponent, PresenterCameraTrackHandler } from './types'
```

### 3. `src/adapters/livekit-publisher/component.ts` — Add internal state for the camera handler

Inside `createPublisher` (starts at line 69), the existing closure variables (lines 70-78) declare `room`, `videoSource`, `videoTrack`, …, `presenters`, `lastSceneId`. Add two new closure variables right after `lastSceneId` (line 78). AFTER:

```typescript
  let lastSceneId = ''
  let presenterCameraHandler: PresenterCameraTrackHandler | null = null
  // Tracks the currently-active presenter camera so we don't fire 'active' twice
  // for the same publication if multiple presenters race to enable their cameras.
  let activePresenterCameraSid: string | null = null
```

### 4. `src/adapters/livekit-publisher/component.ts` — Wire `TrackSubscribed` / `TrackUnsubscribed` / `TrackMuted` / `TrackUnmuted`

Inside the `connect()` method, right after the `RoomEvent.DataReceived` handler block (currently ends at line 184, just before the closing `)` of `room.on(...)`), add four new `room.on(...)` calls. AFTER (insert immediately *before* the `}` that closes `connect()` at line 185):

```typescript
      room.on(
        RoomEvent.TrackSubscribed,
        (track: RemoteTrack, publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          maybeActivatePresenterCamera(track, publication, participant)
        }
      )

      room.on(
        RoomEvent.TrackUnsubscribed,
        (track: RemoteTrack, _publication: RemoteTrackPublication, _participant: RemoteParticipant) => {
          if (activePresenterCameraSid && track.sid === activePresenterCameraSid) {
            deactivatePresenterCamera()
          }
        }
      )

      room.on(
        RoomEvent.TrackMuted,
        (publication: RemoteTrackPublication, _participant: RemoteParticipant) => {
          if (activePresenterCameraSid && publication.sid === activePresenterCameraSid) {
            deactivatePresenterCamera()
          }
        }
      )

      room.on(
        RoomEvent.TrackUnmuted,
        (publication: RemoteTrackPublication, participant: RemoteParticipant) => {
          if (!presenters.has((participant.identity || '').toLowerCase())) return
          if (publication.source !== TrackSource.SOURCE_CAMERA) return
          const track = publication.track
          if (track instanceof RemoteVideoTrack) {
            maybeActivatePresenterCamera(track, publication, participant)
          }
        }
      )
```

### 5. `src/adapters/livekit-publisher/component.ts` — Add the activation/deactivation helpers

Insert two helper functions inside `createPublisher`, between the existing closure variables (after the new ones from step 3) and the `return { … }` at line 80. AFTER:

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
    if (!presenters.has(identity)) return
    // First-wins: if another presenter already has an active camera, ignore.
    if (activePresenterCameraSid && activePresenterCameraSid !== track.sid) return
    activePresenterCameraSid = track.sid ?? null
    logger.info(`[presenter-camera] active: ${participant.identity} sid=${track.sid}`)
    presenterCameraHandler?.({ kind: 'active', track, participant })
  }

  function deactivatePresenterCamera(): void {
    if (!activePresenterCameraSid) return
    logger.info(`[presenter-camera] inactive (sid was ${activePresenterCameraSid})`)
    activePresenterCameraSid = null
    presenterCameraHandler?.({ kind: 'inactive' })
  }
```

### 6. `src/adapters/livekit-publisher/component.ts` — Implement `setPresenterCameraTrackHandler`

Inside the returned object (the `return { … }` block starting at line 80), add the new method between `setDataHandler` (line 272) and `updateMetadataState` (line 276). AFTER:

```typescript
    setPresenterCameraTrackHandler(handler: PresenterCameraTrackHandler | null): void {
      presenterCameraHandler = handler
    },
```

### 7. `src/adapters/livekit-publisher/component.ts` — Clear camera state on disconnect

The existing `disconnect()` implementation runs from line 303. Right after `presenters = new Set()` at line 306, add:

```typescript
      activePresenterCameraSid = null
      presenterCameraHandler = null
```

(Avoids dangling listeners holding a reference to the next session's compositor after a fast restart.)

### 8. `src/adapters/livekit-publisher/component.ts` — Re-check existing publications after room metadata changes

When room metadata changes mid-session (the existing `RoomMetadataChanged` handler at lines 115-120), a previously non-presenter participant may have *just* become a presenter; their already-subscribed camera publications need to fire `maybeActivatePresenterCamera` retroactively. Inside the existing `RoomMetadataChanged` handler (line 117 calls `logger.info(...)`), add at the end of the callback body:

```typescript
        for (const participant of room?.remoteParticipants.values() ?? []) {
          for (const publication of participant.trackPublications.values()) {
            const track = publication.track
            if (track instanceof RemoteVideoTrack) {
              maybeActivatePresenterCamera(track, publication, participant)
            }
          }
        }
```

(`room` is the closure-captured `Room` from line 70. Use the optional-chain to handle the edge case where the metadata event fires during teardown.)

## Edge cases

| Scenario | Handling |
|----------|----------|
| Presenter has camera off the whole session | Handler never fires `active`. Slide-only path stays in heartbeat mode. |
| Presenter toggles camera on → off → on | `active` → `inactive` → `active`. No deduplication; each `active` carries the latest `RemoteVideoTrack`. |
| Two presenters both enable cameras | First subscribed wins. Second is ignored until the first one disconnects or mutes. |
| Presenter leaves room mid-session | LiveKit fires `TrackUnsubscribed` for their publications; we deactivate. |
| Camera publication exists at connect time (presenter already streaming when server joins) | The room may auto-subscribe and replay `TrackSubscribed` after `connect()`. **Verification step below confirms this.** If it does NOT replay, add an explicit pass during `connect()` after `presenters` is populated. |

## Verification

```bash
yarn typecheck
yarn lint
yarn test
```

Plus a **subscription-replay smoke test** — the result determines whether the spec's auto-subscribe assumption holds:

1. Start a LiveKit room with a presenter who is already publishing a camera track.
2. Start `cast-presenter-server` and create a presentation in that room.
3. Confirm `[presenter-camera] active: …` appears in the publisher log within ~2 seconds of `connect()` completing.

If the log line does **not** appear, the room is not auto-subscribing. In that case, add the following block to `connect()` right after the existing `presenters = parsePresentersFromRoomMetadata(...)` call at line 112:

```typescript
      for (const participant of room.remoteParticipants.values()) {
        for (const publication of participant.trackPublications.values()) {
          if (publication.source === TrackSource.SOURCE_CAMERA) {
            try {
              await publication.setSubscribed(true)
            } catch (err) {
              logger.warn(`Failed to subscribe to camera publication: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
        }
      }
```

Log the verification outcome in `learnings/phase-2.md`.

## Learnings (post-execution)

After running this phase, append to `learnings/phase-2.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
