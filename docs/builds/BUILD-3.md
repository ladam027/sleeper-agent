# Build 3: Team + safety (v3.0.0)

**Shipped**
- **Team** (seeded, renameable): Riley (researcher, Sonnet 5 + web, no client tools), Cleo (critic, Opus 5.5 + web, recall only), Sam (security, Haiku 4.5: notify_owner + trip_kill_switch).
- **Web tools**: Anthropic-hosted `web_search` / `web_fetch` for agents with `web = 1` (`_20260209` variants; basic variants on Haiku), `max_uses: 5` per request. Searches are logged and charged at $0.01 each in the cost ledger.
- **Untrusted-content taint** (code-enforced): a run that uses web tools, or receives a delegate result from one, is tainted. Delegate results are wrapped in `<untrusted_content>`. In a tainted run, anything outside `TAINT_SAFE` (recall, list_*, delegate, escalate, notify_owner, trip_kill_switch) is queued as an approval with a reason, and `notify_owner` critical is downgraded to high (no phone calls from web-influenced tasks). Taint propagates into delegated runs and back.
- **Per-agent permissions**: the `agents.tools` allowlist applies at every depth (delegated runs are additionally capped at the sub-agent set). `hidden` tools (trip_kill_switch, apply_memory_cleanup) never come with "all tools". `create_agent` takes `tools` (from a worker whitelist) and `web`. Dashboard: tool checkboxes + web toggle per agent.
- **Security audit** (`src/jobs.js`): hourly, only if non-routine activity happened since the last audit (free when idle). Ephemeral run with a redacted activity digest marked as data; Sam notifies or trips the kill switch.
- **Memory cleanup**: nightly 03:30 when 12+ memories changed. One Batch API request on Haiku (50% off, recorded with batch pricing), result validated against the table (never pinned or nonexistent ids), turned into an `apply_memory_cleanup` approval. Applying merges moves links and is transactional.
- Auto routing sends latest/news/price/search/critique requests to James (Pete can't delegate).
- Schema v8. 42 tests (8 new).

**Known gaps / ceilings**
- Taint is per run: a tainted fact the owner approves into memory becomes trusted from then on (that's the point of the approval).
- The security audit sees the last 200 activity rows per hour; heavier use would need summarizing.
- Web search cost assumes $10/1k; web fetch has no per-use fee.
