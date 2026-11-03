// Build 6 part 2: LIVE Kalshi orders (real money). Paper trading stays the default.
// Gates, all in code:
//  1. Opt-in per request: the owner's own current message must say "live trading" or mention their Kalshi balance
//     (ctx.live, set in runAgent from the owner's text only, never from tools, web pages or history).
//  2. kalshi_order is risk 'high': every order is an owner approval (PIN by phone).
//  3. Limits checked when queued AND again when placed: max $ per order, max open positions, and a cap on total real
//     money at risk (live_max_total_usd, default $14). Closing orders (sells) are always allowed.
//  4. Orders are limit + immediate_or_cancel: they fill now at the approved price or better, or not at all. Nothing rests.
import { randomUUID } from 'node:crypto';
import { db, get, set, log } from './db.js';
import * as integ from './integrations.js';
import { fee, LIMITS } from './paper.js';

export const LIVE_RE = /\blive[- ]?trad(e|es|ing)\b|\bkalshi\b[^.!?\n]*\bbalance\b|\bbalance\b[^.!?\n]*\bkalshi\b/i;
export const deps = { market: (t) => integ.kalshiMarket(t), portfolio: () => integ.kalshiPortfolio(), post: (p, b) => integ.kalshiPost(p, b) };
const limit = (k) => Number(get(k) ?? { ...LIMITS, live_max_total_usd: 14 }[k]);
const r2 = (n) => Math.round(n * 100) / 100;

function validate({ ticker, side, action = 'buy', count, limit_price }) {
  if (!['yes', 'no'].includes(side)) throw new Error('side must be yes or no');
  if (!['buy', 'sell'].includes(action)) throw new Error('action must be buy or sell');
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error('count must be a whole number of contracts (1-1000)');
  if (!(limit_price >= 0.01 && limit_price <= 0.99)) throw new Error('limit_price is required: your worst acceptable price per contract, $0.01-0.99');
  if (!/^[A-Z0-9][A-Z0-9.-]{2,80}$/.test(ticker || '')) throw new Error('ticker looks wrong');
}

// The real numbers, used both before queueing (so the approval shows them) and right before placing.
async function checkLimits(o) {
  const [m, pf] = await Promise.all([deps.market(o.ticker), deps.portfolio()]);
  if (!['active', 'open'].includes(m.status)) throw new Error(`${o.ticker} isn't open for trading (status: ${m.status})`);
  const held = pf.positions.find((p) => p.ticker === o.ticker)?.position || 0; // + YES, − NO (Kalshi nets them)
  const now = o.action === 'buy' ? m[`${o.side}_ask`] : m[`${o.side}_bid`];
  const maxCost = r2(o.count * o.limit_price + fee(o.count, o.limit_price));
  if (o.action === 'sell') {
    const have = o.side === 'yes' ? Math.max(held, 0) : Math.max(-held, 0);
    if (have < o.count) throw new Error(`You hold ${have} ${o.side.toUpperCase()} on ${o.ticker}`);
  } else {
    if ((o.side === 'yes' && held < 0) || (o.side === 'no' && held > 0)) throw new Error(`You hold the other side of ${o.ticker}; sell that first`);
    if (maxCost > limit('trade_max_order_usd')) throw new Error(`Limit: orders are capped at $${limit('trade_max_order_usd')} (this one is up to $${maxCost.toFixed(2)})`);
    if (!held && pf.positions.length >= limit('trade_max_open_positions')) throw new Error(`Limit: at most ${limit('trade_max_open_positions')} open positions`);
    const atRisk = pf.positions.reduce((s, p) => s + (p.exposure_usd || 0), 0);
    if (atRisk + maxCost > limit('live_max_total_usd') + 1e-9) throw new Error(`Limit: real money at risk is capped at $${limit('live_max_total_usd')} ($${atRisk.toFixed(2)} already in positions, this order up to $${maxCost.toFixed(2)})`);
    if (maxCost > pf.balance_usd + 1e-9) throw new Error(`Not enough Kalshi cash ($${pf.balance_usd.toFixed(2)})`);
  }
  return { m, pf, now, maxCost };
}

// Runs BEFORE the order is queued for approval. Returns the line shown on the approval card.
export async function precheck(o, ctx) {
  if (!ctx.live) throw new Error('Live trading is off for this request. The owner turns it on per request by saying "live trading" or mentioning their Kalshi balance in their own message. Use paper_trade instead.');
  validate(o);
  const { m, pf, now, maxCost } = await checkLimits({ action: 'buy', ...o });
  const action = o.action || 'buy';
  return `REAL MONEY: ${action} ${o.count} ${o.side.toUpperCase()} on ${[m.title, m.bracket].filter(Boolean).join(' · ')} (${o.ticker}) at $${o.limit_price.toFixed(2)} or better (now $${now?.toFixed(2) ?? '–'}).`
    + `${action === 'buy' ? ` Up to $${maxCost.toFixed(2)} incl. fee.` : ''} Kalshi cash $${pf.balance_usd.toFixed(2)}. Fills now or cancels.`;
}

// Runs only after the owner approved. Re-checks everything, then places one immediate-or-cancel limit order.
export async function place(o, by = 'orchestrator') {
  validate(o);
  const action = o.action || 'buy';
  await checkLimits({ ...o, action });
  // Kalshi V2 books are YES-only: bid = buy YES, ask = sell YES. Buying NO = selling YES at 1 − price; selling NO = buying YES at 1 − price.
  const bid = (action === 'buy') === (o.side === 'yes');
  const yesPrice = o.side === 'yes' ? o.limit_price : r2(1 - o.limit_price);
  const client_order_id = randomUUID();
  const r = await deps.post('/portfolio/events/orders', { ticker: o.ticker, side: bid ? 'bid' : 'ask', count: o.count.toFixed(2), price: yesPrice.toFixed(4),
    time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross', client_order_id, ...(action === 'sell' ? { reduce_only: true } : {}) });
  const filled = Number(r.fill_count || 0), avgYes = r.average_fill_price != null ? Number(r.average_fill_price) : null;
  const avg = avgYes == null ? null : o.side === 'yes' ? avgYes : r2(1 - avgYes);
  db.prepare(`insert into live_orders (ticker, side, action, count, limit_price, order_id, client_order_id, fill_count, avg_price, fee, by, reason)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(o.ticker, o.side, action, o.count, o.limit_price, r.order_id || null, client_order_id, filled, avg,
    r.average_fee_paid != null ? r2(Number(r.average_fee_paid) * filled) : null, by, String(o.reason || '').slice(0, 300));
  log(by, 'live', `${action} ${o.count} ${o.side.toUpperCase()} ${o.ticker} @≤${o.limit_price}: filled ${filled}${avg != null ? ` at $${avg.toFixed(2)}` : ''}`);
  return filled ? `LIVE order filled: ${action} ${filled} of ${o.count} ${o.side.toUpperCase()} on ${o.ticker}${avg != null ? ` at $${avg.toFixed(2)}` : ''}. Real money.`
    : `LIVE order did not fill: no one was ${action === 'buy' ? 'selling' : 'buying'} at $${o.limit_price.toFixed(2)} or better, so it was cancelled. No money moved.`;
}

export const recent = () => db.prepare('select * from live_orders order by id desc limit 20').all();
export function setCap(v) {
  const n = Number(v);
  if (!(n >= 1 && n <= 1000)) throw new Error('Real-money cap must be $1-1000');
  set('live_max_total_usd', n); log('owner', 'settings', `live trading cap: $${n}`);
}
export const cap = () => limit('live_max_total_usd');
