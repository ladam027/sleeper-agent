// Build 6: paper trading on Kalshi. Real prices, fake money. Fills at the live bid/ask (no resting orders),
// Kalshi's taker fee included. Limits are enforced here, in code, and are the same ones live trading will use.
import { db, get, set, log } from './db.js';
import { kalshiMarket } from './integrations.js';

export const deps = { market: kalshiMarket }; // tests swap in a fake
export const LIMITS = { trade_max_order_usd: 10, trade_max_open_positions: 5, trade_max_daily_loss_usd: 20 };
export const PAPER_DAYS = 30; // paper period before live trading can even be considered
const limit = (k) => Number(get(k) ?? LIMITS[k]);
const today = () => new Date().toISOString().slice(0, 10);
const r2 = (n) => Math.round(n * 100) / 100;
// Kalshi taker fee: ceil(0.07 × contracts × P × (1 − P)) to the cent.
export const fee = (count, price) => Math.ceil(0.07 * count * price * (1 - price) * 100 - 1e-9) / 100;

function startIfNew() {
  if (!get('paper_started_at')) { set('paper_started_at', new Date().toISOString()); set('paper_start_usd', get('paper_start_usd') || 100); }
}
// Open positions: net contracts and average cost per ticker+side.
// ponytail: average cost over every buy of that ticker+side; a position closed and reopened mixes cost bases (rare: markets are daily).
function positions() {
  return db.prepare(`select ticker, side, max(title) title,
      sum(case when action = 'buy' then count else -count end) count,
      sum(case when action = 'buy' then count * price else 0 end) / sum(case when action = 'buy' then count else 0 end) avg_cost
    from paper_trades group by ticker, side
    having sum(case when action = 'buy' then count else -count end) > 0 order by ticker`).all(); // not "having count > 0": SQLite reads that as the raw column
}
const cash = () => Number(get('paper_start_usd') || 100) + (db.prepare(`select coalesce(sum(case when action = 'buy' then -(count * price + fee) else count * price - fee end), 0) c from paper_trades`).get().c);
// Realized losses today (sells/settlements below cost, plus fees). ponytail: open positions' unrealized losses don't count yet.
const lossToday = () => -db.prepare(`select coalesce(sum(case when action = 'buy' then -fee else pnl end), 0) p from paper_trades where substr(ts, 1, 10) = ?`).get(today()).p;

