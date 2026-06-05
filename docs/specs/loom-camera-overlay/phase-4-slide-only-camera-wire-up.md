# Phase 4: Wire the camera-overlay compositor into the slide-only flow

## Dependencies

- Phase 2 (presenter camera lifecycle callback).
- Phase 3 (`camera-overlay-compositor` adapter).

## Goal

Replace the static `publisher.pushFrame + publisher.startHeartbeat` pattern (which freezes a slide at 500 ms intervals) with a single helper that picks the right output mode:

- **Heartbeat** when the presenter camera is inactive (today's behaviour).
- **Camera-overlay pump** when the presenter camera is active **and** no embedded video is playing.

Embedded-video playback (the case where ffmpeg is already running) is handled in Phase 5 — for this phase, if a video starts, the camera-overlay pump stops and the existing ffmpeg path runs *without* the camera.

## Files to modify (2)

| File | Change |
|------|--------|
| `src/logic/presentation-manager/types.ts` | Extend `InternalSession` (if present) with the new state fields. |
| `src/logic/presentation-manager/component.ts` | Add `setupSlideOutput()` helper; register a presenter-camera handler; route the four existing `pushFrame + startHeartbeat` call sites through the helper. |

## Steps

### 1. `src/logic/presentation-manager/component.ts` — Add imports

Import the new compositor types. Add a new line under the existing component imports (the file already imports from `'../../adapters/video-compositor'` — grep for it). AFTER:

```typescript
import type { ICameraOverlayCompositor, ICameraOverlayCompositorComponent } from '../../adapters/camera-overlay-compositor'
```

Then add `cameraOverlayCompositor: ICameraOverlayCompositorComponent` to the destructured component list at the top of `createPresentationManager` (grep for `const { … } = components` or `const liveKitPublisher = …` at function start). Follow the existing pattern used for `videoCompositor`.

### 2. `src/logic/presentation-manager/component.ts` — Extend `InternalSession`

Find the `InternalSession` declaration (grep `interface InternalSession`). Add three new optional fields immediately after the existing `compositor: …` field:

```typescript
  cameraOverlayCompositor: ICameraOverlayCompositor | null
  presenterCameraActive: boolean
```

(The session record already stores `overlayConfig` from Phase 1 via the `PresentationSession` extension — no additional declaration needed here.)

### 3. `src/logic/presentation-manager/component.ts` — Initialise the new fields on session creation

In the `const session: InternalSession = { … }` literal (currently lines 327-356; `overlayConfig` was added on line ~340 in Phase 1), add the two new fields right after `overlayConfig`:

```typescript
        overlayConfig,
        cameraOverlayCompositor: null,
        presenterCameraActive: false,
```

### 4. `src/logic/presentation-manager/component.ts` — Add `setupSlideOutput` helper

Add this helper inside the module, **outside** `createPresentationManager` is fine because it takes everything it needs as parameters. Place it next to the other top-level helpers (grep `function broadcastState` to find the helpers region — drop it right before that function).

```typescript
async function setupSlideOutput(
  session: InternalSession,
  buffer: Buffer,
  width: number,
  height: number,
  cameraOverlayCompositor: ICameraOverlayCompositorComponent,
  logger: ILoggerComponent.ILogger
): Promise<void> {
  // Always update the cached last-frame fields so reconnect/resume code paths work.
  session.lastFrameBuffer = buffer
  session.lastFrameWidth = width
  session.lastFrameHeight = height

  // If an embedded video is playing, slide output is owned by the ffmpeg compositor.
  // Phase 5 adds the camera into the ffmpeg pipeline; nothing for us to do here.
  if (session.videoState === 'playing' || session.videoState === 'loading') {
    return
  }

  const shouldOverlay = session.presenterCameraActive && session.overlayConfig
  if (shouldOverlay) {
    // We can't start the compositor without a live RemoteVideoTrack handle.
    // The handler in createPresentation owns the track — it calls this function
    // already wired up. If we land here with no compositor instance, it means
    // the handler hasn't fired yet, so fall through to heartbeat for now; the
    // handler will run setupSlideOutput again when 'active' fires.
    if (session.cameraOverlayCompositor) {
      session.publisher.stopHeartbeat()
      session.cameraOverlayCompositor.updateSlide(buffer, width, height)
      // Compositor pumps frames itself — first push will follow within ~50ms.
      return
    }
    logger.debug(`[setupSlideOutput] camera active but no compositor instance yet; falling back to heartbeat`)
  }

  session.publisher.pushFrame(buffer, width, height)
  session.publisher.startHeartbeat(buffer, width, height)
}
```

(The `ILoggerComponent` import is already present at the top of the file — no new import needed.)

### 5. `src/logic/presentation-manager/component.ts` — Replace the four `pushFrame + startHeartbeat` call sites

Replace each of these pairs with a single `await setupSlideOutput(...)` call. The four sites:

| Site | Existing pair (line) | Context |
|------|----------------------|---------|
| Initial slide push in `createPresentation` | `publisher.pushFrame(buffer, width, height)` + `publisher.startHeartbeat(buffer, width, height)` at lines 316-317 | First slide of a new session |
| Navigation in `navigateSession` | `session.publisher.pushFrame(buffer, width, height)` + `session.publisher.startHeartbeat(buffer, width, height)` at lines 515-516 | After rendering the target slide |
| Reset-to-static path | lines 807-808 | After explicit stop or error |
| End-of-video last-frame path | lines 830-831 (with `lastFrame.bufferType` arg) and 833-834 | After ffmpeg finishes |

For sites 1-3 the slide buffer is plain RGBA; replace the pair with:

```typescript
await setupSlideOutput(session, buffer, width, height, cameraOverlayCompositor, logger)
```

For site 4 (the `lastFrame.bufferType` path at 830-831), the buffer is I420 and `setupSlideOutput` would silently re-interpret it as RGBA — wrong. Instead, leave that path's heartbeat behaviour exactly as it is today (it's the end-of-video fallback frame). Add a comment above:

