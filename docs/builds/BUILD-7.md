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
