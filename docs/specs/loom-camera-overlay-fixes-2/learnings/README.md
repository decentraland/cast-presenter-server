# Execution learnings — loom-camera-overlay-fixes-2

Per-phase append-only log of non-obvious facts discovered while executing this spec. Each agent reads **every file in this directory** before starting its phase, and appends to its own `phase-N.md` after finishing (pass, fail, or retry).

Why per-phase files: parallel phases must not collide on a shared file. Each agent writes only to `phase-N.md` for its own phase. Retries of the same phase append further dated sections to the same file (sequential, no race).

Keep entries terse — distilled facts, not transcripts. Skip "everything went fine"; only log what a future executor would benefit from. If an entry is more than ~5 bullets, it's probably too much.

## Format for each entry inside `phase-N.md`

```
## YYYY-MM-DD — <done | failed | retried>
- Concrete fact, pitfall, reuse target, or surprising constraint.
- One bullet per learning.
```
