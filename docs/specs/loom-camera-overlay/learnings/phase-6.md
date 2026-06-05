# Phase 6 learnings

## 2026-05-21 — partial

- No LiveKit test fixture exists in `test/integration/`. The only existing integration spec is `test/integration/ping-controller.spec.ts`, which uses `@well-known-components/test-helpers` `createRunner` (see `test/components.ts`) to boot the HTTP service in-process — no room, no participants, no track sampler. Authoring a LiveKit fixture from scratch is out of scope for Phase 6; landed `test/integration/loom-overlay.spec.ts` as `describe.skip` documenting the helpers that need to exist (`startTestRoom`, `publishCamera`, `sampleTrack`, `triggerVideoPlayback`).
- There is **no `yarn test:integration` script** in `package.json`. The single `yarn test` invocation already covers `test/integration/**` via Jest's `testMatch: **/*.spec.ts`. So step 2's `yarn test:integration` is a no-op here.
- `buildFilterComplex` was already exported at the top level of `src/adapters/video-compositor/component.ts:65` — the spec's import path `../../src/adapters/video-compositor/component` worked verbatim, no test-side compensation needed.
- Jest emits `CustomGC` async-handles output on teardown because of `--detectOpenHandles` interacting with `@livekit/rtc-node` + `@napi-rs/canvas` native modules. They are warnings, not failures — `Test Suites: 12 passed, 1 skipped`. Pre-existing; not introduced by this phase.
- Inserted the manual-verification section into `docs/architecture.md` between "Session lifecycle" and "Data channel protocol" rather than creating a separate `docs/loom-overlay.md` — the section is short (~25 lines) and fits the existing top-level shape.
