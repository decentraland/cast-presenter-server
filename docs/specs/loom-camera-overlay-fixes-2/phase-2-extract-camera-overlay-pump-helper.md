# Phase 2: Extract `startCameraOverlayPump` helper

## Dependencies

- None (independent of Phase 1; touches `presentation-manager/component.ts` only)

## Files to modify (1)

| File | Change |
|------|--------|
| `src/logic/presentation-manager/component.ts` | Add a local `startCameraOverlayPump` helper; replace two duplicated blocks (active-branch and onEnd) with calls to it; reuse closure-captured `publisherLogger`. |

## Steps

### 1. Add the `startCameraOverlayPump` helper

Insert the helper inside the same closure that defines `restartPlaybackOnCameraFlip` (around line 385 — the helper should be a sibling of `restartPlaybackOnCameraFlip`, declared before `publisher.setPresenterCameraTrackHandler(...)` at line 401). The helper captures `cameraOverlayCompositor` and `publisherLogger` from the enclosing closure. It does not stop a prior compositor — callers remain responsible for cleanup of the previous instance.

The cited literal `restartPlaybackOnCameraFlip` is locally unique (declared once in this closure). Insert the new helper immediately after `restartPlaybackOnCameraFlip`'s closing `}`.

AFTER (the new helper):

```typescript
      const startCameraOverlayPump = async (session: InternalSession): Promise<void> => {
        if (!session.overlayConfig) return
        if (!session.lastPresenterCameraTrack) return
        const overlay = cameraOverlayCompositor.createCompositor(publisherLogger, session.overlayConfig)
        session.cameraOverlayCompositor = overlay
        session.publisher.stopHeartbeat()
        await overlay.start(
          session.lastPresenterCameraTrack,
          session.lastFrameBuffer ?? Buffer.alloc(0),
          session.lastFrameWidth,
          session.lastFrameHeight,
          (composite) => {
            session.publisher.pushFrame(composite.buffer, composite.width, composite.height, /* I420 */ 5)
          }
        )
      }
```

Notes:
- The helper takes `session` only — `cameraOverlayCompositor` and `publisherLogger` come from the closure, matching the pattern of `restartPlaybackOnCameraFlip` directly above it.
- The two preconditions (`overlayConfig` and `lastPresenterCameraTrack`) make the helper safely no-op if a caller forgets a guard. The existing call sites already check these, but defensive guards inside the helper keep both sites' postconditions identical.
- The active-branch call site passes `event.track` directly today; we replace that with `session.lastPresenterCameraTrack` because the active-branch assigns `session.lastPresenterCameraTrack = event.track` immediately before starting the pump (current line 418), so the values are equivalent. This unifies the two call sites on a single source of truth.

### 2. Replace the active-branch block (current lines 422-433) with a helper call

Inside `publisher.setPresenterCameraTrackHandler`'s `event.kind === 'active'` arm, replace the `if (session.videoState !== 'playing' && session.videoState !== 'loading') { … }` body (the block that calls `session.publisher.stopHeartbeat()` and `await overlay.start(...)`) with a single helper call. The cited literal `session.videoState !== 'playing'` is locally unique (one occurrence in this function). The `const overlay = cameraOverlayCompositor.createCompositor(publisherLogger, session.overlayConfig)` + `session.cameraOverlayCompositor = overlay` lines at the top of this branch (current lines 415-416) move **into** the helper, so they must be deleted from the call site.

AFTER (the active arm becomes):

```typescript
          if (event.kind === 'active') {
            // (Re)create the compositor with this track. The previous one — if any —
            // was bound to an older track and must be released.
            if (session.cameraOverlayCompositor) {
              await session.cameraOverlayCompositor.stop().catch(() => {
                /* best-effort cleanup */
              })
            }
            session.presenterCameraActive = true
            session.lastPresenterCameraTrack = event.track

            // Only start the canvas pump if no embedded video is playing. The Phase-5
            // ffmpeg path takes over while a video runs.
            if (session.videoState !== 'playing' && session.videoState !== 'loading') {
              await startCameraOverlayPump(session)
            }

            // If a video is currently playing, restart playback so ffmpeg picks up
            // the camera input. A few hundred ms of stutter is acceptable for v1.
            await restartPlaybackOnCameraFlip('activate')
          } else {
```

Important: `session.presenterCameraActive` and `session.lastPresenterCameraTrack` must be set **before** calling `startCameraOverlayPump` so the helper's `session.lastPresenterCameraTrack` guard passes.

### 3. Replace the `onEnd` duplicated block (current lines 932-958) with a helper call

Inside `playVideoSession`'s `compositor.onEnd(async () => { … })` callback, replace the `try { const overlay = cameraOverlayCompositor.createCompositor(logs.getLogger(\`livekit-publisher:${session.id}\`), …) … await overlay.start(…) } catch (err) { … }` block with a call to the helper, preserving the existing four-clause `if` precondition and the existing `catch` that logs `Failed to restart canvas pump after video end:`. The cited literal `Failed to restart canvas pump after video end` is locally unique in this file.

AFTER (the block inside `onEnd`):

```typescript
      if (
        session.presenterCameraActive &&
        session.overlayConfig &&
        session.lastPresenterCameraTrack &&
        session.lastFrameBuffer
      ) {
        try {
          await startCameraOverlayPump(session)
        } catch (err) {
          logger.warn(
            `Failed to restart canvas pump after video end: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
```

Notes:
- The `logs.getLogger(\`livekit-publisher:${session.id}\`)` inline call is gone — the helper uses the closure-captured `publisherLogger`, which resolves to the same logger object. This closes the secondary review finding about inconsistent logger construction.
- The `logger.warn` in the `catch` continues to use the outer `logger` (the session logger, not the publisher logger), matching the pre-existing behaviour for error reporting in this callback.

## Verification

```bash
yarn typecheck
yarn lint
yarn test
```

Sanity-check that there is exactly one occurrence of the `/* I420 */ 5` push-callback shape in `presentation-manager/component.ts` after the refactor (it now lives inside `startCameraOverlayPump` only):

```bash
grep -c "/\* I420 \*/ 5" src/logic/presentation-manager/component.ts
# expect 1
```

And that `logs.getLogger(\`livekit-publisher:` no longer appears inside `playVideoSession`'s `onEnd` callback:

```bash
grep -n "logs.getLogger(\`livekit-publisher:" src/logic/presentation-manager/component.ts
# expect at most one match — the original publisherLogger construction near line ~380.
# The onEnd inline reconstruction at the former line 940 must be gone.
```
