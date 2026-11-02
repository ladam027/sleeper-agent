// Vault: encryption at rest, redaction before anything reaches the API.
process.env.DB_PATH = ':memory:';
process.env.VAULT_KEY = 'a'.repeat(64);
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.js');
const vault = await import('../src/vault.js');
const { deps, runAgent } = await import('../src/agent.js');

test('values are encrypted at rest and round-trip', () => {
  vault.save({ name: 'schwab', kind: 'password', value: 'hunter2-Secret!', username: 'logan' });
  const raw = db.prepare('select * from secrets').get();
  assert.ok(!Buffer.from(raw.data).toString('utf8').includes('hunter2'));
  assert.equal(vault.reveal('schwab').value, 'hunter2-Secret!');
  assert.deepEqual(vault.names().map((r) => ({ ...r })), [{ name: 'schwab', kind: 'password' }]);
  assert.equal(vault.resolve('pw={{secret:schwab}}'), 'pw=hunter2-Secret!');
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

test('bad names and kinds are rejected', () => {
  assert.throws(() => vault.save({ name: 'Bad Name', value: 'x' }));
  assert.throws(() => vault.save({ name: 'ok', kind: 'nope', value: 'x' }));
});
