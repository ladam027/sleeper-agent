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
5. **Clients → Create client → Web application**. Authorized redirect URI: `https://sleeper-agent.tailcdfa9.ts.net/oauth/google`. Copy the client ID and secret into `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`); Claude pushes it with `npm run deploy -- --env`.
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

## Part 3 (later)
- GitHub publishing via a fine-grained token (approval per publish).
