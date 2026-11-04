# Build 9: Autonomy + visibility

## 9.0.0: scheduled tasks + memory index
- **Scheduled and watching tasks** (src/tasks.js): `schedule_task` / `list_tasks` / `cancel_task` (James; deferred tools, found by search). repeat: once, hourly, every-3-hours, daily, weekdays, weekly (wall-clock times across DST, missed runs skipped). Each run is a fresh ephemeral run with the instructions and the last report; replying "NOTHING NEW" keeps it quiet unless notify=always; real reports go to the owner (Telegram/dashboard by presence) and into the chat as "[Scheduled: …]". Limits in code: 12 active tasks, no more often than hourly, per-run budget ≤ $1 (default $0.15) enforced in runAgent (`opts.maxUsd`). Overview card with pause/resume/cancel. Monitoring words (watch, track, every morning, daily…) route to James.
- **Memory index:** the newest 40 non-pinned memory titles go to agents that have recall, as a system block *after* the cache marker (new memories arrive all day and would otherwise force a cached-prefix rewrite, ~$0.03 each). ~400 tokens uncached (~$0.0016 per James message) vs a recall step (~$0.01) whenever the agent didn't know what it had.
- Schema v24. 123 tests.

## Next
- Saved playbooks (step-by-step guides for repeat jobs, owner-written or approved; saved from runs that worked).
- Voice on the dashboard (push-to-talk + spoken replies, sentence by sentence; free, browser built-ins).
- Result cards (sanitized tables/charts in chat).

## 9.0.1: false kill-switch alarm fixed
- 2026-11-04: Sam tripped the kill switch claiming the archivist "executed browser_submit to my.dmv.ca.gov". False: all 8 DMV submits were James's and owner-approved (#12–#19); the archivist can only remember/recall/link_memory (it used recall 21×, remember 10×). Sam had read the archivist's summary sentence ("The browser_submit worked") as an action.
- The audit log now separates **Actions** (with #ids) from **Messages** (requests and summaries, marked "NOT evidence"). `trip_kill_switch` requires evidence checked in code: cited #ids that are real actions by an agent, or kind=spending with today's spend ≥ 80% of the cap; otherwise it refuses and Sam can notify the owner instead.
- Also seen: Telnyx returned 403 "Account is disabled (D17)" for the alert call: an account issue on Telnyx's side.

## 9.1.0: autopilot controlled from the Markets page
- Trading limits were already page settings read on every order. Now the autopilot is too: Markets → **Autopilot** card (run time, minimum edge in points, budget per run, pause/resume, next run, last report). The edge is a setting (`paper_auto_edge`, 1–50, default 10) returned by `paper_account`, so the task's instructions reference it instead of a fixed number; time/budget/status edit the task (`tasks.update`). Setting `paper_auto_task` links the card to the task. 124 tests.

## 9.2.0: flexibility (model per task)
- Per-agent **Flexibility** (agent card): the agent's model is its ceiling and `flex_min` a cheaper floor. `pickModel()` (free, no model call) uses the floor for routine requests and the ceiling for plans, strategy, analysis, code, legal/money decisions, comparisons, "think hard"/"use opus", or requests over 1,500 chars. On the floor the agent also gets `use_stronger_model` (always loaded, taint-safe): called before acting, it ends the run and the request re-runs on the ceiling. James on by default: Sonnet 5 for routine work, Opus 5.5 when needed (about half the price on routine messages). Follow-up routing now recognises James answering on either model. 125 tests.
