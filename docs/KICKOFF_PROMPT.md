# Kickoff prompt for the next build session

Paste this into a fresh Claude Code session opened in this repo. Change `N` to the build number.

---

You are continuing development of **Sleeper Agent**, my personal 24/7 AI assistant system (Node + SQLite + Claude API, dashboard in `public/index.html`). This session's job is **Build N** as defined in `docs/PLAN.md` §4.

Before writing code:
1. Read `CLAUDE.md`, `docs/PLAN.md`, and every file in `docs/builds/`, then skim `src/` and `test/`. Don't re-plan finished builds or re-argue decisions recorded there.
2. Write `docs/builds/BUILD-N.md` with: the scope (from PLAN §4), anything I must do by hand (accounts, keys, approvals), the files you'll touch, and the tests you'll add. Ask me only questions that block the build; for everything else, choose a sensible default and note it.

While building:
- Keep the existing architecture: every model call goes through `runAgent`; side-effect tools are `risk: 'high'`; secrets are references only; budgets and kill switch always apply.
- Prefer built-ins and official APIs. Every new dependency needs a one-line reason in the build notes.
- Add one focused test per new money/safety path. Run `npm test` before each commit.
- Never paste or request my passwords, keys, or card numbers in chat. Tell me which `.env` variable to set.

When done:
- Update `docs/builds/BUILD-N.md` (shipped / skipped / known gaps / how to demo), tick the build in PLAN §4, commit, push, and give me a 5-line summary plus the manual steps left for me.

---

## Why one model for both planning and coding

The plan already exists in `docs/PLAN.md`, so each build is mostly implementation with small design calls. Claude Opus 5.5 handles both well and costs less than Fable 5.1. Splitting into a planner model and a coder model adds a hand-off step where context gets lost, and saves little. The plan, the build notes, and `CLAUDE.md` are how sessions talk to each other: each one reads them at the start and updates them at the end.

When it is worth bringing in Claude Fable 5.1: a one-off **security / architecture review** before Build 6 (trading) and Build 7 (voice/browser), where a missed flaw costs real money. Use this prompt:

> Review this repository as a skeptical security engineer before it gets access to brokerage, betting, and payment APIs. Read CLAUDE.md, docs/PLAN.md, and all of src/. List concrete ways an attacker (malicious email, web page, SMS spoofing, or a compromised dependency) or a model mistake could move money, leak secrets, or run up costs. Rank by impact × likelihood, and give the smallest code change that closes each hole. Don't rewrite the architecture unless a hole requires it.
