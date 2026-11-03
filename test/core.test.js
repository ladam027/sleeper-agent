// Self-checks for the money/safety paths: budget math, budget cap, approval gate, kill switch, step limit.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const sysText = (c) => typeof c.system === 'string' ? c.system : c.system.map((b) => b.text).join('');

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
  fake([toolUse('create_agent', { name: 'helper', model: 'claude-haiku-4-5', purpose: 'help', daily_budget_usd: 1 }), text('asked')]);
  await runAgent('orchestrator', 'make a helper');
  assert.equal(db.prepare("select count(*) n from agents where name='helper'").get().n, 0);
  const ap = db.prepare("select id from approvals where status='pending'").get();
  assert.ok(ap);
  await decide(ap.id, true);
  assert.equal(db.prepare("select count(*) n from agents where name='helper'").get().n, 1);
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
  assert.equal(sysText(calls[0]), sysText(calls[1]), 'changing it mid-run invalidates Opus thinking blocks (400)');
  const next = fake([text('hi')]);
  await runAgent('orchestrator', 'hello');
  assert.match(sysText(next[0]), /Logan, 18/, 'the new pinned fact applies from the next message');
});

test('concise mode, effort and max reply length reach the API; a cut-off reply says so', async () => {
  reset();
  db.exec("update agents set concise = 1, effort = 'low', max_tokens = 2000 where name = 'orchestrator'");
  let calls = fake([text('ok')]);
  await runAgent('orchestrator', 'hi');
  assert.match(sysText(calls[0]), /Reply style: concise/);
  assert.equal(calls[0].output_config.effort, 'low');
  assert.equal(calls[0].max_tokens, 2000);

  db.exec("update agents set concise = 0, effort = 'medium', max_tokens = null where name = 'orchestrator'");
  calls = fake([{ stop_reason: 'max_tokens', usage, content: [{ type: 'text', text: 'partial' }] }]);
  assert.match(await runAgent('orchestrator', 'long please'), /partial[\s\S]*cut off at orchestrator's 16000-token limit/);
  assert.doesNotMatch(sysText(calls[0]), /Reply style: concise/);

  calls = fake([text('x')]);
  await runAgent('quick', 'hi');
  assert.equal(calls[0].output_config, undefined, 'Haiku gets no effort parameter');
  assert.equal(calls[0].max_tokens, 1024);
});

test('agents know their display names and their teammates', async () => {
  reset();
  const calls = fake([text('hi')]);
  await runAgent('orchestrator', 'who are you');
  assert.match(sysText(calls[0]), /Your name is James/);
  assert.match(sysText(calls[0]), /Pete, id quick/);
});

test('caching: stable prefix always cached; the conversation only within multi-step runs; history is limited', async () => {
  reset();
  for (let i = 0; i < 30; i++) db.prepare('insert into chat (agent, role, content) values (?, ?, ?)').run('orchestrator', i % 2 ? 'assistant' : 'user', `m${i}`);
  const calls = [];
  const replies = [toolUse('recall', { query: 'x' }), text('done')];
  deps.client = { messages: { create: async (p) => (calls.push(structuredClone(p)), replies.shift()) } };
  await runAgent('orchestrator', 'hello');
  assert.equal(calls[0].system[0].cache_control.type, 'ephemeral', 'stable prefix marked');
  assert.equal(calls[0].cache_control, undefined, 'first step: conversation not written to cache');
  assert.equal(calls[1].cache_control.type, 'ephemeral', 'later steps reuse it within seconds');
  assert.ok(calls[0].messages.length <= 13, `12 past messages + the new one (got ${calls[0].messages.length})`);
});

test('compression: older messages become memories + a short summary that leads the history', async () => {
  reset();
  const { compressThread, getSummary } = await import('../src/agent.js');
  set('history_limit', 6);
  for (let i = 0; i < 14; i++) db.prepare('insert into chat (agent, role, content) values (?, ?, ?)').run('orchestrator', i % 2 ? 'assistant' : 'user', i === 2 ? 'My econ midterm is Nov 14' : `msg ${i}`);
  const calls = [];
  const replies = [toolUse('remember', { title: 'Econ midterm', body: 'Nov 14', kind: 'fact' }), text('Owner is planning study time before the Nov 14 econ midterm.')];
  deps.client = { messages: { create: async (p) => (calls.push(structuredClone(p)), replies.shift()) } };
  assert.equal(await compressThread('orchestrator'), 'compressed');
  assert.equal(calls[0].model, 'claude-haiku-4-5', 'archivist runs on Haiku');
  assert.match(JSON.stringify(calls[0].messages), /econ midterm is Nov 14/);
  assert.equal(db.prepare("select body from memory where title = 'Econ midterm'").get().body, 'Nov 14');
  const s = getSummary('orchestrator');
  assert.match(s.text, /Nov 14 econ midterm/);
  assert.equal(await compressThread('orchestrator'), 'nothing to compress', 'already folded');

  const next = fake([text('ok')]);
  await runAgent('orchestrator', 'what should I study?');
  assert.match(next[0].messages[0].content, /^\[Summary of the earlier conversation/);
  assert.ok(next[0].messages.length <= 8, 'summary + 6 recent + the new message');
  set('history_limit', 12);
});

test('Pete can update the dashboard (clients, money, projects), knows what "the dashboard" means, and escalates instead of improvising', async () => {
  reset();
  const { auto } = await import('../src/agent.js');
  const calls = fake([toolUse('contact', { name: 'Raincross Pub', stage: 'lead' }), text('Added.')]);
  assert.equal(await auto('add Raincross Pub to my leads on the dashboard'), 'Added.');
  assert.equal(calls[0].model, 'claude-haiku-4-5');
  const names = calls[0].tools.map((t) => t.name);
  for (const t of ['contact', 'log_money', 'project', 'escalate']) assert.ok(names.includes(t), t);
  assert.match(sysText(calls[0]), /Clients tab = leads and clients: use contact/);
  assert.match(calls[0].tools.find((t) => t.name === 'escalate').description, /Never offer a workaround/);
  assert.equal(db.prepare("select count(*) n from contacts where name = 'Raincross Pub'").get().n, 1);
});
