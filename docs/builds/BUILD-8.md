# Build 8: Performance + token efficiency

Plan (docs/PLAN.md): measure first, then cut. Each change is measured before/after (count_tokens via `promptFor`, the Runs view, Statistics); nothing ships if answer quality drops.

## 8.0.0: Runs view (the measuring tool)
- `runs` table: one row per runAgent call (request, agent, parent run, depth, steps, tokens in/cached/out, cost incl. texts/images, time, status, result). Sub-agent runs link to their parent.
- `runCtx` (node:async_hooks AsyncLocalStorage, no dependency) carries the current run id, so `log()`, `record()`/`recordUsd()` and approvals tag their rows with `run_id` automatically, including parallel tool calls and delegation.
- `/api/runs` (latest 40 top-level tasks with totals over the whole run tree and "waiting on you" from pending approvals) and `/api/runs/<id>` (timeline + per-call tokens). Statistics tab: **Recent tasks** table, click a row for its timeline.
- Schema v22. 116 tests.

## 8.1.0: James's fixed prompt
- Measured James's prefix (count_tokens): 6,984 tokens = code-execution tool 2,571 + instructions 2,475 + 7 core tools and tool search 1,833. Deferring the code-execution tool is accepted by the API but doesn't shrink the prompt, so:
- **Theo, the analyst** (new agent, Sonnet 5, code execution, recall/kalshi_backtest_data/weather_history/paper_account): exact math and data work. James delegates it; James no longer carries code execution.
- **Instructions trimmed** 6,495 → 3,733 chars: one line per delegable agent (no background agents; Mia's full design brief was being sent to James every request) and overlapping security rules merged without dropping any rule.
- Core tool descriptions were already tight (~750 tokens); left as is.
- Schema v23. 116 tests.
