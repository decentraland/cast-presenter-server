# Phase 3 learnings

## 2026-05-21 — done

- ESLint auto-fix (`yarn lint --fix`) resolved all import-order/prettier/sort-imports nits in the new files — saved hand-reordering. Phase 1's note about depth ordering still holds but `--fix` is faster than reasoning about it.
- `createCameraOverlayCompositorComponent()` is intentionally synchronous (matches `createVideoCompositorComponent`/`createLiveKitPublisherComponent`); the spec's `await createCameraOverlayCompositorComponent()` snippet wraps a non-Promise — wired it without `await` to match the existing `videoCompositor` line.
- `test/unit/presentation-manager.spec.ts` is currently broken by Phase 2's in-flight addition of `setPresenterCameraTrackHandler` to `ILiveKitPublisher` (the mock object is missing the new method). Verified by stashing Phase 3 — failure persists. Not in Phase 3's scope to fix; Phase 2 owns the mock update.
- Skipped the optional smoke benchmark spec (`test/unit/camera-overlay-compositor.spec.ts`) — would have required exporting `composeFrame` for testing, which mutates the public surface. Leaving the per-frame `createCanvas` allocations alone until Phase 5 has real numbers to justify the closure-hoisting optimization.
