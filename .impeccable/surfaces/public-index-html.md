---
version: 1
slug: "public-index-html"
primary_target: "public/index.html"
related_targets: []
---

# Dashboard (public/index.html)

Scope: the whole signed-in dashboard and its login. Mode: Operate. Owner on laptop and phone equally; job: talk to the agents, see state and cost, approve, manage. Constraint: keep today's information density. Direction pinned by the owner: the house design spec (app personality).

## Direction contract
THESIS: A calm, flat owner's console in the house look: cream paper, ink type, one yolk accent that means "James is working / needs you". Refuses the neon-on-black AI console (glow orbs, aurora, gradient borders, icon tiles, hero-metric band).
OWN-WORLD: Cream #fbf7ee ground, paper #fffdf8 cards with a hairline ring, ink #17130b text, dark-amber #8a5a00 for links/focus, yolk #f5bd2f only as fills (primary pill, user chat bubble, live/busy state). Warm black #14110b in dark. SF/Inter one family, tabular numerals, pill buttons, 16-20px card radius.
STORY: The owner opens it, sees in one line whether James is idle or working and what today cost, clears approvals, then works in chat or a page.
FIRST VIEWPORT: Sidebar nav (subtle cream pill marks the page, per the house spec; phones get 4 tabs + More), status header; Overview leads with one status ledger card (James's line over six hairline-divided figures: tasks, tools, spend today vs cap, month, memory, approvals); left column approvals, reminders, scheduled tasks, activity; right column agents, chat rail right.
FORM: house spec app shell, position 1 (pinned), seed: none (pinned by owner: the house spec; no roll, per new-work "a user- or brief-pinned direction beats the roll")
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
Signature move: the status ledger, whose live dot and James line fill yolk only while an agent is working.