export async function trade({ ticker, side, action = 'buy', count, limit_price, reason = '' }, by = 'owner') {
  if (!['yes', 'no'].includes(side)) throw new Error('side must be yes or no');
  if (!['buy', 'sell'].includes(action)) throw new Error('action must be buy or sell');
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('count must be a whole number of contracts (1-1000)');
  startIfNew();
  const m = await deps.market(ticker);
  if (!['active', 'open'].includes(m.status)) throw new Error(`${ticker} isn't open for trading (status: ${m.status})`);
  const price = action === 'buy' ? m[`${side}_ask`] : m[`${side}_bid`];
  if (!price) throw new Error(`No one is ${action === 'buy' ? 'selling' : 'buying'} ${side.toUpperCase()} on ${ticker} right now`);
  if (limit_price != null && (action === 'buy' ? price > limit_price : price < limit_price)) throw new Error(`Not filled: ${side.toUpperCase()} is ${price.toFixed(2)} now, your limit is ${limit_price.toFixed(2)}`);
  const f = fee(count, price), held = positions().find((p) => p.ticker === m.ticker && p.side === side);
  let pnl = 0;
  if (action === 'buy') {
    const cost = r2(count * price + f);
    if (cost > limit('trade_max_order_usd')) throw new Error(`Limit: orders are capped at $${limit('trade_max_order_usd')} (this one is $${cost.toFixed(2)})`);
    if (!held && positions().length >= limit('trade_max_open_positions')) throw new Error(`Limit: at most ${limit('trade_max_open_positions')} open positions`);
    if (lossToday() >= limit('trade_max_daily_loss_usd')) throw new Error(`Limit: today's losses reached $${limit('trade_max_daily_loss_usd')}; no new buys until tomorrow`);
    if (cost > cash() + 1e-9) throw new Error(`Not enough paper cash ($${cash().toFixed(2)})`);
  } else {
    if (!held || held.count < count) throw new Error(`You hold ${held?.count || 0} ${side.toUpperCase()} on ${ticker}`);
    pnl = r2(count * (price - held.avg_cost) - f);
  }
  db.prepare('insert into paper_trades (ticker, title, side, action, count, price, fee, pnl, by, reason) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(m.ticker, [m.title, m.bracket].filter(Boolean).join(' · '), side, action, count, price, f, pnl, by, String(reason).slice(0, 300));
  log(by, 'paper', `${action} ${count} ${side.toUpperCase()} ${m.ticker} @ ${price.toFixed(2)}${action === 'sell' ? `, P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : ''}`);
  return `Paper ${action}: ${count} ${side.toUpperCase()} on ${m.ticker} at $${price.toFixed(2)} (fee $${f.toFixed(2)})${action === 'sell' ? `, P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}` : ''}. Paper cash now $${cash().toFixed(2)}. No real money moved.`;
}

// Every 5 minutes: settled markets pay $1 per winning contract, $0 otherwise.
export async function settle() {
  for (const p of positions()) {
    const m = await deps.market(p.ticker).catch(() => null);
    if (!m || !['yes', 'no'].includes(m.result)) continue;
    const price = m.result === p.side ? 1 : 0, pnl = r2(p.count * (price - p.avg_cost));
    db.prepare("insert into paper_trades (ticker, title, side, action, count, price, fee, pnl, by, reason) values (?, ?, ?, 'settle', ?, ?, 0, ?, 'kalshi', ?)")
      .run(p.ticker, p.title, p.side, p.count, price, pnl, `settled ${m.result.toUpperCase()}`);
    log('owner', 'paper', `${p.ticker} settled ${m.result.toUpperCase()}: ${p.count} ${p.side.toUpperCase()} ${price ? 'won' : 'lost'}, P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  }
}

export async function account({ marks = true } = {}) {
  startIfNew();
  const pos = await Promise.all(positions().map(async (p) => {
    const m = marks ? await deps.market(p.ticker).catch(() => null) : null, bid = m?.[`${p.side}_bid`] ?? null;
    return { ...p, avg_cost: r2(p.avg_cost), bid, value: bid != null ? r2(p.count * bid) : null, unrealized: bid != null ? r2(p.count * (bid - p.avg_cost)) : null };
  }));
  const closed = db.prepare("select count(*) n, sum(pnl > 0) wins, coalesce(sum(pnl), 0) pnl from paper_trades where action in ('sell', 'settle')").get();
  const fees = db.prepare("select coalesce(sum(fee), 0) f from paper_trades where action = 'buy'").get().f;
  const started = get('paper_started_at'), days = Math.floor((Date.now() - Date.parse(started)) / 864e5);
  const c = cash(), value = c + pos.reduce((s, p) => s + (p.value ?? p.count * p.avg_cost), 0), start = Number(get('paper_start_usd') || 100);
  return { cash: r2(c), value: r2(value), start, total_pnl: r2(value - start), realized_pnl: r2(closed.pnl - fees), closed_trades: closed.n, win_rate: closed.n ? r2(closed.wins / closed.n) : null,
    loss_today: r2(lossToday()), started, days, days_left: Math.max(0, PAPER_DAYS - days), positions: pos,
    limits: Object.fromEntries(Object.keys(LIMITS).map((k) => [k, limit(k)])),
    recent: db.prepare('select ts, ticker, title, side, action, count, price, fee, pnl, by, reason from paper_trades order by id desc limit 30').all() };
}

export function setLimits(b) {
  for (const [k, [lo, hi]] of Object.entries({ trade_max_order_usd: [1, 500], trade_max_open_positions: [1, 50], trade_max_daily_loss_usd: [1, 1000] }))
    if (b[k] !== undefined) { const v = Number(b[k]); if (!(v >= lo && v <= hi)) throw new Error(`${k} must be ${lo}-${hi}`); set(k, v); }
  log('owner', 'settings', `trading limits: ${JSON.stringify(Object.fromEntries(Object.keys(LIMITS).map((k) => [k, limit(k)])))}`);
}
