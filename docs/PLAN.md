# Sleeper Agent: Master Plan

Last updated: 2026-11-02. Every build starts by re-reading this file and `CLAUDE.md`.

## 1. Verdict

About 85% of the wish list can be built with today's APIs. The rest needs changes:

| Feature | Status | Why / workaround |
|---|---|---|
| Set alarms on iPhone | **Not directly possible** | iOS has no alarm API for third-party apps. Instead: (a) agent **calls** you (works as an alarm), (b) Google Calendar events with alerts, (c) an Apple Shortcuts automation fired via a push app (Pushcut/ntfy). On Android, Tasker can set real alarms. |
| Prompt injection "hard-coded" out by a security agent | **Partially** | An LLM watching another LLM can be injected too. Real protection is structural and already in Build 1: tools gated in code, least-privilege tools per agent, no secrets in context, human approval for side effects. The security agent *audits*. It is not the wall. |
| Create accounts / self-authenticate / CAPTCHAs | **Restricted** | Most sites ban automated sign-ups in their ToS, and bypassing CAPTCHAs is off-limits. Scope: the agent uses official APIs, its own email for its own accounts where bots are allowed, and a password manager for logins you start. You solve the CAPTCHAs. |
| Your cloned voice calling support / disputing charges | **Legal gray zone** | Allowed only if the AI says it is an AI assistant calling for you. Two-party-consent states require telling the other side the call is recorded. Many companies refuse to talk to agents. Card disputes work better in writing (issuer app or email), which leaves a paper trail. |
| Autonomous day trading | **Possible, but strongly discouraged** | LLMs are bad at fast numeric trading. Use the LLM for research and strategy, deterministic code for execution, and enforce hard limits in code. Schwab API approval takes days to weeks and **refresh tokens expire every 7 days**, so you re-authorize weekly by tapping a link. Check the current FINRA pattern-day-trader rules for your account type. |
| Storing passwords/cards so Claude never sees them | **Yes** | Vault (Bitwarden Secrets Manager / 1Password CLI / encrypted file). Tools get a *reference* like `{{secret:schwab_refresh}}` and the server swaps in the real value at execution time. The model only ever sees the reference. Use **virtual cards** (Privacy.com or your bank's) with per-merchant limits for anything the agent pays for. |

## 2. Architecture (lean on purpose)

```
Phone (SMS/call/Telegram) ─┐
Dashboard (browser/PWA) ───┼─> Node server (one process, 24/7 on a $5 VPS, private via Tailscale)
Webhooks (Twilio, Gmail) ──┘      │
                                  ├─ Agent loop  (budget check -> Claude -> tools -> approval gate)
                                  ├─ SQLite      (memory graph, chat, activity, costs, approvals)
                                  ├─ Scheduler   (reminders, digests, nightly memory cleanup)
                                  └─ Vault       (secrets, injected at tool execution, never in prompts)
```

- **One process, one SQLite file.** No Kubernetes, no vector DB, no message queue until something measurably needs it.
- **Sub-agents are rows in a table**, each with its own model, budget, purpose, and tool allowlist. Delegation is a tool call.
- **Models at runtime:** orchestrator = `claude-opus-5-5` at `medium` effort; workers = `claude-sonnet-5` or `claude-haiku-4-5` (digests, triage, memory cleanup). Escalate to `claude-fable-5-1` only for rare, hard, high-value reasoning.
- **Cost control in code:** per-agent daily cap, global daily cap, 8-step loop limit, delegation depth 2, kill switch, prompt caching on a stable system prompt.

## 3. Foundation: do these before / alongside Build 1

**Accounts (you, ~1 hour):**
1. Anthropic Console: API key, a **monthly spend limit** in Console billing (backstop to our caps), and a usage alert.
2. GitHub (done, repo created).
3. Tailscale (free): install on the server, laptop, and phone. Dashboard is reachable only on your tailnet.
4. Hetzner / DigitalOcean VPS (~$5–7/mo), Ubuntu, Node 24+. Or a Mac mini that never sleeps.
5. Twilio: buy a number, then start **A2P 10DLC sole-proprietor registration NOW**. US carriers block unregistered app SMS and approval takes 1–3 weeks. Calls work right away.
6. A dedicated Google account for the agent (its own inbox), plus OAuth for read access to your Gmail.
7. Password manager with CLI/secrets support (Bitwarden or 1Password).

**Knowledge to seed (you, 30 min, via chat):** who you are, home timezone, current projects and income streams, money goals, risk tolerance, quiet hours, who you talk to. Pin the 5–10 most important facts.

**Core sub-agents (Build 3):** `security` (audits activity and tool calls, flags injections), `critic` (finds holes and legal issues in ideas), `researcher` (web search + summaries), `ops` (reminders, digests, memory cleanup).

## 4. The 7 builds

Each build is usable alone and ends with passing tests plus a short demo.

### Build 1: Core spine ✅
Agent loop, SQLite memory with links, cost ledger, per-agent/global budgets, step limit, kill switch (global and per agent), restart, approval queue gated in code, activity feed, time and timezone awareness (DST-correct), dashboard (chat, approvals, agents, activity, memory graph you can click and edit, cost chart, settings), token auth, tests.

### Build 2: Reach me (phone + deploy) ✅ (code done; Twilio/Tailscale setup is manual, see docs/builds/BUILD-2.md)
- Deploy to the VPS with systemd, Tailscale, nightly SQLite backup (`sqlite3 .backup` to a cloud bucket).
- Twilio SMS in/out (webhook signature validation, only accept your number), `notify_owner` high → SMS, critical → call.
- **Approve/deny by SMS reply** ("Y 12") for low-value approvals. High-value ones still need the dashboard or a PIN, because caller ID can be spoofed.
- Reminders and scheduler (cron-style table), "alarm" = phone call, Google Calendar events.
- Timezone from your phone (Shortcuts posts location → `set_timezone`).
- Optional free channel: a Telegram bot for chat, keeping Twilio for urgent messages only.

### Build 3: Team + safety ✅
- Sub-agent framework: per-agent tool allowlists stored in the DB, `create_agent` (already approval-gated).
- Untrusted-content wrapper: anything from email or the web gets tagged as data, and agents that read untrusted content can't call side-effect tools in the same run.
- `security` agent: reviews the activity log every hour on Haiku, flags anomalies, can trip the kill switch.
- `critic` agent: red-teams ideas (legal, market, cost, failure modes) and proposes fixes.
- `researcher`: Claude web search/fetch tools with `max_uses` caps.
- Nightly memory consolidation (dedupe, merge, prune) on Haiku via the Batch API (50% off).

### Build 4: Money cockpit (part 1 ✅, part 2 needs Google/GitHub accounts)
- Projects table with progress bars, revenue/expense entries, **real-time cost vs ROI** per project (API spend is already tagged per agent).
- Client outreach CRM (contacts, stage, last touch, next action) and cold-email drafts (you approve before sending).
- Gmail: daily digest from your inbox (read-only), outreach from the agent's own inbox.
- GitHub: create/publish repos via `gh` or the GitHub MCP (publishing needs approval).

### Build 5: Marketing studio (part 1 ✅ websites + content calendar; part 2 ✅ images; later: video, analytics, domains)
- Social posting through Ayrshare or Posty (one API for many networks, avoids X's expensive API), approval required per post at first.
- Image generation, short video (Adobe Express/Firefly tools already connected, or Veo/Kling APIs), simple website generation and deploy (static site on Cloudflare Pages/Vercel).
- Content calendar and post analytics feeding back into memory.

### Build 6: Markets (human-in-the-loop) (part 1 ✅ paper trading)
- Kalshi API and Schwab Trader API: **read-only first** (positions, P&L in the dashboard).
- Simulation lab: Claude code execution / Python for Monte Carlo, backtests, regression fits. Results are saved as memory with assumptions.
- Paper trading for at least 30 days, then live with: max $ per order, max daily loss, max open positions, all enforced in code. **Every order is an approval sent to you by text or call.** Logged and never automatic until you change that yourself.
- Weekly Schwab re-auth reminder (7-day refresh token).

### Build 7: Voice + browser hands (part 1 ✅ capabilities, part 2 ✅ browser hands; voice next)
- Voice agent (Vapi/Retell + ElevenLabs clone of your voice) for scheduling and support calls. It discloses that it's an AI, records only with consent, and gives you a transcript plus outcome afterwards.
- Browser automation (Playwright) for form filling using vault references. Pauses for CAPTCHAs and 2FA, and you finish those.
- Self-knowledge: auto-generated `/capabilities` page from the tool and agent registry, which the agent reads.

### Build 8: Performance + token efficiency (measure first, then cut)
Ideas from OpenJarvis (traces, cost as a first-class metric), HuggingGPT/EasyTool (concise tool instructions), ethanplusai/jarvis (runs dashboard, sentence streaming). Every change is measured before/after with `promptFor` + count_tokens and the Statistics page; no change ships if answer quality drops.
- **Runs view:** one timeline per task (each model call and tool step, tokens, cost, time, and "waiting on you: approval / code / CAPTCHA"). This is the measuring tool for everything below.
- **Shorter tool descriptions:** James's ~4.5k tokens of tool definitions rewritten tight (EasyTool showed concise instructions also improve tool choice). Target −20–30% of his fixed prompt.
- **Browser snapshot diffs:** after the first snapshot, send only what changed plus the controls near the last action (the DMV task used 38 calls / $0.49, mostly re-sent pages).
- **Riley's web reading:** tune per-page and per-search caps against a few saved research questions (Riley is the most expensive agent per task).
- **Batch API for background jobs:** archivist compression, memory cleanup and the security audit run at 50% off where minutes of delay don't matter.
- **Routing test set:** turn logged routing decisions into a replayable check run before every deploy (fewer Pete→James bounces, each a wasted call).
- **Streaming replies on the dashboard:** words appear as they're written instead of after the whole reply (latency, not tokens).

### Build 9: Autonomy + visibility
Ideas from OpenJarvis (scheduled and continuous agents, skills), thevickypedia/Jarvis (schedulers), adewaskar and ethanplusai (voice loop, memory index, agent-drawn panels).
- **Scheduled and monitoring tasks:** "every morning do X", "watch this market/listing/price and text me when Y". Real cron-style runs with a per-run budget, results saved to memory and sent to the owner. (Replaces the false "I'll monitor daily" promises.)
- **Memory index:** titles of all memories in the cached prompt so James knows what he knows; details still come from recall.
- **Skills / playbooks:** step-by-step guides for repeat jobs (DMV vehicle add, local-business pitch, Kalshi weather check) loaded only when needed; a guide can be saved from a run that worked. Owner-written or vetted only, never bulk community imports.
- **Voice on the dashboard:** push-to-talk with Chrome's built-in speech recognition and spoken replies sentence by sentence, no new services or cost.
- **Result cards:** James can post sanitized tables/charts in chat.
- Phone voice (Telnyx + ElevenLabs clone, Build 7 part 3) uses the same lessons: sentence-chunked speech, barge-in, permissions decided before the call (read-only on calls, anything risky goes to approvals).

## 5. Cost estimate (monthly, USD, verify vendor prices before buying)

| Item | Lean | Typical | Notes |
|---|---|---|---|
| Claude API | $20 | $60–150 | Opus 5.5 $4/$20 per MTok (cache reads $0.20); Sonnet 5 $2/$10; Haiku 4.5 $1/$5. A cached orchestrator turn costs ~$0.01–0.04. Batch API halves the price of background jobs. |
| VPS | $5 | $7 | Hetzner/DO small instance |
| Twilio | $3 | $10–20 | Number ~$1.15/mo, SMS ~$0.008 + carrier fees, calls ~$0.014/min, 10DLC registration ~$20 one-time + ~$2–10/mo |
| Voice (ElevenLabs + Vapi/Retell) | $0 | $25–60 | ElevenLabs paid tier for voice cloning; voice agent platforms ~$0.05–0.15/min |
| Web search | $1 | $5–10 | Claude web search ~$10 per 1,000 searches |
| Images/video | $0 | $10–50 | Video generation is the expensive item; cap it per day |
| Social API | $0 | $0–30 | Ayrshare/Posty tiers; X's own API is costly |
| Kalshi, Schwab, Gmail, Calendar, GitHub, Tailscale | $0 | $0 | Free APIs/tiers |
| Domain | $1 | $1 | ~$12/yr |
| **Total** | **~$30** | **~$130–330** | Set the Console spend limit to your ceiling |

Biggest cost risks: agent loops (capped), long chat histories (capped at 20 messages), video generation, and accidentally running Fable for routine work.

## 6. Risks and how we handle them
1. **Scope creep.** 30 features is a year of nights. Fix: the 7 builds, each usable alone.
2. **Prompt injection via email/web.** Fix: structural gates (Build 1), untrusted tagging plus split privileges (Build 3).
3. **Runaway spend.** Fix: code-level caps, Console limit, kill switch.
4. **Account bans** from automating consumer sites. Fix: official APIs first, browser automation last and narrow.
5. **Trading losses.** Fix: paper first, hard limits in code, human approves every order.
6. **Dashboard exposure** (it controls money). Fix: bind to localhost and use Tailscale, token auth, never a public port.
7. **Memory rot** (duplicates, stale facts). Fix: nightly consolidation, editable graph.
8. **Data privacy.** Email and chat content goes to the Anthropic API (not used for training by default on the API). Secrets never do.
9. **Single point of failure.** Fix: nightly backups, a systemd auto-restart, and a health ping that texts you if the server is down.

## 7. What was missing from the original list
- Remote access security (Tailscale) and dashboard auth
- Backups and disaster recovery, plus an uptime/health check
- Calendar integration (Google Calendar)
- Quiet hours and notification priority tiers
- Virtual cards for agent purchases
- Spend limit at the Anthropic Console level
- Taxes/bookkeeping for trading and side income, and a business entity (LLC) if revenue grows
- Website legal pages (privacy policy, terms) and FTC disclosure for affiliate/AI content
- Evals: a small set of test conversations to catch regressions when prompts change
- An audit trail you can export (already have the activity table)
