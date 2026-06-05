/**
 * Loom-style overlay integration tests — exercises the 2x2 mode matrix:
 *
 *               | Camera off            | Camera on
 *   Video off   | A heartbeat slide      | B canvas pump
 *   Video on    | C 2-input ffmpeg       | D 3-input ffmpeg
 *
 * STATUS: SKIPPED until a LiveKit test fixture is available.
 *
 * The current `test/integration/` scaffolding (see `test/components.ts`) only
 * boots the HTTP service via `@well-known-components/test-helpers` — it does
 * NOT spin up a LiveKit room, publish a synthetic camera track, or expose a
 * track-sampling helper. Authoring those helpers is out of Phase 6's scope
 * because they depend on infrastructure (a real or embedded LiveKit server)
 * that isn't provisioned in CI.
 *
 * Manual verification covering this matrix lives in `docs/architecture.md`
 * under "Loom-style camera overlay". The pure-logic portion of the new
 * ffmpeg pipeline (filter-graph string) is locked down by
 * `test/unit/build-filter-complex.spec.ts`.
 *
 * To re-enable this suite, build the following helpers under
 * `test/helpers/livekit.ts` and flip the `describe.skip` to `describe`:
 *   - `startTestServer()`              — boots the HTTP service.
 *   - `startTestRoom()`                — starts a LiveKit room, returns
 *                                        `{ id, url, presenterToken, serverToken, stop }`.
 *   - `publishCamera(token)`           — publishes a synthetic camera track.
 *   - `createPresentation(server, room, file, overlay?)` — POSTs to
 *                                        `/presentations` with the right
 *                                        overlayCorner/overlaySize fields.
 *   - `sampleTrack(roomId, trackName)` — decodes one frame off the server's
 *                                        publication and returns a sample
 *                                        with `regionMeanAlpha` and
 *                                        `regionVariance` accessors.
 *   - `server.triggerVideoPlayback(id, slideIndex)` — sends the play-video
 *                                        data-channel message.
 */
describe.skip('Loom overlay: 2x2 mode matrix (needs LiveKit fixture)', () => {
  it('A: slide-only with no camera (heartbeat regression)', async () => {
    // Drop-in once helpers exist; see file header.
  })

  it('B: slide + camera (canvas pump)', async () => {
    // Expect a non-slide-coloured circle in the BL corner.
  })

  it('B -> A: muting the camera returns to heartbeat', async () => {
    // After mute, the corner region should be flat slide background again.
  })

  it('C: video plays without camera (2-input ffmpeg regression)', async () => {
    // Smoke check: compositor does not crash and track keeps flowing.
  })

  it('D: video + camera (3-input ffmpeg path)', async () => {
    // Expect non-trivial variance in the BR corner (large overlay).
  })
})
