// Self-checks for the money/safety paths: budget math, budget cap, approval gate, kill switch, step limit.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, set } = await import('../src/db.js');
const { costOf, record } = await import('../src/budget.js');
const { deps, runAgent, kill, restart, decide } = await import('../src/agent.js');

// Fake client: replays scripted responses, records requests.
function fake(responses) {
  const calls = [];
  deps.client = { messages: { create: async (params) => { calls.push(params); return responses.shift() ?? responses.last; } } };
  return calls;
}
const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const text = (t) => ({ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: t }] });
const toolUse = (name, input) => ({ stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'tu_' + Math.random(), name, input }] });
const reset = () => { db.exec("delete from costs; delete from approvals; delete from chat; delete from memory; update agents set status='idle'"); set('global_halt', 0); };

test('cost math matches price table', () => {
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 24);
  assert.equal(costOf('claude-haiku-4-5', { cache_read_input_tokens: 1e6 }), 0.1);
  assert.throws(() => costOf('gpt-nope', {}));
});

test('plain reply is saved to history and costed', async () => {
  reset(); fake([text('hello')]);
  assert.equal(await runAgent('orchestrator', 'hi'), 'hello');
  assert.equal(db.prepare('select count(*) n from chat').get().n, 2);
  assert.ok(db.prepare('select sum(usd) s from costs').get().s > 0);
});

test('memory tool round-trips', async () => {
  reset(); fake([toolUse('remember', { title: 'Owner name', body: 'Logan', pinned: true }), text('saved')]);
  await runAgent('orchestrator', 'my name is Logan');
  assert.equal(db.prepare('select body from memory').get().body, 'Logan');
});

test('high-risk tool is queued, not executed, until approved', async () => {
  reset();
  fake([toolUse('create_agent', { name: 'researcher', model: 'claude-haiku-4-5', purpose: 'research', daily_budget_usd: 1 }), text('asked')]);
  await runAgent('orchestrator', 'make a researcher');
  assert.equal(db.prepare("select count(*) n from agents where name='researcher'").get().n, 0);
  const ap = db.prepare("select id from approvals where status='pending'").get();
  assert.ok(ap);
  await decide(ap.id, true);
  assert.equal(db.prepare("select count(*) n from agents where name='researcher'").get().n, 1);
  assert.equal(await decide(ap.id, true), null, 'cannot approve twice');
});

test('daily budget blocks further calls', async () => {
  reset(); const calls = fake([text('x')]);
  record('orchestrator', 'claude-opus-5-5', { input_tokens: 1e6 }); // $4 > $3 cap
  assert.match(await runAgent('orchestrator', 'hi'), /daily budget/);
  assert.equal(calls.length, 0);
});

test('kill switch and per-agent kill stop runs; restart revives', async () => {
  reset(); const calls = fake([text('x'), text('x')]);
  set('global_halt', 1);
  assert.match(await runAgent('orchestrator', 'hi'), /kill switch/);
  set('global_halt', 0);
  kill('orchestrator');
  assert.match(await runAgent('orchestrator', 'hi'), /killed/);
  restart('orchestrator');
  assert.equal(await runAgent('orchestrator', 'hi'), 'x');
  assert.equal(calls.length, 1);
});

test('runaway tool loop stops at step limit', async () => {
  reset(); const r = toolUse('recall', { query: 'x' }); const calls = fake([]); deps.client.messages.create = async (p) => (calls.push(p), r);
  assert.match(await runAgent('orchestrator', 'loop'), /step limit/);
  assert.equal(calls.length, 8);
});

test('sub-agents cannot use orchestrator-only tools', async () => {
  reset();
  db.exec("insert or ignore into agents (name, model, purpose) values ('worker', 'claude-haiku-4-5', 'w')");
  const calls = fake([toolUse('create_agent', { name: 'evil', model: 'claude-haiku-4-5', purpose: 'x', daily_budget_usd: 5 }), text('done')]);
  await runAgent('worker', 'escalate', 1);
  assert.ok(!calls[0].tools.some((t) => t.name === 'create_agent'));
  assert.equal(db.prepare("select count(*) n from approvals").get().n, 0);
});

