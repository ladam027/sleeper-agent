# Build 8: Performance + token efficiency

Plan (docs/PLAN.md): measure first, then cut. Each change is measured before/after (count_tokens via `promptFor`, the Runs view, Statistics); nothing ships if answer quality drops.

## 8.0.0: Runs view (the measuring tool)
- `runs` table: one row per runAgent call (request, agent, parent run, depth, steps, tokens in/cached/out, cost incl. texts/images, time, status, result). Sub-agent runs link to their parent.
- `runCtx` (node:async_hooks AsyncLocalStorage, no dependency) carries the current run id, so `log()`, `record()`/`recordUsd()` and approvals tag their rows with `run_id` automatically, including parallel tool calls and delegation.
- `/api/runs` (latest 40 top-level tasks with totals over the whole run tree and "waiting on you" from pending approvals) and `/api/runs/<id>` (timeline + per-call tokens). Statistics tab: **Recent tasks** table, click a row for its timeline.
- Schema v22. 116 tests.
