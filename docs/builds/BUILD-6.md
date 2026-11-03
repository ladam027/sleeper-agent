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
- **Schwab**: waiting on Schwab's developer app approval (then OAuth + read-only positions, weekly re-auth reminder).
- **Simulation lab**: James already has code execution and `kalshi_backtest_data` / `weather_history`; no extra code needed yet.
- Paper limitation: daily loss counts realized losses only; unrealized losses on open positions don't block new buys yet.

## 6.1.0
- `weather_forecast`: National Weather Service point forecast (free, no key; highs, lows, rain chance, sky) for the Kalshi weather spots or any US lat/lon. Point lookups cached. Not tainting (numbers and NWS short phrases only), same as weather_history.
- Dashboard: Refresh button in the header reloads the current page's data (useful in the home-screen app, which has no browser reload). 97 tests.
