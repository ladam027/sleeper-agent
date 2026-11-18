# Build 4: Money cockpit

## Part 1 (v4.0.0): no outside accounts needed
- `src/money.js`: projects (status, progress, goal, monthly target), ledger (+income/−expense), `moneySummary()` with per-project month/all-time income, expenses, AI spend of agents assigned to the project (`agents.project_id`), net and ROI; overall totals incl. AI and phone spend vs the monthly income goal (`monthly_income_goal`, default 1000). CRM contacts (stages lead→contacted→replied→meeting→client/lost, next step + date, last touch). Email drafts (never sent automatically).
- Agent tools: `project`, `list_projects`, `log_money`, `contact`, `list_contacts`, `draft_email`; `create_agent` takes `project`. Pete gets `list_projects`, `list_contacts`.
- Dashboard: **Money** tab (goal KPIs, project cards with progress/target/ROI, income vs spending chart, log form, ledger, plus the old Costs charts) and **Clients** tab (CRM with inline stage changes, overdue follow-ups in red, drafts with copy / mark sent / discard). Costs tab merged into Money. Mobile tab bar fits 7 items.
- Deploy tooling (Build 2 leftover): `npm run deploy` (`scripts/deploy.sh`): setup, move, update. See docs/DEPLOY.md.
- Schema v9. 47 tests (5 new).

## Part 2 (v4.1.0): Google
- `src/google.js`: OAuth web client, redirect `PUBLIC_DASHBOARD_URL/oauth/google` (the private Tailscale URL, so it works from any tailnet device) with single-use 10-minute state. Refresh tokens in settings (`google_james`, `google_owner`); access tokens in memory. Gmail list (metadata + snippet only), mark read, send (from James only; MIME with header-injection checks). Calendar list/add on the owner's primary calendar.
- Accounts: **james** = `gmail.modify` on James's own Gmail; **owner** (optional) = `gmail.readonly` + `calendar.events`.
- Tools: `send_email` (**high**: always approval), `read_email` and `calendar_events` (taint the run; results wrapped as untrusted), `calendar_add`.
- Jobs: James inbox watcher every 10 min (replies from CRM contacts move to "replied" + Telegram ping; marks read); morning briefing at `digest_time` (Pete, tainted, tool-less summary of today's calendar + owner inbox → Telegram).
- Dashboard: Settings → Google (status, redirect URI, connect/disconnect, briefing time); "Send from James" on drafts (the click is the approval). `npm run deploy -- --env` pushes .env; `--move` refuses to overwrite live server data.
- 53 tests (6 new).

### Owner setup (about 15 minutes)
1. **James's Gmail**: create a new Google account (e.g. james.sleeperagent@gmail.com). Use your phone number for verification; it's your account to control.
2. **Google Cloud project** (sign in as yourself at console.cloud.google.com): New project "Sleeper Agent".
3. **APIs & Services → Library**: enable **Gmail API** and **Google Calendar API**.
4. **OAuth consent screen** (Google Auth Platform): External, app name "Sleeper Agent", your email as support/developer contact. **Audience → Test users**: add your Gmail and James's Gmail. Then **Publish app** ("In production"): otherwise Google expires the sign-in every 7 days. It stays unverified (you'll click "Advanced → Go to Sleeper Agent" once), which is fine for personal use.
5. **Clients → Create client → Web application**. Authorized redirect URI: `PUBLIC_DASHBOARD_URL` + `/oauth/google` (e.g. `https://your-machine.your-tailnet.ts.net/oauth/google`). Copy the client ID and secret into `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`); Claude pushes it with `npm run deploy -- --env`.
6. Dashboard → Settings → Google → **Connect James's Gmail** (sign in as James) and optionally **Connect my Google**.

## Integrations (v4.2.0)
- `src/integrations.js`: vault-backed services. Credentials are saved from the Integrations page (needs a vault passphrase session), read from the vault inside the tool at call time, and never returned; tool results also pass through `redact()`. A locked vault gives a plain "ask the owner to unlock" error.
- **Canvas**: token + school address → `canvas_upcoming` (titles/courses/dates only, wrapped as untrusted, no descriptions) and `canvas_grades`. Pete has both.
- **Kalshi** (read-only): key ID + private key (RSA-PSS SHA-256 or Ed25519 signature over timestamp+method+path, no query) → `kalshi_portfolio`, `kalshi_markets`. Host `external-api.kalshi.com/trade-api/v2`.
- **Schwab**: stores app key/secret; OAuth + tools in Build 6.
- Dashboard: Integrations tab (built-in services + vault-backed cards with Connect / Test / View in vault). Mobile bar hides Guide (link in Settings). 59 tests.

