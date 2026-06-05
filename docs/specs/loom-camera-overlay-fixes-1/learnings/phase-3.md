# Phase 3 — allocation + dead-code cleanup

## 2026-05-21 — done
- `ReturnType<typeof createCanvas>` resolves to `SvgCanvas` (the last overload in `@napi-rs/canvas/index.d.ts:845-847`), not the `Canvas` we want. Hoisted closure vars must be typed as the explicit `Canvas` import (`import { type Canvas, ImageData, createCanvas } from '@napi-rs/canvas'`) — the spec's `ReturnType<typeof createCanvas>` form fails typecheck against `Canvas`-expecting APIs (`drawImage`, `getContext`).
- After dropping `currentTrack`, `RemoteVideoTrack` is no longer referenced anywhere in `camera-overlay-compositor/component.ts` (the `start` method's `track` parameter is inferred from the interface). Removed the import proactively.
- Stale references to the dead API beyond the spec's enumerated locations:
  - `test/unit/presentation-manager.spec.ts:87` mocks `getTrack: jest.fn().mockReturnValue(null)` — removed.
  - `src/logic/presentation-manager/component.ts:878` had a comment "stop() nulls its `currentTrack`" — reworded.
- After rewiring the pump to reuse `cameraInit.stream` / `cameraInit.reader`, the `cameraStream` closure var loses its only read (`.getReader()`); eslint emits a non-fatal `no-unused-vars` warning. Kept the variable per spec instructions (`cameraStream = cameraInit.stream`) — the assignment exists for resource-ownership tracking via the `cameraStream = null` cleanup lines. Lint still exits 0.
