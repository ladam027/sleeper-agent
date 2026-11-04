// Build 9: scheduled tasks run on their own, stay quiet when nothing is new, and respect per-run budgets.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { db, set } = await import('../src/db.js');
const tasks = await import('../src/tasks.js');
const { runAgent, deps } = await import('../src/agent.js');
set('timezone', 'America/Los_Angeles');

test('limits are enforced in code', () => {
  assert.throws(() => tasks.schedule({ title: 'x', instructions: 'y', repeat: 'every-minute' }), /repeat must be/);
  assert.throws(() => tasks.schedule({ title: 'x', instructions: 'y', max_usd: 5 }), /max_usd/);
  for (let i = 0; i < tasks.LIMITS.active; i++) tasks.schedule({ title: `t${i}`, instructions: 'y', when: '2030-01-01T08:00' });
  assert.throws(() => tasks.schedule({ title: 'one too many', instructions: 'y' }), /At most 12/);
  db.exec('delete from tasks');
});

test('due tasks run with their budget; news is sent, NOTHING NEW stays quiet; schedules advance', async () => {
  const runs = [], notes = [];
  const replies = ['LA high market moved to 61¢ on the 72° bracket.', 'NOTHING NEW', 'Done once.'];
  tasks.deps.run = async (agent, prompt, depth, opts) => (runs.push({ agent, prompt, opts }), replies.shift());
  tasks.deps.notify = async (u, text) => notes.push(text);
  tasks.schedule({ title: 'Watch LA high', instructions: 'Check the KXHIGHLAX market and report moves over 5¢.', when: '2026-11-03T08:00', repeat: 'hourly', max_usd: 0.2 });
  const now = new Date('2026-11-03T16:30:00Z'); // 08:30 in LA
  await tasks.tick(now);
  assert.equal(runs[0].opts.maxUsd, 0.2); assert.equal(runs[0].opts.ephemeral, true);
  assert.match(runs[0].prompt, /Your last report: \(first run\)/);
  assert.equal(notes.length, 1); assert.match(notes[0], /Watch LA high: LA high market moved/);
  assert.match(db.prepare("select content from chat order by id desc").get().content, /^\[Scheduled: Watch LA high\]/);
  let t = db.prepare('select * from tasks').get();
  assert.equal(t.local_time, '2026-11-03T09:00', 'hourly: next run in an hour'); assert.equal(t.runs, 1);
  await tasks.tick(new Date('2026-11-03T17:05:00Z'));
  assert.match(runs[1].prompt, /Your last report: LA high market moved/);
  assert.equal(notes.length, 1, 'NOTHING NEW: no message');
  t = db.prepare('select * from tasks').get();
  assert.match(t.last_result, /moved/, 'quiet runs keep the last real report');
  tasks.schedule({ title: 'Once', instructions: 'do it', when: '2026-11-03T09:00', repeat: 'once' });
  await tasks.tick(new Date('2026-11-03T17:10:00Z'));
  assert.equal(db.prepare("select status from tasks where title = 'Once'").get().status, 'done');
  assert.equal(tasks.setStatus(1, 'paused'), 'Task #1 "Watch LA high" paused.');
});

test('a run stops when its per-run budget is spent', async () => {
  const usage = { input_tokens: 200000, output_tokens: 1000 }; // ~$0.82 on Opus
  deps.client = { messages: { create: async () => ({ stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't' + Math.random(), name: 'recall', input: { query: 'x' } }] }) } };
  const r = await runAgent('orchestrator', 'expensive task', 0, { ephemeral: true, maxUsd: 0.5 });
  assert.match(r, /run's budget \(\$0\.5\) was reached/);
});
