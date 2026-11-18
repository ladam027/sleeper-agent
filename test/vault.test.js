// Vault: passphrase-only key (nothing on disk decrypts), encryption at rest, redaction before anything reaches the API.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.js');
const vault = await import('../src/vault.js');
const { deps, runAgent } = await import('../src/agent.js');
const PASS = 'correct horse battery';

test('locked until a passphrase is set; nothing works without it', () => {
  assert.deepEqual({ ...vault.status() }, { setup: false, unlocked: false, items: 0, locks_at: null, idle_hours: 1 });
  assert.throws(() => vault.save({ name: 'x', value: 'y' }), /locked/);
  assert.throws(() => vault.setup('short'), /12 characters/);
  vault.setup(PASS);
  assert.equal(vault.status().unlocked, true);
  assert.throws(() => vault.setup(PASS), /already/);
});

test('values are encrypted at rest; the key is not stored anywhere on disk', () => {
  vault.save({ name: 'schwab', kind: 'password', value: 'hunter2-Secret!', username: 'alex' });
  const raw = db.prepare('select * from secrets').get();
  assert.ok(!Buffer.from(raw.data).toString('utf8').includes('hunter2'));
  const settings = JSON.stringify(db.prepare('select * from settings').all());
  assert.ok(!settings.includes(PASS), 'passphrase not stored');
  assert.equal(vault.reveal('schwab').value, 'hunter2-Secret!');
  assert.deepEqual(vault.names().map((r) => ({ ...r })), [{ name: 'schwab', kind: 'password' }]);
  assert.equal(vault.resolve('pw={{secret:schwab}}'), 'pw=hunter2-Secret!');
});

test('lock wipes the key; wrong passphrase fails; right one unlocks', () => {
  vault.lock();
  assert.throws(() => vault.reveal('schwab'), /locked/);
  assert.equal(vault.list(true)[0].summary, undefined, 'no details while locked');
  assert.throws(() => vault.unlock('wrong passphrase!!'), /Wrong passphrase/);
  vault.unlock(PASS);
  assert.equal(vault.reveal('schwab').value, 'hunter2-Secret!');
  assert.throws(() => vault.unlock('wrong passphrase!!'), /Wrong passphrase/, 'still checked when already unlocked');
});

test('list shows a summary only for a passphrase session', () => {
  assert.equal(vault.list(false)[0].summary, undefined);
  assert.equal(vault.list(true)[0].summary, 'alex');
});

test('redact scrubs vault values, card numbers, SSNs, but leaves normal numbers', () => {
  const out = vault.redact('pw hunter2-Secret! card 4242 4242 4242 4242 ssn 123-45-6789 order 1234567890123');
  assert.equal(out, 'pw {{secret:schwab}} card [card number removed] ssn [SSN removed] order 1234567890123');
});

test('nothing sensitive reaches the API: message, history, system prompt, tool results', async () => {
  vault.save({ name: 'home-address', kind: 'personal', value: '42 Wallaby Way' });
  db.prepare('insert into memory (title, body, pinned) values (?, ?, 1)').run('Home', 'Lives at 42 Wallaby Way');
  db.prepare('insert into chat (agent, role, content) values (?, ?, ?)').run('orchestrator', 'user', 'old msg with hunter2-Secret!');
  db.prepare('insert into chat (agent, role, content) values (?, ?, ?)').run('orchestrator', 'assistant', 'ok');
  const sent = [];
  const usage = { input_tokens: 1, output_tokens: 1 };
  const replies = [
    { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't1', name: 'recall', input: { query: 'Home' } }] },
    { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'done' }] },
  ];
  deps.client = { messages: { create: async (p) => (sent.push(JSON.stringify(p)), replies.shift()) } };
  await runAgent('orchestrator', 'my card is 4242424242424242 and pw hunter2-Secret!');
  const all = sent.join('\n');
  for (const bad of ['hunter2', '4242424242424242', 'Wallaby']) assert.ok(!all.includes(bad), `${bad} leaked`);
  assert.ok(!db.prepare("select group_concat(content) c from chat where id > 2").get().c.includes('hunter2'), 'saved history is redacted');
});

test('cards keep expiry/CVV encrypted; the summary shows only the last 4 digits', () => {
  vault.save({ name: 'visa', kind: 'card', value: '4111 1111 1111 1111', username: 'Alex Rivera', expiry: '12/29', cvv: '123' });
  assert.equal(vault.list(true).find((i) => i.name === 'visa').summary, 'Alex Rivera · •••• 1111 · exp 12/29');
  assert.ok(!JSON.stringify(vault.list(true)).includes('4111 1111'));
  assert.equal(vault.reveal('visa').cvv, '123');
  assert.throws(() => vault.save({ name: 'bad', kind: 'card', value: '4111111111111111', expiry: '13/29' }), /MM\/YY/);
  assert.throws(() => vault.save({ name: 'Bad Name', value: 'x' }));
});

test('auto-locks after an hour without use; every key use restarts the hour', () => {
  let t = Date.now();
  vault.deps.now = () => t;
  vault.unlock(PASS);
  t += 50 * 60e3;
  assert.equal(vault.reveal('schwab').value, 'hunter2-Secret!', 'used at 50 min: hour restarts');
  t += 50 * 60e3;
  assert.equal(vault.ready(), true, '100 min after unlock but only 50 since last use');
  assert.match(vault.status().locks_at, /^\d{4}-/);
  t += 61 * 60e3;
  assert.equal(vault.ready(), false, 'an hour with no use: locked');
  assert.throws(() => vault.reveal('schwab'), /locked/);
  assert.equal(vault.redact('pw hunter2-Secret!'), 'pw hunter2-Secret!', 'saved values cannot be matched while locked (card/SSN patterns still apply)');
  vault.deps.now = () => Date.now();
  vault.unlock(PASS);
});

test('owner can choose a longer idle lock; only listed values are accepted', () => {
  let t = Date.now();
  vault.deps.now = () => t;
  vault.unlock(PASS);
  assert.throws(() => vault.setIdleHours(1000), /Choose 1, 4, 8, 24/);
  vault.setIdleHours(8);
  t += 7 * 3600e3;
  assert.equal(vault.ready(), true, '7 h idle with an 8 h lock: still open');
  assert.equal(vault.status().idle_hours, 8);
  t += 61 * 60e3;
  assert.equal(vault.ready(), false, 'past 8 h idle: locked');
  vault.setIdleHours(1);
  vault.deps.now = () => Date.now();
  vault.unlock(PASS);
});
