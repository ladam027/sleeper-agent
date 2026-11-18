// Time saved (11.2.5): Pete estimates minutes per finished task in batches; tainted, tool-less, capped, clamped; off switch.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, set } = await import('../src/db.js');
const jobs = await import('../src/jobs.js');
const { stats } = await import('../src/stats.js');
const agentMod = await import('../src/agent.js');
const usage = { input_tokens: 100, output_tokens: 10 };

test('estimates finished top-level tasks once, clamps odd answers, skips its own runs, and can be turned off', async () => {
  const add = (req, status = 'done', parent = null) => Number(db.prepare('insert into runs (agent, parent, depth, request, status) values (?, ?, 0, ?, ?)').run('orchestrator', parent, req, status).lastInsertRowid);
  const a = add('Find 3 barbershops without websites'), b = add('hi'), c = add('Draft a proposal'), err = add('broken', 'error'), sub = add('sub-task', 'done', a);
  const seen = [];
  agentMod.deps.client = { messages: { create: async (p) => (seen.push(p), { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: `{"${a}":30,"${b}":0,"${c}":9999}` }] }) } };
  assert.equal(await jobs.estimateTimeSaved(), '3 estimated');
  assert.equal(seen[0].model, 'claude-haiku-4-5');
  assert.match(JSON.stringify(seen[0].messages), /untrusted_content source=\\"tasks/);
  const m = (id) => db.prepare('select minutes from runs where id = ?').get(id).minutes;
  assert.deepEqual([m(a), m(b), m(c), m(err), m(sub)], [30, 0, 240, null, null], 'clamped to 4 h; errors and sub-tasks skipped');
  assert.equal(await jobs.estimateTimeSaved(), 'none', "estimator's own run is never estimated");
  const t = stats('all').time;
  assert.equal(t.minutes, 270); assert.equal(t.tasks, 3); assert.equal(t.pending, 0);

  add('Write a menu page');
  agentMod.deps.client = { messages: { create: async () => ({ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'about ten minutes' }] }) } };
  await jobs.estimateTimeSaved();
  assert.equal(stats('all').time.pending, 0, 'an unreadable answer counts as 0 instead of retrying forever');

  set('time_saved', '0'); add('Plan a launch');
  assert.equal(await jobs.estimateTimeSaved(), 'off');
  assert.equal(stats('all').time.on, false);
});
