# Phase 2: Narrow camera subscription to presenters

## Dependencies

- None (can run in parallel with Phases 1, 3, 4, 5)

## Goal

Gate the connect-time `setSubscribed(true)` fallback (and the analogous spots in `RoomMetadataChanged` / `TrackUnmuted` reactions) on `presenters.has(participant.identity.toLowerCase())`. Closes the Medium-severity bandwidth-amplification finding from `security-review.md`.

## Files to modify (1)

| File | Change |
|------|--------|
| `src/adapters/livekit-publisher/component.ts` | Filter the connect-time camera-subscription loop by presenters allowlist; also unsubscribe non-presenter publications when metadata changes. |

## Steps

### 1. `src/adapters/livekit-publisher/component.ts` — gate the connect-time subscription loop

Replace the connect-time subscription loop at lines 264–276 (the block beginning with the comment `// Explicit subscription fallback: @livekit/rtc-node may not auto-subscribe to`). The current loop subscribes every `SOURCE_CAMERA` publication regardless of participant identity. Add an identity-based filter that only subscribes when the participant is in the `presenters` set. AFTER:

```typescript
      // Explicit subscription fallback: @livekit/rtc-node may not auto-subscribe to
      // remote tracks depending on room/server config. We can't verify the live
      // behaviour from this environment, so we eagerly call setSubscribed(true) on
      // every PRESENTER camera publication present at connect time. Non-presenter
      // cameras are intentionally skipped — subscribing to them wastes bandwidth
      // and the application would never use the decoded frames (see security-review.md
      // Medium — Eager setSubscribed(true) on every camera publication).
      for (const participant of room.remoteParticipants.values()) {
        const identity = (participant.identity || '').toLowerCase()
        if (!presenters.has(identity)) continue
        for (const publication of participant.trackPublications.values()) {
          if (publication.source === TrackSource.SOURCE_CAMERA) {
            try {
              await publication.setSubscribed(true)
            } catch (err) {
              logger.warn(
                `Failed to subscribe to camera publication: ${err instanceof Error ? err.message : String(err)}`
              )
            }
          }
        }
      }
```

### 2. `src/adapters/livekit-publisher/component.ts` — re-evaluate subscriptions on `RoomMetadataChanged`

Inside the existing `RoomMetadataChanged` listener (starts at line 147 with `room.on(RoomEvent.RoomMetadataChanged, ...)` and currently re-runs `maybeActivatePresenterCamera` for each existing publication), extend the inner loop so that newly-recognized presenters' camera publications are subscribed via `setSubscribed(true)`, and previously-recognized publications that no longer belong to a presenter are explicitly unsubscribed via `setSubscribed(false)`. AFTER:

```typescript
      room.on(RoomEvent.RoomMetadataChanged, (metadata: string) => {
        presenters = parsePresentersFromRoomMetadata(metadata)
        logger.info(`[RoomMetadataChanged] Presenters updated: ${[...presenters].join(', ') || 'none'}`, {
          rawMetadata: metadata
        })
        for (const participant of room?.remoteParticipants.values() ?? []) {
          const identity = (participant.identity || '').toLowerCase()
          const isPresenter = presenters.has(identity)
          for (const publication of participant.trackPublications.values()) {
            if (publication.source !== TrackSource.SOURCE_CAMERA) continue
            // Subscribe presenter cameras, unsubscribe non-presenter cameras.
            // setSubscribed is idempotent in @livekit/rtc-node.
            publication.setSubscribed(isPresenter).catch((err) => {
              logger.warn(
                `Failed to ${isPresenter ? 'subscribe to' : 'unsubscribe from'} camera publication: ${err instanceof Error ? err.message : String(err)}`
              )
            })
            const track = publication.track
            if (isPresenter && track instanceof RemoteVideoTrack) {
              maybeActivatePresenterCamera(track, publication, participant)
            }
          }
        }
      })
```

### 3. `src/adapters/livekit-publisher/component.ts` — gate `TrackUnmuted` reactivation by presenters set

The existing `TrackUnmuted` handler (around lines 248–257) already checks `presenters.has((participant.identity || '').toLowerCase())` before calling `maybeActivatePresenterCamera`. No change is required here — leave the handler as-is. (This step exists so the executor doesn't worry the listener was missed.)

## Verification

```bash
yarn typecheck && yarn lint
```

If any livekit-publisher unit/integration tests exist that exercise the connect-time subscription loop, run them too:

```bash
yarn test test/integration/loom-overlay.spec.ts
```

## Learnings (post-execution)

After running this phase, append to `learnings/phase-2.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
