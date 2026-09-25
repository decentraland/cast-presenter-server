# Learnings: loom-overlay-runtime

Each phase executor writes exactly one file here, `phase-N.json`: a JSON object or an array of objects in the plan-plus learning schema v2 (`docs/learning-schema.md` in the plan-plus plugin) with `scope: "project"`.

- Write only your own phase's file. Never edit another phase's file, the canonical project JSONL, or any index database.
- Required fields: `schema_version` (2), `scope`, `kind`, `title`, `observation`, `conclusion`, `confidence`, `status` (`candidate`).
- Record things the next agent could not get from the diff: API breaks, surprising behaviour, skipped verification with its reason, and rejected alternatives (`kind: decision` with `rejected` and `rationale`).
- The coordinator ingests these after integration. Ingested records stay `candidate` until a human promotes them.
