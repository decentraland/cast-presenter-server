# Phase 6: Integration tests for the 2×2 mode matrix

## Dependencies

- All prior phases (1–5).

## Goal

Lock in the four mode cells with automated tests and a documented manual verification sequence. The matrix:

|  | Camera off | Camera on |
|---|---|---|
| **Video off** | A — heartbeat slide-only (existing behaviour, regression) | B — canvas pump (Phase 3+4) |
| **Video on** | C — 2-input ffmpeg (existing behaviour, regression) | D — 3-input ffmpeg (Phase 5) |

## Files to create (2)

| File | Purpose |
|------|---------|
| `test/integration/loom-overlay.spec.ts` | End-to-end test exercising A→B→D→C transitions against a local LiveKit room. |
| `test/unit/build-filter-complex.spec.ts` | Pure unit test for the exported `buildFilterComplex` (added in Phase 5). |

## Files to modify (0)

None.

## Steps

### 1. Create `test/unit/build-filter-complex.spec.ts`

```typescript
import { buildFilterComplex } from '../../src/adapters/video-compositor/component'

describe('buildFilterComplex', () => {
  const videoOverlay = { x: 100, y: 200, w: 640, h: 480 }

  it('returns the 2-input filter when camera is absent', () => {
    const f = buildFilterComplex({ videoOverlay, camera: null })
    expect(f).toBe('[1:v]scale=640:480[vid];[0:v][vid]overlay=100:200:shortest=1')
  })

  it('builds a circular-mask + corner overlay when camera is present', () => {
    const f = buildFilterComplex({
      videoOverlay,
      camera: { config: { corner: 'BR', size: 'medium' }, slideWidth: 1280, slideHeight: 720 }
    })
    // 20% of 1280 = 256, margin 2% = 26, BR origin = (1280-26-256, 720-26-256) = (998, 438)
    expect(f).toContain('[bg][cam]overlay=998:438')
    expect(f).toContain('scale=256:256,format=yuva420p')
    expect(f).toContain("hypot(X-128,Y-128)")
  })

  it('places the camera in TL at margin offset', () => {
    const f = buildFilterComplex({
      videoOverlay,
      camera: { config: { corner: 'TL', size: 'small' }, slideWidth: 1920, slideHeight: 1080 }
    })
    // 15% of 1920 = 288, margin 2% = 38, TL origin = (38, 38)
    expect(f).toContain('[bg][cam]overlay=38:38')
  })

  it('throws on out-of-range slide size (validateFilterParam)', () => {
    expect(() =>
      buildFilterComplex({
        videoOverlay,
        camera: { config: { corner: 'BR', size: 'large' }, slideWidth: 99999, slideHeight: 720 }
      })
    ).toThrow(/Invalid ffmpeg filter param/)
  })
})
```

### 2. Create `test/integration/loom-overlay.spec.ts`

This test uses the project's existing integration scaffolding — grep `test/integration/` for the helpers it provides (LiveKit room fixture, test publisher). Mirror the structure of the nearest existing integration spec (likely `test/integration/presentation-flow.spec.ts` or similar — confirm by listing `test/integration/`).

