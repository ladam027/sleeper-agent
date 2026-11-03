// Build 6: paper trading. Fills at live bid/ask with Kalshi fees, code-enforced limits, settlement, P&L.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, set } = await import('../src/db.js');
const paper = await import('../src/paper.js');
const book = {
  'KXHIGHLAX-26NOV03-B71.5': { status: 'active', result: null, yes_bid: 0.40, yes_ask: 0.42, no_bid: 0.58, no_ask: 0.60 },
  'KXHIGHLAX-26NOV03-B73.5': { status: 'active', result: null, yes_bid: 0.20, yes_ask: 0.22, no_bid: 0.78, no_ask: 0.80 },
};
paper.deps.market = async (t) => { if (!book[t]) throw new Error('no market'); return { ticker: t, title: 'LA high', bracket: t.slice(-5), ...book[t] }; };
const T1 = 'KXHIGHLAX-26NOV03-B71.5', T2 = 'KXHIGHLAX-26NOV03-B73.5';

test('Kalshi fee formula rounds up to the cent', () => {
  assert.equal(paper.fee(10, 0.42), 0.18); // 0.07 × 10 × 0.42 × 0.58 = 0.1705
  assert.equal(paper.fee(1, 0.5), 0.02);
});

test('buys fill at the ask, sells at the bid; P&L and cash include fees; no real money', async () => {
  assert.match(await paper.trade({ ticker: T1, side: 'yes', count: 10, reason: 'NWS says 72' }, 'orchestrator'), /No real money moved/);
  let a = await paper.account();
  assert.equal(a.cash, 95.62);
  assert.equal(a.positions[0].avg_cost, 0.42);
  assert.equal(a.positions[0].unrealized, -0.2);
  book[T1].yes_bid = 0.55;
  await paper.trade({ ticker: T1, side: 'yes', action: 'sell', count: 4 }, 'orchestrator');
  const sellPnl = Math.round((4 * (0.55 - 0.42) - paper.fee(4, 0.55)) * 100) / 100;
  assert.equal(db.prepare("select pnl from paper_trades where action = 'sell'").get().pnl, sellPnl);
  await assert.rejects(paper.trade({ ticker: T1, side: 'yes', action: 'sell', count: 7 }), /You hold 6/);
  await assert.rejects(paper.trade({ ticker: T1, side: 'no', count: 1, limit_price: 0.5 }), /Not filled.*0\.60/);
});

test('limits are enforced in code: per-order cap, open positions, daily loss, cash', async () => {
  await assert.rejects(paper.trade({ ticker: T2, side: 'no', count: 20 }), /capped at \$10/);
  set('trade_max_open_positions', 1);
  await assert.rejects(paper.trade({ ticker: T2, side: 'yes', count: 1 }), /at most 1 open positions/);
  set('trade_max_open_positions', 5);
  await assert.doesNotReject(paper.trade({ ticker: T2, side: 'yes', count: 1 }));
  set('trade_max_daily_loss_usd', 1);
  book[T1].yes_bid = 0.05;
  await paper.trade({ ticker: T1, side: 'yes', action: 'sell', count: 6 }); // loses ~$2.22
  await assert.rejects(paper.trade({ ticker: T2, side: 'yes', count: 1 }), /today's losses/);
  await assert.doesNotReject(paper.trade({ ticker: T2, side: 'yes', action: 'sell', count: 1 }), 'selling to cut risk is still allowed');
  assert.throws(() => paper.setLimits({ trade_max_order_usd: 0 }), /1-500/);
  set('trade_max_daily_loss_usd', 20);
});

test('settlement pays $1 per winning contract and $0 per losing one, once', async () => {
  db.exec('delete from paper_trades');
  book[T2] = { status: 'active', result: null, yes_bid: 0.20, yes_ask: 0.22, no_bid: 0.78, no_ask: 0.80 };
  await paper.trade({ ticker: T2, side: 'yes', count: 10 });
  await paper.settle();
  assert.equal(db.prepare("select count(*) n from paper_trades where action = 'settle'").get().n, 0, 'not settled while open');
  Object.assign(book[T2], { status: 'finalized', result: 'yes' });
  await paper.settle(); await paper.settle();
  const s = db.prepare("select * from paper_trades where action = 'settle'").all();
  assert.equal(s.length, 1, 'settled exactly once');
  assert.equal(s[0].price, 1); assert.equal(s[0].pnl, 7.8);
  const a = await paper.account();
  assert.equal(a.positions.length, 0);
  assert.equal(a.win_rate, 1);
  await assert.rejects(paper.trade({ ticker: T2, side: 'yes', count: 1 }), /isn't open/);
});
