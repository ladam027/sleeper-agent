# Build 11: Income engine

## 11.0.0 (phase 11.1): find → demo → pitch
- `src/income.js`. Daily at the chosen time (jobs tick) when switched on: Riley (web search, ≤30% of the day's budget) lists independent businesses in the area/types with no website of their own. His answer is untrusted: code keeps only well-formed fields (real-looking emails, http(s) sources, capped text), skips anything already in the CRM (name, email or phone) or on the opt-out list, and adds the rest as leads (`contacts.source = 'engine'`).
- Leads with a public email get a demo site from Mia (no generated images; budget split per lead; saved as a draft, not public). Leads without one become "call or visit" items.
- The pitch is a fixed template (no model call): who James is and who he works for, the demo link, the owner's offer, the owner's name and mailing address, and "reply no thanks and we won't email you again" (CAN-SPAM). No address set = the engine pauses and asks for one.
- One approval per day (`send_pitches`, hidden, high risk, needs the vault for Netlify): publishes each demo and sends its email from James's Gmail. Re-checked at send time: ≤10 sends/day, never the same address twice in 30 days, opt-outs, address set. Sent pitches move the lead to contacted, set a 5-day follow-up date and are saved to memory.
- Opt-outs: James's inbox check treats "no thanks / not interested / unsubscribe / stop…" replies from a contact as an opt-out: address suppressed forever, lead lost, waiting pitches cancelled.
- Money → **Income engine** card: area, business types, leads/day (≤8), budget/day (≤$5), time, name, offer, mailing address, on/off, run now, every pitch with its email and a preview/live demo link.
- Schema v28 (contacts.source, pitches, suppress). 145 tests (test/income.test.js).
- Cost: about $0.05–0.15 for Riley's search + ~$0.10–0.20 per demo on Sonnet, so ~$0.50–0.80/day at 3 leads; the daily budget caps it.

## Owner setup
1. Money → Income engine: set the mailing address (a P.O. box works), check the offer and area, Save, Turn on (or Run now).
2. Netlify must be connected (Integrations) and the vault unlocked when you approve, since approving publishes the demos.

## Known gaps / next (11.2)
- Follow-ups and drafted answers to interested replies; call list for phone-only leads.
- Riley's "no website" check is his judgment from search results; the preview link lets you catch mistakes before approving.

## Updates
- 11.1.0: ID/document uploads from the owner's phone. `browser` action `request_upload` on a file field asks the owner on Telegram (shows the site's host, Cancel button); the owner's photo/PDF goes straight into that field via `upload.js` → `browser.attachFile`, only if the page is still on that host. Kept in memory only: never saved, logged, in the DB, or shown to a model. One request = one file, 15-minute window, 10 MB, JPG/PNG/WebP/PDF. A submit after an owner file always goes to the owner, never Sam. Instead of storing license photos in Drive (owner asked 2026-11-04; advised against). Test: `test/upload.test.js`.