```typescript
/**
 * Loom-style overlay integration tests — exercises the 2×2 mode matrix.
 * Assumes the project's LiveKit test fixture exposes:
 *   - startTestRoom(): RoomFixture with .url, .presenterToken, .serverToken
 *   - publishCamera(token): handle with .mute()/.unmute()
 *   - createPresentation(server, fileBuffer, overlayConfig?): PresentationInfo
 *   - sampleTrack(roomId, trackName): VideoSample (single decoded RGBA frame)
 */
import { startTestServer, startTestRoom, publishCamera, createPresentation, sampleTrack } from '../helpers/livekit'
import { readFileSync } from 'fs'
import { join } from 'path'

const SAMPLE_PDF = readFileSync(join(__dirname, '../fixtures/sample-2-slides.pdf'))

describe('Loom overlay: 2x2 mode matrix', () => {
  let server: Awaited<ReturnType<typeof startTestServer>>
  let room: Awaited<ReturnType<typeof startTestRoom>>

  beforeAll(async () => {
    server = await startTestServer()
  })

  afterAll(async () => {
    await server.stop()
  })

  beforeEach(async () => {
    room = await startTestRoom()
  })

  afterEach(async () => {
    await room.stop()
  })

  it('A: slide-only with no camera (heartbeat)', async () => {
    const info = await createPresentation(server, room, SAMPLE_PDF)
    const sample = await sampleTrack(room.id, 'presentation')
    // No camera → top-left 10×10 region should match the slide background (no circle).
    expect(sample.regionMeanAlpha({ x: 50, y: 50, w: 10, h: 10 })).toBe(255)
    expect(info.slideCount).toBeGreaterThan(0)
  })

  it('B: slide + camera (canvas pump)', async () => {
    const cam = await publishCamera(room.presenterToken)
    await createPresentation(server, room, SAMPLE_PDF, { overlayCorner: 'BL', overlaySize: 'medium' })
    // Allow a couple of frames to flow.
    await new Promise((r) => setTimeout(r, 1000))
    const sample = await sampleTrack(room.id, 'presentation')
    // BL: bottom-left corner should contain a non-slide-coloured circle.
    expect(sample.regionVariance({ x: 50, y: sample.height - 250, w: 200, h: 200 })).toBeGreaterThan(100)
    await cam.stop()
  })

  it('B → A: muting the camera returns to heartbeat', async () => {
    const cam = await publishCamera(room.presenterToken)
    await createPresentation(server, room, SAMPLE_PDF, { overlayCorner: 'TL', overlaySize: 'small' })
    await new Promise((r) => setTimeout(r, 500))
    await cam.mute()
    await new Promise((r) => setTimeout(r, 1500))
    const sample = await sampleTrack(room.id, 'presentation')
    // TL: top-left should be back to slide background.
    expect(sample.regionVariance({ x: 50, y: 50, w: 200, h: 200 })).toBeLessThan(10)
    await cam.stop()
  })

  it('C: video plays without camera (regression, existing 2-input ffmpeg path)', async () => {
    const info = await createPresentation(server, room, SAMPLE_PDF)
    // Trigger embedded-video playback via the data channel; helper not shown here.
    await server.triggerVideoPlayback(info.id, 0)
    await new Promise((r) => setTimeout(r, 2000))
    // Smoke check: no compositor crash, track still flowing.
    const sample = await sampleTrack(room.id, 'presentation')
    expect(sample).toBeTruthy()
  })

  it('D: video + camera (3-input ffmpeg path)', async () => {
    const cam = await publishCamera(room.presenterToken)
    const info = await createPresentation(server, room, SAMPLE_PDF, { overlayCorner: 'BR', overlaySize: 'large' })
    await server.triggerVideoPlayback(info.id, 0)
    await new Promise((r) => setTimeout(r, 2000))
    const sample = await sampleTrack(room.id, 'presentation')
    // BR: large overlay (~25% of width). Expect non-trivial variance in BR corner.
    expect(
      sample.regionVariance({ x: sample.width - 400, y: sample.height - 400, w: 300, h: 300 })
    ).toBeGreaterThan(100)
    await cam.stop()
  })
})
```

> The helper APIs (`sampleTrack`, `publishCamera`, `triggerVideoPlayback`) may not exist yet. The phase executor must either reuse equivalent helpers from the existing integration suite or stub them with the minimal capability the test needs. If the existing suite has no track-sampling helper, drop the per-region assertions and assert only that the track emits frames at the expected rate — coarser but still load-bearing.

### 3. Document manual verification

Add a section to `docs/architecture.md` (the file the prior exploration identified at `docs/architecture.md:287` — confirm path) under a new heading **"Loom-style camera overlay"** with the four manual checks from Phase 4 and Phase 5's verification sections. Keep this short — pointers, not duplication.

If `docs/architecture.md` doesn't have a natural section for this, create `docs/loom-overlay.md` instead and link to it from architecture.md. Pick whichever option keeps `architecture.md`'s top-level shape consistent.

## Edge cases (deliberately uncovered by automation)

| Scenario | Why not automated |
|----------|-------------------|
| Camera resolution changes mid-video | Hard to simulate deterministically with the LiveKit Node SDK. Cover manually if a real device is available. |
| Two presenters racing to enable cameras | Requires a multi-presenter fixture; Phase 2's first-wins rule is unit-testable on its own — split if needed. |
| Network jitter causing camera back-pressure | Captured in Phase 5's manual stress test. |

## Verification

```bash
yarn test
yarn test:integration
yarn build
```

Plus a final manual end-to-end run against a real LiveKit deployment if available:

1. Connect a real presenter from a `cast2` browser client.
2. Confirm the circle appears within ~1 s of the presenter enabling their camera.
3. Navigate slides — circle should remain stable.
4. Play an embedded video — circle should remain stable, video should not stutter for more than ~500 ms during the ffmpeg restart.
5. Mute camera — circle should disappear within ~1 s; video should not pause.

## Learnings (post-execution)

After running this phase, append to `learnings/phase-6.md` (create it if it doesn't yet exist) with anything non-obvious: existing utilities you reused, pitfalls hit, retries needed, or assumptions in this phase that turned out wrong. Skip "everything went fine" — only log what would help a future executor. Do **not** edit other phases' learning files.
