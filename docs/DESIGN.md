# Dashboard design system (v11.2 "house")

The owner's house design spec, app personality (confirmed for the dashboard 2026-11-04): calm, flat, Apple-like. One palette of cream, ink and yolk. Depth is a hairline ring and a faint shadow only: no glows, gradients (except the logo squircle), glass as decoration, orbs or icon tiles. Density is a product requirement: never trade figures or controls for whitespace.

**Tokens** (top of `public/index.html`, `:root`; dark under `prefers-color-scheme` and `data-theme`). Components use only these.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #fbf7ee | #14110b | cream canvas / warm black |
| `--surface` | #fffdf8 | #1f1b14 | cards (paper) |
| `--surface-2` | #f7f2e6 | #19160f | inset rows, config panels |
| `--sunken` | #f1ead8 | #2c261c | soft buttons, pills, hover rows, active nav pill |
| `--side` | #f4eedf | #18150e | sidebar |
| `--ink` / `--ink-2` | #17130b / #5b5346 | #f7f1e3 / #b3a996 | text / secondary (≥4.5:1) |
| `--line` / `--line-strong` | ink 10% / #d9cfb8 | cream 10% / 20% | hairlines / input borders |
| `--brand` | #8a5a00 | #f5bd2f | links, focus, active icon. Never yellow text on cream |
| `--fill` / `--on-fill` | #f5bd2f / #17130b | same | yolk fills: primary pill, user chat bubble, busy ledger, cost bars |
| `--ok` `--warn` `--bad` `--info` | #248a3d #b25000 #d70015 #0066cc | #30d158 #ffb340 #ff6961 #2997ff | state only |

**Type:** one family, SF on Apple devices, Inter elsewhere. Body 14px (dense, by owner request), headings 600 with -0.02 to -0.028em tracking, `text-wrap: balance`. All figures `tabular-nums` in the same face (no mono costume; real mono only for code and approval payloads).

**Shape:** radius 10 / 14 / 20, pills fully round. Spacing on a 4px scale. Icons: stroke SVG sprite, 2px stroke, 18px (22px in the phone tab bar).

**Components**
- Buttons are pills: `.btn` soft (sunken), `.btn.primary` yolk (one per view), `.btn.danger` red outline, `.btn.solid-danger`. Press = scale(.97). On touch, `::after` gives a 44px hit area.
- Cards: paper + hairline ring, no hover lift. Card headers are a heading + one-line sub; no icon tile.
- Figures: hairline-divided columns inside one card (`.kpis`), never floating KPI cards.
- Status ledger (Overview `#hero`): James's line (dot + state sentence + model chip) over six figures. The line fills yolk only while an agent is working (`.hero.busy`), the dashboard's one signature move.
- Lists: hairline rows, muted meta on a second line, tabular figures.
- Nav: subtle pill for the current page. Phones (≤900px): 4 labeled tabs (Overview, Money, Clients, Browser) + More, which expands the other sections above the tab bar.
- Empty pills/chips/buttons never paint (`:empty` hidden).

**Motion** (all off under `prefers-reduced-motion`): panels enter with a 450ms expo-out rise; controls 200ms; chart bars grow on page open; chat bubbles rise. Pulse only on genuinely live state (live dot, typing indicator). No aurora, shimmer, sheen sweeps, spinning rings or count-up flourishes beyond the existing number count.

**Rules:** no new colours outside `:root`; dynamic lists don't animate on the 4-second refresh; visible focus ring (3px amber outline); the dashboard script syntax test runs before every deploy.
