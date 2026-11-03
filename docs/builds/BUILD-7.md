# Build 7: Voice + browser hands

## Part 1 (v7.0.0): self-knowledge
- `capabilities()` (src/tools.js) builds a live map from the registry: every active agent with its tools, which tools need approval, connected integrations. Never hand-maintained.
- `list_capabilities` tool (taint-safe): agents answer "can you…?" from the real registry. Useful for James, whose specialist tools load on demand.
- Guide tab: "What your agents can do", generated from `/api/capabilities` (per agent, each tool's one-line summary, approval badges).
- 99 tests.

## Part 2 (v7.1.0): browser hands
- New dependency: `playwright-core` (drives headless Chromium; no browser bundled in npm). Justification: form filling on real sites needs a real browser engine; nothing built-in does this. Chromium (~120 MB) is installed to `/opt/ms-playwright` by deploy.sh (idempotent, keeps the browser in step with the package) and read by the `sleeper` service user.
- `browser` tool (src/browser.js): open / snapshot / goto / click / type / select / press / fill_secret / back / close. Each result lists numbered controls plus up to 2,000 chars of page text marked untrusted. Up to 3 sessions, closed after 30 idle minutes.
- Safety in code: only public http(s) hosts for the page and every request it makes (localhost, LAN, tailnet, link-local, IPv6 private and names resolving to them are blocked, so pages can't reach the dashboard); downloads, service workers and dialogs off. `fill_secret` types a vault value only when the page is on the vault item's saved website (owner sets it on the item), never returns or logs it, and masks the field in later snapshots. Submit/commit controls (submit buttons, buttons in forms, Enter inside a form, buy/pay/send/sign in/book… buttons) are refused, re-checked on the live element at click time; they go through `browser_submit` (risk high: owner approval every time). The approval card shows a live screenshot of the page and its URL. CAPTCHAs are reported and left for the owner; 2FA codes come from the owner (Telegram).
- Every browser result taints the run (other side-effect tools then need approval). `browser` itself is taint-safe because it gates submits internally. Approval results are one line (no page text into chat history).
- Known gap (ponytail note in code): a plain link/div whose own script submits a form can't be detected; DNS answers could change between the host check and Chromium's lookup.
- Also fixed a flaky phone test (failed during 23:59 local). 102 tests.

## Next (needs owner decisions)
- Voice agent (owner chose 2026-11-03: Telnyx + ElevenLabs voice clone). Needs: an ElevenLabs paid plan, an instant voice clone of the owner, its API key in Integrations. Must disclose it's an AI, record only with consent, transcript + outcome afterwards.

## 7.3.0: honest actions, emails as James, sent-email memory
- Emails leave from James's Gmail, so they're written as James: `send_email` has a pre-approval check (valid recipient, subject/body, draft exists) that refuses text speaking as Pete. Rule added for every agent.
- Every successfully sent email is saved to memory in code (`kind = 'email'`, title "Email to <addr>: <subject>", body with date and text), so "the email I sent Ryan" can be recalled.
- Approvals that fail when run are marked `failed` (not approved), the agent's note says "failed", and the owner gets a phone notice that it did NOT go through. A missing draft is now an error, not a quiet message.
- Every message to an agent carries the vault state ("Vault: LOCKED …"), so agents know before trying key-based tools.
- No false claims: rule for all agents (never say it was done without a tool result), and in code a specialist reply that claims an action (`CLAIM`) while it ran no action tool is discarded and James answers. Found in the logs: Pete promised daily Riley monitoring and daily updates without doing anything.
- Morning Telegram briefing now includes a paper-trading line (value, P&L, open/closed, paper day), which the owner asked for and Pete had falsely confirmed.
- 109 tests.

## 7.4.0: stay signed in
- After a vault login is used in the browser, that site's own cookies (filtered to the login's saved website) are saved encrypted in the vault as `session-<login>` (after each approved submit and when the session closes). A later session opening the same site loads them, so sites like Amazon don't ask for a code every time. Only while the vault is unlocked; never shown to the model (vault values are also scrubbed by redact()). Deleting the `session-…` item on the Vault page signs the agents out. The browser tool tells agents to tick "Keep me signed in".
- 110 tests.

## 7.5.0: live browser
- Dashboard **Browser** tab: live view of each open agent browser session (a screenshot about once a second, only while the tab is open and visible), the agent's last action ("click "Sign in"", "fill_secret (dmv-login)"; typed text never shown), and the page URL. Costs no tokens: screenshots go only to the dashboard.
- The owner can click, type, press a few safe keys and scroll on the page (`POST /api/browser/<id>/input`), which is how CAPTCHAs and other human-only steps get done. Owner input is never logged (only "used session X"); afterwards the agent's control numbers are reset so it must take a fresh snapshot.
- Agents are told to send the owner to the Browser tab for CAPTCHAs (before, James pointed the owner at a "browser view" that didn't exist).
- Also: Kalshi integration copy updated (live trading exists). 111 tests.
- 7.5.1: after an approved browser_submit, the agent is woken automatically to check the page and continue, or report exactly what it needs (it used to stop until the owner wrote again; a failed DMV login went unreported). 112 tests.
- 7.5.2: Browser tab loads on open (it checked the current view before the page transition had switched it, so it stayed on "No open browser sessions").
- 7.6.0: Browser tab side column: pending approvals (approve/decline in place; the live page replaces the screenshot and JSON) and a mini chat on the same conversation, so the owner can watch, approve and steer without switching tabs. Stacks on phones.
- 7.6.1: routing keeps follow-ups with James (open browser session, or a short instruction within an hour of his answer; new questions still go to Pete); log in/vault/DMV/Amazon/forms count as heavy; specialists escalate when continuing another agent's task; replies that ask the owner for vault values hand off (CANT); rule: never ask the owner to read out vault values. Personal info gets an optional Website, and fill_secret can type one labeled part ("Plate: … · VIN: …" → field VIN). 114 tests.
- 7.6.2: CAPTCHA detection only counts a CAPTCHA a person can see (≥120×60, visible, not the invisible reCAPTCHA v3 badge or bframe); DMV pages were falsely flagged. Browser contexts use en-US, the owner's timezone and an English Accept-Language (the server is in Germany).
- 7.6.3: browser type/fill_secret send real keystrokes (MyDMV rejected pasted values: the vault login was correct, error 1101 came from the fill). Owner use of the live view is logged at most once a minute (scrolling wrote hundreds of rows). First real end-to-end task: 2026 Audi added to MyDMV Garage (login, SMS 2FA via the owner, plate, ZIP, confirm; 4 approvals).
