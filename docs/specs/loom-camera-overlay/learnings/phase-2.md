# Phase 2 learnings

## 2026-05-21 — done

- `@livekit/rtc-node` exports `RemoteTrack` as a **type-only** alias (see `node_modules/@livekit/rtc-node/dist/track.d.ts`). It must be imported with `import type` — listing it among value imports compiles but is misleading. Spec step 2 instructed a value-style import; deviated to `import type { RemoteTrack }`.
- `RoomEvent.TrackMuted` / `TrackUnmuted` callbacks emit the **base** `TrackPublication`/`Participant` types, not `RemoteTrackPublication`/`RemoteParticipant`. Annotating the parameters as remote types triggers `TS2345`. Solution: omit explicit annotations on those two handlers (let TS infer base types) and narrow at runtime with `instanceof RemoteTrackPublication` / `instanceof RemoteParticipant` before using remote-only members like `.source` and `.track`.
- Adding a new method to `ILiveKitPublisher` broke `test/unit/presentation-manager.spec.ts:11` (`createMockPublisher`) — `jest.Mocked<ILiveKitPublisher>` requires every interface member. Updated the mock to add `setPresenterCameraTrackHandler: jest.fn()`. Any future interface additions need the same fix in that file.
- Subscription-replay smoke test not executed (no live LiveKit room available in this worktree). Added the explicit `publication.setSubscribed(true)` fallback documented in the phase spec at the end of `connect()` — safe under both auto- and explicit-subscribe configurations.
- ESLint `import/order` is finicky for type-only imports; on this code path the rule was satisfied by putting `@well-known-components/interfaces` and the `./types` type imports before `@livekit/rtc-node`'s type-only import. Phase 1's learning about relative-depth ordering still applies.
