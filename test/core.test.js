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
db.exec("update agents set flex_min = '' where name = 'orchestrator'"); // these tests assume a fixed model; flexibility is tested separately

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
  reset(); fake([toolUse('remember', { title: 'Owner name', body: 'Alex', pinned: true }), text('saved')]);
  await runAgent('orchestrator', 'my name is Alex');
  assert.equal(db.prepare('select body from memory').get().body, 'Alex');
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
  db.prepare("insert into memory (kind, title, body) values ('person', 'Me - The User', 'Alex Rivera')").run();
  assert.match(TOOLS.recall.run({ query: 'owner name' }), /Alex Rivera/);
  assert.match(TOOLS.recall.run({ query: 'person' }), /Alex Rivera/);
  assert.match(TOOLS.recall.run({}), /Alex Rivera/);
  db.exec('delete from memory');
  assert.match(TOOLS.recall.run({ query: 'x' }), /Memory is empty/);
});

test('auto mode: simple question stays on Haiku, heavy request goes to Opus, escalation hands off', async () => {
  reset();
  const { auto, isHeavy } = await import('../src/agent.js');
  assert.equal(isHeavy('what is my name'), false);
  assert.equal(isHeavy('plan my week around the Etsy launch'), true);

  let calls = fake([text('Alex')]);
  assert.equal(await auto('what is my name'), 'Alex');
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

test('follow-ups to James stay with James; a fresh question still goes to Pete; vault-asking replies hand off', async () => {
  reset();
  const { auto, CANT } = await import('../src/agent.js');
  let calls = fake([text('Plan ready')]);
  await auto('plan my week around the Etsy launch');
  calls = fake([text('Done')]);
  await auto('add the car now');
  assert.equal(calls[0].model, 'claude-opus-5-5', 'short instruction right after James answered');
  calls = fake([text('Alex')]);
  await auto('what is my name?');
  assert.equal(calls[0].model, 'claude-haiku-4-5', 'a new question is still cheap');
  for (const t of ["I see the car-details in your vault, but I can't read it", 'You need to pull the details from the vault and give me the VIN']) assert.ok(CANT.test(t), t);
});

test('system prompt stays identical within a run even when a tool edits a pinned memory', async () => {
  reset();
  const calls = fake([toolUse('remember', { title: 'Owner profile', body: 'Alex, 30', pinned: true }), text('saved')]);
  assert.equal(await runAgent('orchestrator', 'here is my profile'), 'saved');
  assert.equal(calls.length, 2);
  assert.equal(sysText(calls[0]), sysText(calls[1]), 'changing it mid-run invalidates Opus thinking blocks (400)');
  const next = fake([text('hi')]);
  await runAgent('orchestrator', 'hello');
  assert.match(sysText(next[0]), /Alex, 30/, 'the new pinned fact applies from the next message');
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

test('cost: James defers specialist tools behind tool search, caches 1h; Pete sends no cache markers', async () => {
  reset();
  const calls = [];
  const srv = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'kalshi' } };
  const replies = [{ stop_reason: 'end_turn', usage, content: [srv, { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [] } }, { type: 'text', text: 'ok' }] }, text('hi')];
  deps.client = { messages: { create: async (p) => (calls.push(structuredClone(p)), replies.shift()) } };
  await runAgent('orchestrator', 'markets?');
  const t = calls[0].tools;
  const search = t.find((x) => x.type === 'tool_search_tool_bm25_20251119');
  assert.ok(search && !search.defer_loading, 'search tool present, never deferred');
  for (const k of ['recall', 'remember', 'delegate']) assert.ok(!t.find((x) => x.name === k).defer_loading, `${k} stays loaded`);
  assert.equal(t.find((x) => x.name === 'kalshi_markets').defer_loading, true, 'specialist tool deferred');
  assert.ok(!t.some((x) => x.defer_loading && x.cache_control), 'no cache_control on deferred tools');
  assert.deepEqual(calls[0].system[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.equal(db.prepare("select count(*) n from activity where type in ('web','tainted')").get().n, 0, 'tool search is not web content');
  await runAgent('quick', 'what is my name');
  assert.equal(calls[1].system[0].cache_control, undefined, 'Pete: no prefix cache');
  assert.equal(calls[1].cache_control, undefined);
  assert.ok(!calls[1].tools.some((x) => x.defer_loading), 'small toolsets load normally');
});

test('recall clips long memories unless asked for by title', async () => {
  reset();
  const { TOOLS } = await import('../src/tools.js');
  const big = 'x'.repeat(3000);
  db.prepare('insert into memory (title, body) values (?, ?), (?, ?)').run('Website design spec', `design ${big}`, 'Design note', 'short design note');
  const many = JSON.parse(await TOOLS.recall.run({ query: 'design' }));
  assert.ok(many.find((m) => m.title === 'Website design spec').body.length < 1000, 'clipped among many');
  const one = JSON.parse(await TOOLS.recall.run({ query: 'website design spec' }));
  assert.ok(one.find((m) => m.title === 'Website design spec').body.length > 3000, 'full by title');
});

test('long earlier messages are clipped in history; the new message is sent in full', async () => {
  reset();
  const long = 'spec '.repeat(1000);
  db.prepare('insert into chat (agent, role, content) values (?, ?, ?), (?, ?, ?)').run('orchestrator', 'user', long, 'orchestrator', 'assistant', 'ok');
  const calls = fake([text('done')]);
  await runAgent('orchestrator', long);
  const [old, , now] = calls[0].messages;
  assert.ok(old.content.length < 1700 && old.content.includes('clipped'), 'earlier paste clipped');
  assert.ok(now.content.includes(long.trim()), 'new message intact');
  assert.equal(db.prepare('select length(content) n from chat where id = (select min(id) from chat)').get().n, long.length, 'full text kept in chat');
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

test('Auto: a specialist "I can\'t" never reaches the owner; the right agent answers instead', async () => {
  reset();
  const { auto, CANT } = await import('../src/agent.js');
  for (const t of ["I don't have a dashboard tool to add contacts, that's James's job.", "I can't send emails.", 'Ask James to do that.', "I'm unable to post that."]) assert.ok(CANT.test(t), t);
  for (const t of ["I couldn't find any reminders for today.", "You don't have any approvals waiting.", 'James is your orchestrator.', "I can't wait to see it launch!"]) assert.ok(!CANT.test(t), t);

  const calls = [];
  const replies = [text("Sorry, I can't create projects. That's James's job."), text('Created the Etsy project.')];
  deps.client = { messages: { create: async (p) => (calls.push(p), replies.shift()) } };
  assert.equal(await auto('add an etsy project'), 'Created the Etsy project.');
  assert.deepEqual(calls.map((c) => c.model), ['claude-haiku-4-5', 'claude-opus-5-5']);
  const saved = db.prepare("select content from chat where agent = 'orchestrator' and role = 'assistant'").all().map((r) => r.content);
  assert.deepEqual(saved, ['Created the Etsy project.'], "Pete's refusal was never saved or shown");
});

test('Auto: website work goes straight to Mia; mixed requests go to James', async () => {
  reset();
  const { auto } = await import('../src/agent.js');
  let calls = fake([text('Draft saved.')]);
  await auto('design a website for Corner Bakery');
  assert.equal(calls[0].model, 'claude-sonnet-5');
  assert.match(sysText(calls[0]), /Your name is Mia/);
  assert.ok(calls[0].tools.some((t) => t.name === 'escalate'), 'Mia can hand up too');
  calls = fake([text('On it.')]);
  await auto('build a website for Corner Bakery and email it to Dana');
  assert.equal(calls[0].model, 'claude-opus-5-5');
});

test('capabilities come from the live registry: per-agent tools, approval flags', async () => {
  const { capabilities, TOOLS } = await import('../src/tools.js');
  const c = capabilities();
  assert.ok(c.agents.find((a) => a.name === 'designer').tools.includes('save_site'));
  assert.equal(c.tools.publish_site.approval, true);
  assert.equal(c.tools.recall.approval, false);
  assert.ok(!('raise_budget' in c.tools), 'hidden internal tools are not listed');
  assert.match(await TOOLS.list_capabilities.run({}), /Mia \(designer/);
});

test('runs: each task is recorded with steps, tokens, cost and status; sub-agent work links to it', async () => {
  reset();
  const replies = [toolUse('delegate', { agent: 'quick', task: 'say hi' }), text('hi from Pete'), text('All done')];
  fake(replies);
  await runAgent('orchestrator', 'please delegate a greeting');
  const top = db.prepare("select * from runs where parent is null order by id desc limit 1").get();
  const child = db.prepare('select * from runs where parent = ?').get(top.id);
  assert.equal(top.agent, 'orchestrator'); assert.equal(top.status, 'done'); assert.equal(top.steps, 2);
  assert.equal(child.agent, 'quick'); assert.equal(child.depth, 1); assert.equal(child.steps, 1);
  assert.ok(top.ms >= 0 && top.usd > 0);
  assert.ok(db.prepare("select count(*) n from activity where run_id = ? and type = 'tool'").get(top.id).n >= 1, 'log lines carry the run');
  assert.equal(db.prepare('select count(*) n from costs where run_id = ?').get(child.id).n, 1, 'child costs carry the child run');
});

test('streaming: text pieces reach the dashboard as they are written; the run is recorded as usual', async () => {
  reset();
  const pieces = [];
  deps.client = { messages: {
    create: async () => { throw new Error('should stream'); },
    stream: () => { const h = {}; return { on: (ev, fn) => { h[ev] = fn; }, finalMessage: async () => { ['Hel', 'lo ', 'there'].forEach((d) => h.text?.(d)); return text('Hello there'); } }; },
  } };
  assert.equal(await runAgent('orchestrator', 'hi', 0, { onText: (d) => pieces.push(d) }), 'Hello there');
  assert.deepEqual(pieces, ['Hel', 'lo ', 'there']);
  assert.equal(db.prepare("select status from runs order by id desc limit 1").get().status, 'done');
});

test('memory index: titles reach the agent after the cached prefix, so new memories do not bust the cache', async () => {
  reset();
  db.prepare("insert into memory (title, body) values ('Email to ryan@example.com: Greetings, human', 'sent')").run();
  let calls = fake([text('ok')]);
  await runAgent('orchestrator', 'hi');
  const [cached, idx] = calls[0].system;
  assert.ok(cached.cache_control && !idx.cache_control);
  assert.match(idx.text, /Email to ryan@example\.com: Greetings, human/);
  db.prepare("insert into memory (title, body) values ('Car: 2024 sedan', 'x')").run();
  calls = fake([text('ok')]);
  await runAgent('orchestrator', 'hi again');
  assert.equal(calls[0].system[0].text, cached.text, 'cached prefix unchanged by a new memory');
  assert.match(calls[0].system[1].text, /Car: 2024 sedan/);
});

test('flexibility: routine work on the cheaper model, hard work on the stronger one; the agent can step up itself', async () => {
  reset();
  const { pickModel, auto } = await import('../src/agent.js');
  db.exec("update agents set flex_min = 'claude-sonnet-5' where name = 'orchestrator'");
  const james = db.prepare("select * from agents where name = 'orchestrator'").get();
  assert.equal(pickModel(james, 'add the car now'), 'claude-sonnet-5');
  assert.equal(pickModel(james, 'plan my week around the launch'), 'claude-opus-5-5');
  assert.equal(pickModel(james, 'think hard about this'), 'claude-opus-5-5');
  assert.equal(pickModel(james, 'x'.repeat(2000)), 'claude-opus-5-5', 'long requests');
  assert.equal(pickModel({ ...james, flex_min: '' }, 'hi'), 'claude-opus-5-5', 'off = always its model');
  // step up: Sonnet calls use_stronger_model before acting; the request re-runs on Opus
  const calls = fake([toolUse('use_stronger_model', { reason: 'needs a multi-step plan' }), text('Opus answer')]);
  assert.equal(await runAgent('orchestrator', 'help me with my wedding seating'), 'Opus answer');
  assert.deepEqual(calls.map((c) => c.model), ['claude-sonnet-5', 'claude-opus-5-5']);
  assert.ok(calls[0].tools.some((t) => t.name === 'use_stronger_model' && !t.defer_loading), 'offered (and loaded) on the cheaper model');
  assert.ok(!calls[1].tools.some((t) => t.name === 'use_stronger_model'), 'not offered once on the strongest');
  // follow-ups still stay with James when he answered on Sonnet
  fake([text('Sonnet reply')]); await auto('remind me what you said');
  const c2 = fake([text('ok')]); await auto('try again');
  assert.notEqual(c2[0].model, 'claude-haiku-4-5', 'follow-up to a Sonnet James answer stays with James');
  db.exec("update agents set flex_min = '' where name = 'orchestrator'");
});
