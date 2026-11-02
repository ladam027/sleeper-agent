# Dashboard design system

Inspired by Molar AI (layout, hero card, KPI cards, chat rail), AI Agent Control Centre (agent and approval cards, "AI is ready" orb), and Crypto AI Agent (dark hero, live feed). Generated with ui-ux-pro-max (style: Modern Dark / soft light, density 8, motion 3), then tuned.

**Tokens** live in `:root` at the top of `public/index.html`: primitives (`--violet-500`, `--gray-50`…) feed semantic tokens (`--bg`, `--surface`, `--ink`, `--brand`, `--ok/--warn/--bad`). Components use only semantic tokens. Dark mode overrides the semantic layer (system preference, or `data-theme` set from Settings).

| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand` | #6d4aff | #8b72ff | primary actions, active nav, progress |
| `--bg` / `--surface` | #f4f3fb / #fff | #0c0b14 / #15131f | page / cards |
| `--ink` / `--ink-2` | #17152b / #5d5a74 | #ecebf5 / #a3a0ba | text / secondary (≥4.5:1) |
| hero | #140f2e → #3b2a8c | same | the one dark "agent live" card |

**Type:** Inter 400/500/600/700, 14px base, tabular numbers for money. **Radius:** 8 / 12 / 18. **Spacing:** 4-pt scale (`--s1`…`--s8`). **Icons:** inline Lucide SVG sprite, no emoji.

**Components:** `.card`, `.btn` (`primary`, `danger`, `sm`, `icon`), `.pill` (`ok`, `warn`, `bad`, `brand`), `.progress` (auto warn ≥70%, bad ≥90%), `.ibox`, `.row` (feed/list), `.agent`, `.ap` (approval), `.hero`, `.tile`, `.kpi`.

**Rules:** no new CSS colors outside `:root`; 36px+ hit targets (52px in the mobile tab bar); visible focus ring; respect `prefers-reduced-motion`; layout collapses at 1280px (chat moves below), 900px (bottom tab bar), 560px.
