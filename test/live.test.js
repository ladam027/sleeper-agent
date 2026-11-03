// Build 6 part 2: live (real-money) Kalshi orders. Opt-in per owner message, approval every time, code limits, unlock-to-place.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, set } = await import('../src/db.js');
const vault = await import('../src/vault.js');
const live = await import('../src/live.js');
const { deps, runAgent, auto, decide, runWaiting } = await import('../src/agent.js');

const T = 'KXHIGHLAX-26NOV04-B71.5';
const posted = [];
let positions = [];
live.deps.market = async () => ({ ticker: T, title: 'LA high', bracket: '71-72', status: 'active', yes_bid: 0.68, yes_ask: 0.70, no_bid: 0.30, no_ask: 0.32 });
live.deps.portfolio = async () => ({ balance_usd: 14, positions });
live.deps.post = async (path, body) => { posted.push({ path, body }); return { order_id: 'o1', fill_count: body.count, average_fill_price: body.price, average_fee_paid: '0.0150' }; };
const usage = { input_tokens: 1, output_tokens: 1 };
const order = (input) => [{ stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'k' + Math.random(), name: 'kalshi_order', input }] }, { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'ok' }] }];
const script = (r) => { deps.client = { messages: { create: async () => r.shift() } }; };
const buyNo = { ticker: T, side: 'no', count: 10, limit_price: 0.32, reason: 'forecast 69' };

test('opt-in phrase: "live trading" or the Kalshi balance; nothing else', () => {
  for (const t of ['use live trading on the LA market', 'trade my Kalshi balance', 'whats my balance on kalshi, put it all in']) assert.ok(live.LIVE_RE.test(t), t);
  for (const t of ['paper trade the LA market', 'trade the LA high', 'what is my bank balance', 'kalshi markets today']) assert.ok(!live.LIVE_RE.test(t), t);
});

test('without the owner opting in, no order is even queued: paper is the default', async () => {
  vault.setup('correct horse battery');
  script(order(buyNo));
  await auto('trade the LA high market', { owner: true });
  assert.equal(db.prepare("select count(*) n from approvals where tool = 'kalshi_order'").get().n, 0);
  assert.match(db.prepare("select detail from activity where type = 'tool-error' order by id desc").get().detail, /Live trading is off.*paper_trade/);
  db.prepare("insert into chat (agent, role, content) values ('orchestrator', 'user', 'use live trading')").run();
  script(order(buyNo));
  await auto('ok buy it', { owner: true });
  assert.equal(db.prepare("select count(*) n from approvals where tool = 'kalshi_order'").get().n, 0, 'an earlier message does not carry over');
  script(order(buyNo));
  await runAgent('orchestrator', 'live trading please', 0, {}); // not from the owner's channel (e.g. a job)
  assert.equal(db.prepare("select count(*) n from approvals where tool = 'kalshi_order'").get().n, 0, 'only the owner\'s own messages count');
});

test('opted in: limits checked before queueing; order waits for approval with the real numbers', async () => {
  script(order({ ...buyNo, count: 40 }));
  await auto('live trading: buy NO on the LA high', { owner: true });
  assert.equal(db.prepare("select count(*) n from approvals where tool = 'kalshi_order'").get().n, 0, 'over the per-order cap: refused, not queued');
  set('live_max_total_usd', 5);
  positions = [{ ticker: 'OTHER', position: 5, exposure_usd: 2.5 }];
  script(order(buyNo));
  await auto('live trading: buy NO on the LA high', { owner: true });
  assert.match(db.prepare("select detail from activity where type = 'tool-error' order by id desc").get().detail, /capped at \$5/);
  set('live_max_total_usd', 14); positions = [];
  script(order(buyNo));
  await auto('live trading: buy NO on the LA high', { owner: true });
  const ap = db.prepare("select * from approvals where tool = 'kalshi_order' and status = 'pending'").get();
  assert.match(ap.reason, /REAL MONEY: buy 10 NO .* at \$0\.32 or better .* Up to \$3\.36 incl\. fee/);
  assert.equal(posted.length, 0, 'nothing sent to Kalshi before approval');
});

test('approved while locked: waits, then on unlock re-checks and places one IOC limit order (NO = sell YES at 1 − price)', async () => {
  const ap = db.prepare("select * from approvals where tool = 'kalshi_order' and status = 'pending'").get();
  vault.lock();
  assert.match(await decide(ap.id, true), /vault is locked/);
  assert.equal(db.prepare('select status from approvals where id = ?').get(ap.id).status, 'waiting_unlock');
  assert.equal(posted.length, 0);
  vault.unlock('correct horse battery');
  await runWaiting();
  assert.equal(posted.length, 1);
  assert.deepEqual(posted[0].body, { ticker: T, side: 'ask', count: '10.00', price: '0.6800', time_in_force: 'immediate_or_cancel', self_trade_prevention_type: 'taker_at_cross', client_order_id: posted[0].body.client_order_id });
  assert.equal(posted[0].path, '/portfolio/events/orders');
  const o = db.prepare('select * from live_orders').get();
  assert.equal(o.avg_price, 0.32); assert.equal(o.fill_count, 10);
  assert.equal(db.prepare('select status from approvals where id = ?').get(ap.id).status, 'approved');
});

test('waiting orders expire after 30 minutes without an unlock', async () => {
  db.prepare("insert into approvals (agent, tool, input, status, decided_at) values ('orchestrator', 'kalshi_order', ?, 'waiting_unlock', datetime('now', '-31 minutes'))").run(JSON.stringify(buyNo));
  posted.length = 0;
  await runWaiting();
  assert.equal(posted.length, 0);
  assert.equal(db.prepare("select status from approvals order by id desc").get().status, 'expired');
});