## 4.3.0
- Reply style per agent: ultra concise (new, default for James and Pete: 3–4 sentences, no behind-the-scenes recaps), concise, full. `agents.concise` 0/1/2.
- Reminders store `delivered_at` + `result` (e.g. "messaged on Telegram"); `list_reminders` returns recently delivered ones, so agents can confirm delivery instead of guessing.
- Telegram replies have markdown stripped.

## 4.4.0
- Presence-aware alerts: the page reports `x-owner-active` (visible tab + input in the last 2 min). While the owner is at the desk, `notify` high skips Telegram (pop-up notice on the dashboard instead) and critical calls without the text. A Telegram message in the last 15 min means "on the phone" and wins. Owner-set reminders (`explicit`) always deliver as chosen. Dashboard pop-ups for new alerts and approvals.

## 4.5.0
- **Limit override**: when an agent or the overall daily cap stops a task, a `raise_budget` approval is filed (once per limit per day, none after a denial) with the original request. Approving adds today-only extra budget (`boost:<target>:<day>`: the overage plus one normal day) and resumes the task, delivering the result through `notify`. Manual "Raise limit" on agent cards and "Raise today's cap" in Settings.
- **Safe documents**: `read_document` (Riley, Cleo). Only PDF / CSV / .xlsx, decided by magic bytes. https + public-internet only (private, tailnet 100.64/10, metadata 169.254 refused, re-checked on each redirect), 10 MB download cap, 30 MB decompressed cap, macro workbooks refused, no files saved. PDFs go as a document block to a tool-less Haiku `reader` agent; spreadsheets become CSV text. Results are untrusted and taint the run.
- 68 tests.

## 4.6.0
- Vault nudge: 2 minutes after a restart, if the vault is still locked and integrations are saved, the owner gets one alert (Telegram, or a dashboard pop-up if they're at the desk) naming the affected integrations. At most every 30 minutes. The vault stays passphrase-only (owner's choice).

## 4.7.0 (early piece of Build 6: data for backtests)
- `kalshi_backtest_data`: settled markets in a series over the last N days (≤90) with the yes bid/ask from hourly candlesticks at a chosen local time before the outcome (DST-safe), the result, and each day's favorite. Public data (works with the vault locked), cached in a `cache` table, rate-limit backoff.
- `kalshi_markets` fixed for Kalshi's switch to dollar-string fields (`*_dollars`); it's public now too. Portfolio parsing accepts both formats.
- `weather_history`: official NOAA NCEI daily highs/lows. Verified that KXHIGHLAX settles in line with **LAX (USW00023174)**, not downtown (which runs ~5°F hotter); LAX is the default.
- James has Anthropic code execution (`agents.code`) for exact backtest math. Riley has the three data tools.
- 73 tests.

## 4.8.0: Statistics + cost cuts
- **Statistics tab** (`src/stats.js`, `/api/stats?span=`): spend, per-day, projected month and average call over today / 7 / 30 days / all; a per-agent table (calls, spend, share, per call, cache hits); a breakdown of what money paid for (output, cache writes, uncached input, cache reads, web searches, phone); daily spend by agent; Auto routing split; ranked insights with estimated monthly savings and one-click fixes (James low effort, shorter history).
- **Cost fixes** (from the real ledger: cache writes were ~45% of James's spend; Pete had 19 cache writes and 0 reads):
  - Prompt caching: the stable prefix (tools + system) is cached; the conversation is cached only from step 2 of a run.
  - History: last 12 messages by default (`history_limit`, 2–40).
  - Riley: 3 searches per step, fetched pages capped at 6,000 tokens.
- Mobile tab bar shows icons only under 480px. 74 tests.

## 4.9.0: Chat compression
- Archivist (hidden Haiku agent: remember/recall/link_memory). Every 5 minutes, for each thread with 4+ messages outside the history window, it saves lasting facts to memory (recall first, update rather than duplicate) and rewrites a ≤120-word rolling summary (`summary:<thread>`). History = summary + last `history_limit` messages.
- The summary is shown (collapsible) at the top of the chat. History size is editable in Settings. Background/ephemeral runs never file budget-raise requests. 75 tests.

## Part 3 (later)
- GitHub publishing via a fine-grained token (approval per publish).
