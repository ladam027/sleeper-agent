# Build 1: Core spine

**Shipped**
- `src/agent.js`: agent loop (Claude API manual loop), approval gate, kill/restart with in-flight abort, delegation (depth ≤ 2), sub-agent least-privilege tool set, refusal handling, prompt caching, time line injected into each user turn.
- `src/budget.js`: price table, per-call cost ledger, per-agent and global daily caps (owner-timezone days), 8-step loop limit, spend summary.
- `src/tools.js`: remember, recall, link_memory, set_timezone, notify_owner (dashboard only for now), delegate, create_agent (approval-gated).
- `src/db.js`: SQLite schema (settings, agents, chat, activity, costs, approvals, memory, links).
- `src/server.js`: token-auth JSON API, binds 127.0.0.1.
- `public/index.html`: chat per agent, approvals, agents with kill/restart, activity feed, clickable/editable memory graph, cost chart, settings, global kill switch.
- `test/core.test.js`: 8 tests covering cost math, history, memory, approval gate, budget cap, kill switch, step limit, sub-agent privilege.

**Deliberately skipped (with ceiling)**
- Memory search is LIKE-based. Move to FTS5/embeddings past a few thousand memories.
- Chat history replays text only (last 20 messages), not tool internals.
- Budget check happens before each call, so overshoot is at most one call (≤ ~$0.35 on Opus 5.5).
- Dashboard polls every 4s instead of streaming.
- No refusal fallback model yet.

**How to run**
```
cp .env.example .env   # add ANTHROPIC_API_KEY and DASHBOARD_TOKEN (openssl rand -hex 24)
npm install
npm test
npm start              # http://127.0.0.1:8787
```

**Updates**
- 1.1: Inline token login (the in-app browser blocks `prompt()`).
- 1.2: Dashboard redesign (sidebar, live agent hero, KPI cards, agent and approval cards, chat rail, dark mode). See docs/DESIGN.md.
- 1.3: Encrypted vault (AES-256-GCM, `VAULT_KEY`) for passwords, cards and personal info, with a Vault page. `redact()` strips vault values, card numbers and SSNs from everything sent to the API (messages, history, system prompt, tool results). The agent gets `list_secrets` (names only). Versioned append-only migrations, backups on startup and before migrations (newest 10), refuses to open a newer-schema DB. Version/build info in Settings. 14 tests.
