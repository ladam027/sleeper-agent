// Safe document reading (PDF/CSV/xlsx only, public internet only, no macros, size caps) and budget overrides.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { db, set } = await import('../src/db.js');
const docs = await import('../src/documents.js');
const { deps, runAgent, decide } = await import('../src/agent.js');
const { recordUsd } = await import('../src/budget.js');
const fx = (n) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url));

let served = {};
docs.deps.lookup = async (h) => [{ address: h === 'internal.example' ? '10.0.0.5' : h === 'tailnet.example' ? '100.95.126.110' : '93.184.216.34' }];
docs.deps.fetch = async (url) => {
  const r = served[url];
  if (!r) return { ok: false, status: 404, headers: new Headers() };
  if (r.redirect) return { ok: false, status: 302, headers: new Headers({ location: r.redirect }) };
  return { ok: true, status: 200, headers: new Headers({ 'content-type': r.type || 'application/octet-stream' }), body: [r.body] };
};

test('private, tailnet, metadata and non-https addresses are refused, including via redirect', async () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '100.95.126.110', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1']) assert.ok(docs.isPrivate(ip), ip);
  assert.ok(!docs.isPrivate('93.184.216.34'));
  await assert.rejects(docs.fetchDocument('http://example.com/a.pdf'), /https/);
  await assert.rejects(docs.fetchDocument('https://internal.example/a.pdf'), /public internet/);
  served['https://example.com/r.pdf'] = { redirect: 'https://tailnet.example/secret' };
  await assert.rejects(docs.fetchDocument('https://example.com/r.pdf'), /public internet/);
  await assert.rejects(docs.fetchDocument('https://169.254.169.254/latest/meta-data'), /public internet/);
});

test('type is decided by content: PDF, xlsx, CSV allowed; HTML and executables refused', async () => {
  served['https://example.com/report.pdf'] = { body: Buffer.from('%PDF-1.7 fake') };
  served['https://example.com/prices.xlsx'] = { body: fx('sample.xlsx') };
  served['https://example.com/data.csv'] = { body: Buffer.from('a,b\n1,2\n'), type: 'text/csv' };
  served['https://example.com/fake.pdf'] = { body: Buffer.from('<html><script>alert(1)</script>'), type: 'application/pdf' };
  served['https://example.com/tool.exe'] = { body: Buffer.from('MZ\x90\x00binary') };
  assert.equal((await docs.fetchDocument('https://example.com/report.pdf')).kind, 'pdf');
  const x = await docs.fetchDocument('https://example.com/prices.xlsx');
  assert.equal(x.text, '## Sheet: Prices\nItem,Price\nCoffee & bagel,6.5\n"Tea, large",,note\n');
  assert.equal((await docs.fetchDocument('https://example.com/data.csv')).text, 'a,b\n1,2\n');
  await assert.rejects(docs.fetchDocument('https://example.com/fake.pdf'), /Only PDF, CSV/);
  await assert.rejects(docs.fetchDocument('https://example.com/tool.exe'), /Only PDF, CSV/);
});

test('macro workbooks, zip bombs and oversized files are refused', async () => {
  assert.throws(() => docs.xlsxToText(fx('macro.xlsx')), /macros/);
  assert.throws(() => docs.xlsxToText(fx('bomb.xlsx')), /30 MB|maxOutputLength|buffer/i);
  served['https://example.com/huge.pdf'] = { body: Buffer.alloc(docs.MAX_BYTES + 1, 37) };
  await assert.rejects(docs.fetchDocument('https://example.com/huge.pdf'), /10 MB/);
});

test('Riley reads a PDF through the tool-less reader; the run becomes untrusted', async () => {
  served['https://example.com/fees.pdf'] = { body: Buffer.from('%PDF-1.7 Etsy fees 6.5%') };
  const usage = { input_tokens: 1, output_tokens: 1 }, calls = [];
  const script = {
    'claude-sonnet-5': [{ stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'd1', name: 'read_document', input: { url: 'https://example.com/fees.pdf', question: 'transaction fee?' } }] },
      { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Transaction fee is 6.5%.' }] }],
    'claude-haiku-4-5': [{ stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'The PDF says 6.5%.' }] }],
  };
  deps.client = { messages: { create: async (p) => (calls.push(structuredClone(p)), script[p.model].shift()) } };
  assert.equal(await runAgent('researcher', 'what is the etsy fee? read https://example.com/fees.pdf'), 'Transaction fee is 6.5%.');
  const reader = calls.find((c) => c.model === 'claude-haiku-4-5');
  assert.equal(reader.messages[0].content[0].type, 'document');
  assert.equal(reader.tools.length, 0, 'reader has no tools');
  assert.match(JSON.stringify(calls.at(-1).messages.at(-1)), /untrusted_content/);
});

test('hitting a limit asks for approval once; approving raises today\'s limit and resumes the task', async () => {
  db.exec('delete from approvals; delete from costs; delete from activity');
  set('global_daily_budget_usd', 1000); // isolate the per-agent limit
  recordUsd('quick', 'claude-haiku-4-5', 5); // Pete is over his $1
  const calls = [];
  deps.client = { messages: { create: async (p) => (calls.push(p), { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'Here are your reminders.' }] }) } };
  assert.match(await runAgent('quick', 'what are my reminders'), /asked the owner to approve more budget/);
  await runAgent('quick', 'again');
  const aps = db.prepare("select * from approvals where tool = 'raise_budget'").all();
  assert.equal(aps.length, 1, 'only one request per limit per day');
  assert.equal(JSON.parse(aps[0].input).resume.text, 'what are my reminders');
  assert.match(await decide(aps[0].id, true), /Resuming the task/);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1, 'the original task ran after approval');
  assert.ok(db.prepare("select count(*) n from activity where type = 'notify:high' and detail like 'Resumed task finished%'").get().n);
  db.exec('delete from approvals');
  recordUsd('quick', 'claude-haiku-4-5', 50);
  await runAgent('quick', 'x');
  const ap = db.prepare("select id from approvals where tool = 'raise_budget'").get();
  await decide(ap.id, false);
  await runAgent('quick', 'y');
  assert.equal(db.prepare("select count(*) n from approvals where tool = 'raise_budget'").get().n, 1, 'no new request after a denial today');
});