test('recall never reports empty when memories exist (synonyms, empty query)', async () => {
  reset();
  const { TOOLS } = await import('../src/tools.js');
  db.prepare("insert into memory (kind, title, body) values ('person', 'Me - The User', 'Logan Adams')").run();
  assert.match(TOOLS.recall.run({ query: 'owner name' }), /Logan Adams/);
  assert.match(TOOLS.recall.run({ query: 'person' }), /Logan Adams/);
  assert.match(TOOLS.recall.run({}), /Logan Adams/);
  db.exec('delete from memory');
  assert.match(TOOLS.recall.run({ query: 'x' }), /Memory is empty/);
});

test('auto mode: simple question stays on Haiku, heavy request goes to Opus, escalation hands off', async () => {
  reset();
  const { auto, isHeavy } = await import('../src/agent.js');
  assert.equal(isHeavy('what is my name'), false);
  assert.equal(isHeavy('plan my week around the Etsy launch'), true);

  let calls = fake([text('Logan')]);
  assert.equal(await auto('what is my name'), 'Logan');
  assert.equal(calls[0].model, 'claude-haiku-4-5');
  assert.ok(calls[0].tools.some((t) => t.name === 'escalate'));
  assert.ok(!calls[0].tools.some((t) => t.name === 'create_agent'), 'quick agent has a restricted tool set');

  calls = fake([text('plan')]);
  await auto('plan my week around the Etsy launch');
  assert.equal(calls[0].model, 'claude-opus-5-5');

  calls = fake([toolUse('escalate', { reason: 'needs judgment' }), text('deep answer')]);
  assert.equal(await auto('should I quit my job'), 'deep answer');
  assert.deepEqual(calls.map((c) => c.model), ['claude-haiku-4-5', 'claude-opus-5-5']);
  const rows = db.prepare("select role, model from chat where agent = 'orchestrator' order by id").all();
  assert.equal(rows.filter((r) => r.role === 'assistant').at(-1).model, 'claude-opus-5-5', 'one shared thread, records who answered');
  assert.equal(rows.length, 6, 'escalated attempt is not saved twice');
});

test('system prompt stays identical within a run even when a tool edits a pinned memory', async () => {
  reset();
  const calls = fake([toolUse('remember', { title: 'Owner profile', body: 'Logan, 18', pinned: true }), text('saved')]);
  assert.equal(await runAgent('orchestrator', 'here is my profile'), 'saved');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].system, calls[1].system, 'changing it mid-run invalidates Opus thinking blocks (400)');
  const next = fake([text('hi')]);
  await runAgent('orchestrator', 'hello');
  assert.match(next[0].system, /Logan, 18/, 'the new pinned fact applies from the next message');
});

test('concise mode, effort and max reply length reach the API; a cut-off reply says so', async () => {
  reset();
  db.exec("update agents set concise = 1, effort = 'low', max_tokens = 2000 where name = 'orchestrator'");
  let calls = fake([text('ok')]);
  await runAgent('orchestrator', 'hi');
  assert.match(calls[0].system, /Reply style: concise/);
  assert.equal(calls[0].output_config.effort, 'low');
  assert.equal(calls[0].max_tokens, 2000);

  db.exec("update agents set concise = 0, effort = 'medium', max_tokens = null where name = 'orchestrator'");
  calls = fake([{ stop_reason: 'max_tokens', usage, content: [{ type: 'text', text: 'partial' }] }]);
  assert.match(await runAgent('orchestrator', 'long please'), /partial[\s\S]*cut off at orchestrator's 16000-token limit/);
  assert.doesNotMatch(calls[0].system, /Reply style: concise/);

  calls = fake([text('x')]);
  await runAgent('quick', 'hi');
  assert.equal(calls[0].output_config, undefined, 'Haiku gets no effort parameter');
  assert.equal(calls[0].max_tokens, 1024);
});
