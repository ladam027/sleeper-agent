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

## 8.2.0: the rest of Build 8
- **Browser updates instead of whole pages:** control numbers are now stable for as long as a control stays on the page (verified in Chrome: a new button gets a new number, existing ones keep theirs), so after the first look the agent gets only new/changed controls and new text, plus a count of unchanged ones. Full listing on a new address, a CAPTCHA, after the owner used the page, or `snapshot full=true`.
- **Riley:** per-page reading cap 6,000 → 3,500 tokens (~2,600 words). Measured first: his biggest cost was ~26k tokens of new web content written to cache per call ($0.066 of $0.14); re-reads are cheap thanks to caching.
- **Batch API for background jobs: skipped** after measuring. Archivist + Sam cost ~$0.08/day, so batching saves ~$1.20/month for added delay and polling code.
- **Routing test set:** `pickRoute()` (the decision alone, no model calls) and test/routing.test.js with 24 cases from the logs (paraphrased): quick answers, heavy work, website requests, DMV/vault/browser, and follow-ups. All correct; runs before every deploy.
- **Streaming replies:** `/api/chat-stream` sends newline-delimited JSON pieces as James writes; the dashboard shows the reply growing and falls back to the plain endpoint. Pete's held replies aren't streamed (they may be handed to James).
- 119 tests.

## Results
- James's fixed prompt: 11,747 tokens at the start of this work → 3,631 (−69%): tool search (−4.7k), code execution moved to Theo (−2.6k), trimmed instructions (−0.7k).
- Measure the rest (browser updates, Riley's cap) on real tasks in Statistics → Recent tasks.
