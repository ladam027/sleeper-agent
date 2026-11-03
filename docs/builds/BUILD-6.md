# Build 6: Markets (human-in-the-loop)

## Part 1 (v6.0.0): paper trading
- `src/paper.js`: a simulated Kalshi account (starts at $100) trading at real prices. Orders fill immediately at the live ask (buy) or bid (sell), with Kalshi's taker fee (ceil(0.07 × C × P × (1−P)) to the cent). No resting orders. Uses public market data, so it works while the vault is locked.
- Limits enforced in code, the same ones live trading will use, editable only by the owner on the Markets tab: max $ per order (default $10), max open positions (5), max daily loss (default $20, realized losses + fees; selling to cut risk is always allowed). Paper cash can't go negative.
- Settlement: every 5-minute tick, settled markets pay $1 per winning contract, $0 otherwise, exactly once.
- Tools (James, loaded on demand): `paper_trade` (requires a reason, shown on every fill), `paper_account`. Both taint-safe (no money moves).
- Markets tab: paper value, total/realized P&L, win rate, the 30-day paper-period clock, positions marked at the current bid, recent trades with reasons, limits form, and the real Kalshi balance/positions (read-only).
- Schema v20. 96 tests (fee math, fills, P&L, every limit, settlement exactly once).
- Bug caught by the tests: `having count > 0` in SQLite reads the raw `count` column, not the aggregate alias, so a settled position would never close and would be paid out on every tick.

## Not yet
- **Live orders**: only after the 30-day paper period, behind a high-risk approval with your PIN on every order, plus the same code limits. Not built until then.
  - **Decided (owner, 2026-11-03): approve-to-unlock.** If the vault is locked when an order is approved on the dashboard, the approval dialog asks for the passphrase, unlocks, then places the order. A phone (Telegram) approval while locked keeps the order waiting and pings "unlock to place it"; on unlock it re-checks the live price against the order's limit price (and the code limits) before placing, and expires if the market moved or closed. No Kalshi key outside the vault.
- **Schwab**: waiting on Schwab's developer app approval (then OAuth + read-only positions, weekly re-auth reminder).
- **Simulation lab**: James already has code execution and `kalshi_backtest_data` / `weather_history`; no extra code needed yet.
- Paper limitation: daily loss counts realized losses only; unrealized losses on open positions don't block new buys yet.

## 6.1.0
- `weather_forecast`: National Weather Service point forecast (free, no key; highs, lows, rain chance, sky) for the Kalshi weather spots or any US lat/lon. Point lookups cached. Not tainting (numbers and NWS short phrases only), same as weather_history.
- Dashboard: Refresh button in the header reloads the current page's data (useful in the home-screen app, which has no browser reload). 97 tests.

## 6.2.0
- Vault idle lock is a choice on the Vault page: 1 (default), 4, 8 or 24 hours without use. Changing it needs a passphrase session. Restarts/updates still always lock. (src/vault.js change, called out to the owner.) 98 tests.

## Part 2 (v7.2.0, shipped during Build 7 at the owner's request): live orders
- Owner decision (2026-11-03): build live trading now, but **opt-in per request**: only when the owner's own message (dashboard or Telegram) says "live trading" or mentions their Kalshi balance. Otherwise paper trading is the default. Background jobs, the archivist, history and tool output can never switch it on (`ctx.live`, set in runAgent from `opts.owner` + `LIVE_RE`).
- `kalshi_order` (src/live.js), risk high: a pre-queue `check` refuses if not opted in or if limits fail, so only valid orders reach the owner; the approval card and phone notice show the real numbers (market, side, limit, max cost incl. fee, Kalshi cash) with a "Real money" badge.
- Limits in code, checked at queue time and again right before placing: max $ per order, max open positions, total real money at risk (`live_max_total_usd`, default $14, editable on the Markets tab), Kalshi cash. Sells only close what's held (`reduce_only`).
- Orders: Kalshi V2 `POST /portfolio/events/orders`, limit + `immediate_or_cancel` (fills now at the approved price or better, never rests). V2 books are YES-only: buy NO = ask at 1 − price, sell NO = bid at 1 − price. Logged in `live_orders`.
- Approve-to-unlock: approving on the dashboard while the vault is locked asks for the passphrase in a dialog, then places. Approving by phone while locked sets `waiting_unlock`; unlocking within 30 minutes places it after re-checking, otherwise it expires.
- Not counted yet: realized daily loss on live trades (the total-at-risk cap bounds exposure instead). Schema v21. 107 tests.
