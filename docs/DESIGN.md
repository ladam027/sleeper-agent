# Dashboard design system (v5.2 "enterprise")

Reference points: Linear / Vercel-style consoles. Deep neutral surfaces, glass panels, hairline borders, one gradient accent (violet → cyan), restrained but rich motion.

**Tokens** (top of `public/index.html`, `:root`; dark overrides under `prefers-color-scheme` and `data-theme`). Components use only semantic tokens.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand` / `--brand-2` | #6d4aff / #06b6d4 | #8b72ff / #22d3ee | accent; gradients run brand → brand-2 |
| `--bg` | #f6f6f9 | #050508 | page (with aurora + grid backdrop) |
| `--surface` / `--surface-solid` | #fff | rgb(18 18 25 / .72) / #111118 | cards (glass in dark) / dialogs, focused inputs |
| `--glass` | rgb(255 255 255 / .72) | rgb(12 12 18 / .62) | sidebar, header, toasts (with backdrop blur) |
| `--ink` / `--ink-2` | #09090b / #5d5d6b | #ededf2 / #9d9db0 | text / secondary (≥4.5:1) |
| `--line` / `--line-strong` | #e5e5ec / #d4d4de | 8% / 14% white | hairlines |

**Type:** Geist 400–700 (UI), Geist Mono (numbers, money, KPIs). **Radius:** 9 / 12 / 16. **Spacing:** 4-pt scale.

**Motion** (all off under `prefers-reduced-motion`):
- Aurora backdrop drifts (28s), faint grid masked from the top.
- Cards rise in staggered (`--i` per panel), with a gradient border and lift on hover.
- Page changes use the View Transitions API (sidebar stays put).
- Numbers count up (`countTo`), progress bars fill and shimmer, charts grow on page open (`.grow`, not on refresh).
- Primary buttons have a light sweep; the agent orb has a rotating conic ring; toasts spring in.
- Memory graph: live force simulation; drag nodes (neighbors follow), pan, wheel/pinch zoom, fit, shake.

**Rules:** no new colors outside `:root`; dynamic lists (agents, feed) don't animate on the 4-second refresh; 36px+ hit targets; visible focus ring; a dashboard script syntax test runs before every deploy.