```typescript
        // Last-frame fallback is I420 (already-composited frame from ffmpeg); we don't
        // re-route it through the camera-overlay compositor because it isn't RGBA.
```

Site 4 is the one exception. Sites 1, 2, 3 all funnel through the helper.

### 6. `src/logic/presentation-manager/component.ts` — Register the presenter-camera handler

Inside `createPresentation`, immediately after the `publisher.setDataHandler(...)` block (which ends around line 308), register the camera handler. AFTER:

```typescript
      publisher.setPresenterCameraTrackHandler(async (event) => {
        const session = sessions.get(id)
        if (!session) return
        if (!session.overlayConfig) return // overlay disabled for this session

        try {
          if (event.kind === 'active') {
            // (Re)create the compositor with this track. The previous one — if any —
            // was bound to an older track and must be released.
            if (session.cameraOverlayCompositor) {
              await session.cameraOverlayCompositor.stop().catch(() => {})
            }
            const overlay = cameraOverlayCompositor.createCompositor(publisherLogger, session.overlayConfig)
            session.cameraOverlayCompositor = overlay
            session.presenterCameraActive = true

            // Only start the canvas pump if no embedded video is playing. The Phase-5
            // ffmpeg path takes over while a video runs.
            if (session.videoState !== 'playing' && session.videoState !== 'loading') {
              session.publisher.stopHeartbeat()
              await overlay.start(
                event.track,
                session.lastFrameBuffer ?? Buffer.alloc(0),
                session.lastFrameWidth,
                session.lastFrameHeight,
                (composite) => {
                  session.publisher.pushFrame(
                    composite.buffer,
                    composite.width,
                    composite.height,
                    /* I420 */ 5
                  )
                }
              )
            } else {
              // Phase 5 will pick up `session.cameraOverlayCompositor` and feed its
              // frames into the ffmpeg FIFO instead of pushing them directly.
            }
          } else {
            // 'inactive' — release the compositor and fall back to heartbeat.
            session.presenterCameraActive = false
            const old = session.cameraOverlayCompositor
            session.cameraOverlayCompositor = null
            if (old) {
              await old.stop().catch(() => {})
            }
            if (session.lastFrameBuffer) {
              await setupSlideOutput(
                session,
                session.lastFrameBuffer,
                session.lastFrameWidth,
                session.lastFrameHeight,
                cameraOverlayCompositor,
                logger
              )
            }
          }
        } catch (err) {
          logger.warn(
            `[presenter-camera] handler error (${event.kind}): ${err instanceof Error ? err.message : String(err)}`
          )
        }
      })
```

(`publisherLogger` is already in scope from line 250.)

### 7. `src/logic/presentation-manager/component.ts` — Clean up on session stop

Find the session-stop block (`stopSession` function — grep `function stopSession` or `await session.publisher.disconnect()`). Right before `await session.publisher.disconnect()` (line 877), add:

```typescript
      if (session.cameraOverlayCompositor) {
        await session.cameraOverlayCompositor.stop().catch(() => {})
        session.cameraOverlayCompositor = null
      }
```

(`disconnect()` triggers Phase 2's `presenterCameraHandler = null` cleanup automatically.)

## Edge cases

| Scenario | Handling |
|----------|----------|
| Camera goes active during slide-only mode | Handler stops heartbeat, starts compositor with `session.lastFrameBuffer`. |
| Camera goes inactive during slide-only mode | Handler stops compositor, calls `setupSlideOutput` → falls back to heartbeat. |
| Slide navigated while camera is active | `setupSlideOutput` calls `compositor.updateSlide()` instead of pushFrame+heartbeat. |
| Camera goes active while embedded video is playing | Handler creates the compositor instance but does NOT start it; Phase 5 picks it up via `session.cameraOverlayCompositor`. |
| Camera goes inactive while embedded video is playing | Handler clears `presenterCameraActive`; the ffmpeg path notices and tears down its camera-FIFO input on its next checkpoint. |
| Session ends while compositor is running | `stopSession` calls `compositor.stop()` then `publisher.disconnect()`. |

## Verification

```bash
yarn typecheck
yarn lint
yarn test
```

Plus a manual two-cell test:

1. **Cell (camera off, video off)** — Start a session with overlay config + a presenter whose camera is muted. Confirm the heartbeat path runs (no compositor logs, slide is static).
2. **Cell (camera on, video off)** — Same session; presenter unmutes camera. Confirm:
   - `[presenter-camera] active` in the publisher log.
   - The published presentation video shows the circular overlay in the configured corner.
   - Navigating slides updates the underlying slide *without* the circle ever disappearing.

Cells (video on, …) are verified in Phase 6 after Phase 5 lands.

## Learnings (post-execution)

After running this phase, append to `learnings/phase-4.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
