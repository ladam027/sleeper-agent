# Build 7: Voice + browser hands

## Part 1 (v7.0.0): self-knowledge
- `capabilities()` (src/tools.js) builds a live map from the registry: every active agent with its tools, which tools need approval, connected integrations. Never hand-maintained.
- `list_capabilities` tool (taint-safe): agents answer "can you…?" from the real registry. Useful for James, whose specialist tools load on demand.
- Guide tab: "What your agents can do", generated from `/api/capabilities` (per agent, each tool's one-line summary, approval badges).
- 99 tests.

## Next (needs owner decisions)
- Voice agent: provider for AI phone calls (Telnyx AI assistant on the existing number vs Vapi/Retell), voice clone (ElevenLabs) or a stock voice. Must disclose it's an AI, record only with consent, transcript + outcome afterwards.
- Browser hands: Playwright + Chromium on the VPS (new dependency). Vault references only, each secret usable only on its saved site's domain, every submit approval-gated, pauses for CAPTCHA/2FA.
