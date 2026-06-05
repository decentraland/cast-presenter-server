# Phase 4: Helper shape cleanup — drop redundant params, extract duplicated branch

## Dependencies

- None (can run in parallel with Phases 1, 2, 3, 5)

## Goal

Two related cleanups in `src/logic/presentation-manager/component.ts`:

1. `setupSlideOutput` takes `cameraOverlayCompositor` and `logger` as parameters even though both are already in scope from `createPresentationManager`'s closure. Drop the parameters and let the function close over them.
2. The restart-on-camera-flip block is byte-identical (apart from one log message) across the active and inactive branches of the presenter-camera handler. Extract a local helper `restartPlaybackOnCameraFlip(reason)`.

Closes the corresponding `review.md` findings.

## Files to modify (1)

| File | Change |
|------|--------|
| `src/logic/presentation-manager/component.ts` | Drop two params from `setupSlideOutput`; update all three call sites; extract `restartPlaybackOnCameraFlip` and replace both duplicated blocks with calls. |

## Steps

### 1. `src/logic/presentation-manager/component.ts` — drop `cameraOverlayCompositor` and `logger` from `setupSlideOutput`'s signature

The function declaration starts at line 229. Remove the last two parameters from the signature (`cameraOverlayCompositor: ICameraOverlayCompositorComponent` and `logger: ILoggerComponent.ILogger`). The function body already uses identifiers `cameraOverlayCompositor` / `logger` (the closure-captured ones from `createPresentationManager`'s scope) — once the parameters are removed, those references resolve to the closure values, which is the intended behavior. AFTER:

```typescript
  async function setupSlideOutput(
    session: InternalSession,
    buffer: Buffer,
    width: number,
    height: number
  ): Promise<void> {
```

(The function body — lines 237–266 — does not need to change. The `logger.debug(...)` call already in the body resolves to the closure `logger` once the parameter shadow is gone.)

### 2. `src/logic/presentation-manager/component.ts` — update `setupSlideOutput` call at line 525

Inside `createPresentation` (around line 525), the call currently reads `await setupSlideOutput(session, buffer, width, height, cameraOverlayCompositor, logger)`. Remove the last two arguments. AFTER:

```typescript
      await setupSlideOutput(session, buffer, width, height)
```

### 3. `src/logic/presentation-manager/component.ts` — update `setupSlideOutput` call at line 682

Inside `navigateSession` (around line 682), the call currently reads `await setupSlideOutput(session, buffer, width, height, cameraOverlayCompositor, logger)`. Remove the last two arguments. AFTER:

```typescript
      await setupSlideOutput(session, buffer, width, height)
```

### 4. `src/logic/presentation-manager/component.ts` — update `setupSlideOutput` call at line 1020

Inside `stopVideoSession` (around line 1020), the call currently reads:

```typescript
      await setupSlideOutput(
        session,
        session.lastFrameBuffer,
        session.lastFrameWidth,
        session.lastFrameHeight,
        cameraOverlayCompositor,
        logger
      )
```

Remove the last two arguments. AFTER:

```typescript
      await setupSlideOutput(
        session,
        session.lastFrameBuffer,
        session.lastFrameWidth,
        session.lastFrameHeight
      )
```

### 5. `src/logic/presentation-manager/component.ts` — update `setupSlideOutput` call at line 445 (inside the camera handler's inactive branch)

The presenter-camera handler's inactive branch (around line 445) also calls `setupSlideOutput(session, session.lastFrameBuffer, session.lastFrameWidth, session.lastFrameHeight, cameraOverlayCompositor, logger)`. Remove the last two arguments. AFTER:

```typescript
            if (session.lastFrameBuffer) {
              await setupSlideOutput(
                session,
                session.lastFrameBuffer,
                session.lastFrameWidth,
                session.lastFrameHeight
              )
            }
```

### 6. `src/logic/presentation-manager/component.ts` — extract `restartPlaybackOnCameraFlip` helper

Inside `createPresentation`, immediately before the `publisher.setPresenterCameraTrackHandler(async (event) => {` call (currently around line 386), add a local helper function `restartPlaybackOnCameraFlip`. It captures the `session` and `logger` from the surrounding scope and replicates the original block's behavior. AFTER (insert as a new declaration; the surrounding `createPresentation` is already `async`):

```typescript
      // Restart embedded-video playback so ffmpeg picks up the new camera-input
      // shape (added on 'activate', dropped on 'deactivate'). Both branches of the
      // presenter-camera handler need the same restart, so the body is extracted
      // here to keep them in sync.
      const restartPlaybackOnCameraFlip = async (reason: 'activate' | 'deactivate'): Promise<void> => {
        const session = sessions.get(id)
        if (!session) return
        if (session.videoState !== 'playing') return
        if (session.pausedVideoIndex < 0) return
        const elapsedMs = Date.now() - session.videoPlaybackStartedAt
        session.videoElapsedBeforePause += elapsedMs
        session.videoState = 'paused'
        const indexToResume = session.pausedVideoIndex
        await playVideoSession(session, indexToResume).catch((err) =>
          logger.warn(
            `Playback restart on camera ${reason} failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
      }
```

> The helper looks up `session` via `sessions.get(id)` (rather than capturing the outer-scope `session` const) because the handler's own retrieval can re-fire after the session is removed; this keeps the helper safe to call from a stale handler event.

### 7. `src/logic/presentation-manager/component.ts` — replace the active-branch restart block

Inside the presenter-camera handler's `event.kind === 'active'` branch (currently lines 420–432, the block beginning with the comment `// If a video is currently playing, restart playback so ffmpeg picks up`), delete the entire block (the comment plus the `if (session.videoState === 'playing' && session.pausedVideoIndex >= 0) { ... }` body) and replace it with a single call. AFTER:

```typescript
            // If a video is currently playing, restart playback so ffmpeg picks up
            // the camera input. A few hundred ms of stutter is acceptable for v1.
            await restartPlaybackOnCameraFlip('activate')
```

### 8. `src/logic/presentation-manager/component.ts` — replace the inactive-branch restart block

Inside the presenter-camera handler's `else` (inactive) branch (currently lines 455–466, the block beginning with the comment `// If a video is currently playing, restart so ffmpeg drops the camera input.`), delete the entire block and replace it with a single call. AFTER:

```typescript
            // If a video is currently playing, restart so ffmpeg drops the camera input.
            await restartPlaybackOnCameraFlip('deactivate')
```

## Verification

```bash
yarn typecheck && yarn lint
```

Then a targeted run of any tests that exercise the presenter-camera handler:

```bash
yarn test test/integration/loom-overlay.spec.ts
```

## Learnings (post-execution)

After running this phase, append to `learnings/phase-4.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
