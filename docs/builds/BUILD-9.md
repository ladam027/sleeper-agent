# Build 9: Autonomy + visibility

## 9.0.0: scheduled tasks + memory index
- **Scheduled and watching tasks** (src/tasks.js): `schedule_task` / `list_tasks` / `cancel_task` (James; deferred tools, found by search). repeat: once, hourly, every-3-hours, daily, weekdays, weekly (wall-clock times across DST, missed runs skipped). Each run is a fresh ephemeral run with the instructions and the last report; replying "NOTHING NEW" keeps it quiet unless notify=always; real reports go to the owner (Telegram/dashboard by presence) and into the chat as "[Scheduled: …]". Limits in code: 12 active tasks, no more often than hourly, per-run budget ≤ $1 (default $0.15) enforced in runAgent (`opts.maxUsd`). Overview card with pause/resume/cancel. Monitoring words (watch, track, every morning, daily…) route to James.
- **Memory index:** the newest 40 non-pinned memory titles go to agents that have recall, as a system block *after* the cache marker (new memories arrive all day and would otherwise force a cached-prefix rewrite, ~$0.03 each). ~400 tokens uncached (~$0.0016 per James message) vs a recall step (~$0.01) whenever the agent didn't know what it had.
- Schema v24. 123 tests.

## Next
- Saved playbooks (step-by-step guides for repeat jobs, owner-written or approved; saved from runs that worked).
- Voice on the dashboard (push-to-talk + spoken replies, sentence by sentence; free, browser built-ins).
- Result cards (sanitized tables/charts in chat).
