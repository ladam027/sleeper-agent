// Statistics: per-agent usage, cost breakdown, and insights with one-click fixes.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.js');
const { stats } = await import('../src/stats.js');
const { today } = await import('../src/budget.js');

test('breakdown splits spend into input, cache write/read, output and web; insights rank savings', () => {
  const ins = db.prepare('insert into costs (day, agent, model, input, output, cache_read, cache_write, usd) values (?, ?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 10; i++) ins.run(today(), 'orchestrator', 'claude-opus-5-5', 100, 2000, 10000, 9000, (100 * 4 + 2000 * 20 + 10000 * 0.2 + 9000 * 5) / 1e6);
  ins.run(today(), 'researcher', 'claude-sonnet-5', 20000, 2000, 100000, 20000, (20000 * 2 + 2000 * 10 + 100000 * 0.2 + 20000 * 2.5) / 1e6 + 0.03);
  db.exec("insert into costs (day, agent, model, usd) values ('" + today() + "', 'phone', 'telnyx-call', 0.01)");
  const s = stats('today');
  assert.equal(s.calls, 12);
  assert.equal(s.agents[0].agent, 'orchestrator');
  assert.ok(Math.abs(s.breakdown.web_search - 0.03) < 1e-9, 'web search remainder detected');
  assert.ok(Math.abs(s.breakdown.phone - 0.01) < 1e-9);
  const titles = s.insights.map((t) => t.title);
  assert.ok(titles.includes('Cache writes are a big share of spend'));
  const effort = s.insights.find((t) => t.apply?.body?.effort === 'low');
  assert.deepEqual(effort.apply, { kind: 'agent', agent: 'orchestrator', body: { effort: 'low' }, label: 'Set James to low effort' });
  assert.ok(s.insights.every((t, i, a) => i === 0 || a[i - 1].saves >= t.saves), 'biggest savings first');
  assert.ok(s.projected_month > 0);
});

test('not enough data gives a friendly message instead of guesses', () => {
  db.exec('delete from costs');
  assert.equal(stats('7d').insights[0].title, 'Not enough data yet');
});
