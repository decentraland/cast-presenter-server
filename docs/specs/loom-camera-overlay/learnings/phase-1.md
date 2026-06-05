# Phase 1 learnings

## 2026-05-21 — done

- `InternalSession extends PresentationSession` in `src/logic/presentation-manager/component.ts:30` — the optional `overlayConfig` added to `PresentationSession` automatically flows through; no separate field addition on `InternalSession` was needed (spec step 3's parenthetical correctly anticipated this).
- ESLint enforces `import/order` here: type imports must be sorted by relative-path depth. `../../logic/presentation-manager/types` has to come **before** `../../types` even though the spec example's snippet shows the new import last. Watch for this when adding any new import in `src/controllers/handlers/`.
- The component-side import line for `./types` is multi-named, so adding `OverlayConfig` required reformatting the single-line import into a multi-line one — no separate import statement.
- Skipped curl smoke test: dev server is not running in this worktree; the JSON parse path is fully covered by the typecheck + lint pass plus the existing 210 unit tests.
