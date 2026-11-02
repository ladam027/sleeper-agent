# Build 2: Reach me (phone + reminders)

**Scope (PLAN §4)**
- Twilio texts and calls: `notify_owner` high → text, critical → call + text. Quiet hours (default 00:00–07:00, editable) downgrade agent-initiated calls to texts. Alarms you set yourself still ring.
- Text James: inbound SMS from the owner's number only (Twilio signature checked) → Auto routing → reply by text.
- Approve by text: every approval is texted to you; reply `Y 12 <PIN>` / `N 12 <PIN>`. The PIN is set in Settings and stored hashed. Caller ID can be spoofed, so no PIN means no approval.
- Reminders and alarms: agents get `set_reminder` / `list_reminders` / `cancel_reminder` (dashboard, text or call; once, daily, weekdays or weekly; follows your current timezone and DST). An "alarm" is a phone call reminder.
- Daily caps on texts and calls (stops loops from running up Twilio), Twilio spend shown in the cost tracker.
- Nightly backup at 03:00 local.
- Webhooks on a separate port (8788) with only `/twilio/sms`, so you can expose that one port publicly (Tailscale Funnel) while the dashboard stays private.
- Deploy guide for running 24/7 (docs/DEPLOY.md).

**Manual steps (owner)**
1. Twilio account → buy a US number with SMS + Voice (~$1.15/mo).
2. Start **A2P 10DLC "Sole Proprietor"** registration in the Twilio console. US carriers block app texts until it's approved (1–3 weeks). Calls work right away.
3. Fill in the Twilio lines in `.env` (never in chat): `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `OWNER_PHONE`.
4. For inbound texts: install Tailscale, run `tailscale funnel 8788`, put the https URL in `PUBLIC_URL`, and set the Twilio number's "A message comes in" webhook to `PUBLIC_URL/twilio/sms` (HTTP POST).
5. Set your SMS PIN in Settings → Phone & alerts.

**Deferred**
- Google Calendar events: needs Google OAuth, so it moves to Build 4 alongside Gmail.
- Automatic timezone from phone location: telling James "I'm in Denver" already works.
- Telegram channel: only if 10DLC takes too long.
- Off-site backups and an uptime ping: when it moves to a VPS.

**Files:** `src/phone.js` (new), `src/scheduler.js` (new), `src/tools.js`, `src/agent.js`, `src/server.js`, `src/db.js` (schema v6), `src/budget.js`, `public/index.html`, `docs/DEPLOY.md`.
**Tests:** signature check, quiet hours, local time → UTC across DST, repeating reminders, notify routing and caps, SMS approval with PIN, owner-only inbound.

**Shipped (v2.0.0)**
- `src/phone.js`: Twilio texts/calls over fetch, signature validation, quiet hours, notify routing, daily caps (30 texts / 5 calls), Twilio spend in the cost ledger, hashed SMS PIN, approval parsing.
- `src/scheduler.js`: reminders/alarms (once/daily/weekdays/weekly) with DST-safe local times and re-zoning on timezone change, late delivery after downtime, nightly 03:00 backup. 30s tick.
- `src/sms.js`: owner-only, signature-checked inbound texts → PIN approvals or Auto-routed chat, reply by text.
- Agents: `notify_owner` really texts/calls; `set_reminder` / `list_reminders` / `cancel_reminder` (Pete has them too); every approval is texted.
- Webhook listener on port 8788 (only `/twilio/sms`); the dashboard stays on 8787.
- Dashboard: Reminders card (add/cancel), Settings → Phone & alerts (status, quiet hours, PIN, test text/call), phone activity, Guide section. `docs/DEPLOY.md`.
- 30 tests (8 new).

**Known gaps:** Twilio prices are flat estimates. A repeating reminder fires once if the server was off for a long time (missed occurrences are skipped, not replayed). Inbound texts need Tailscale Funnel or a VPS with a public URL.

**Update 2.1: Telnyx + Telegram instead of Twilio SMS** (owner declined A2P 10DLC sole-proprietor registration)
- Calls: Telnyx `POST /v2/texml/calls/{connection_id}` with inline `Texml`. No public URL needed. `npm run setup:telnyx` creates the outbound voice profile + TeXML app, attaches the number, and writes `TELNYX_CONNECTION_ID`/`TELNYX_FROM` to .env.
- Messages: a Telegram bot, long-polled (`getUpdates`), so there's no webhook or public port. Paired with a one-time 6-digit code from the dashboard (one guess per code). Only the paired private chat is answered. Approvals use `Y 12 <PIN>`.
- Removed: Twilio, the port-8788 webhook listener, PUBLIC_URL/Tailscale Funnel requirement. Reminder channel `sms` → `message` (schema v7).
- Owner setup: (1) Telegram → @BotFather → /newbot → paste token as TELEGRAM_BOT_TOKEN → Settings → Pair Telegram. (2) Telnyx account → buy a number → API key → TELNYX_API_KEY + OWNER_PHONE → `npm run setup:telnyx`.
