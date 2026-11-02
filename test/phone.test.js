// Build 2: Twilio texts/calls, quiet hours, reminders, SMS approvals. No network: fetch and the model are faked.
process.env.DB_PATH = ':memory:';
Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'tok_test', TWILIO_FROM: '+15550000001', OWNER_PHONE: '+15550000002' });
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const { db, set } = await import('../src/db.js');
const phone = await import('../src/phone.js');
const sched = await import('../src/scheduler.js');
const { handleSms } = await import('../src/sms.js');
const agentMod = await import('../src/agent.js');

let sent = [];
phone.deps.fetch = async (url, opts) => { sent.push({ url, params: Object.fromEntries(new URLSearchParams(opts.body)) }); return { ok: true, json: async () => ({}) }; };
const reset = () => { sent = []; db.exec("delete from activity; delete from reminders; delete from approvals; delete from costs"); set('timezone', 'America/Los_Angeles'); set('quiet_start', '00:00'); set('quiet_end', '07:00'); };
const at = (iso) => new Date(iso); // UTC instants

test('Twilio signature: valid passes, tampered or missing fails', () => {
  const url = 'https://me.ts.net/twilio/sms', params = { From: '+15550000002', Body: 'hi' };
  const sig = createHmac('sha1', 'tok_test').update(url + 'Bodyhi' + 'From+15550000002').digest('base64');
  assert.ok(phone.validSignature(url, params, sig));
  assert.ok(!phone.validSignature(url, { ...params, Body: 'Y 1 0000' }, sig));
  assert.ok(!phone.validSignature(url, params, undefined));
});

test('quiet hours in the owner timezone, including windows across midnight', () => {
  reset();
  assert.equal(phone.inQuietHours(at('2026-11-03T10:00:00Z')), true, '2am Pacific');
  assert.equal(phone.inQuietHours(at('2026-11-03T16:00:00Z')), false, '8am Pacific');
  set('quiet_start', '22:00'); set('quiet_end', '07:00');
  assert.equal(phone.inQuietHours(at('2026-11-03T06:30:00Z')), true, '10:30pm Pacific');
});

test('local time → UTC is right on both sides of a DST change', () => {
  assert.equal(sched.localToUtc('2026-11-01T00:30', 'America/Los_Angeles').toISOString(), '2026-11-01T07:30:00.000Z', 'PDT');
  assert.equal(sched.localToUtc('2026-11-02T06:30', 'America/Los_Angeles').toISOString(), '2026-11-02T14:30:00.000Z', 'PST');
  assert.equal(sched.localToUtc('2026-07-01T09:00', 'America/New_York').toISOString(), '2026-07-01T13:00:00.000Z');
  assert.equal(sched.nextLocal('2026-11-06T06:30', 'weekdays'), '2026-11-09T06:30', 'Friday → Monday');
  assert.throws(() => sched.localToUtc('tomorrow 6am', 'UTC'));
});

test('notify routes by urgency; calls become texts in quiet hours unless it is an alarm', async () => {
  reset();
  set('quiet_start', '00:00'); set('quiet_end', '00:00'); // never quiet
  await phone.notify('critical', 'server down');
  assert.deepEqual(sent.map((s) => s.url.split('/').pop()), ['Calls.json', 'Messages.json']);
  assert.equal(sent[1].params.To, '+15550000002');
  assert.match(sent[0].params.Twiml, /server down/);

  sent = []; set('quiet_start', '00:00'); set('quiet_end', '23:59'); // always quiet
  assert.match(await phone.notify('critical', 'late night'), /quiet hours, so no call, texted/);
  assert.deepEqual(sent.map((s) => s.url.split('/').pop()), ['Messages.json']);
  sent = [];
  await phone.notify('critical', 'wake up', { alarm: true });
  assert.equal(sent[0].url.split('/').pop(), 'Calls.json', 'owner-set alarms ring anyway');

  sent = [];
  assert.match(await phone.notify('low', 'fyi'), /dashboard/);
  assert.equal(sent.length, 0);
  assert.ok(db.prepare("select sum(usd) s from costs where agent = 'phone'").get().s > 0, 'Twilio spend is in the cost ledger');
});

test('daily caps stop a loop from texting forever', async () => {
  reset();
  for (let i = 0; i < phone.CAPS.sms; i++) await phone.sms('x');
  await assert.rejects(phone.sms('one too many'), /cap/);
});

test('reminders fire once, repeating ones roll forward keeping wall-clock time', async () => {
  reset();
  const future = sched.localNow('America/Los_Angeles').slice(0, 10) + 'T23:59';
  assert.match(sched.addReminder({ message: 'call mom', when: future, channel: 'sms' }), /Reminder #\d+ set/);
  assert.throws(() => sched.addReminder({ message: 'x', when: '2020-01-01T00:00' }), /past/);
  db.exec("update reminders set due_at = '2000-01-01T00:00:00.000Z'");
  await sched.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].params.Body, /Reminder: call mom/);
  assert.equal(db.prepare('select status from reminders').get().status, 'done');

  reset();
  sched.addReminder({ message: 'gym', when: future, channel: 'dashboard', repeat: 'daily' });
  db.exec("update reminders set due_at = '2000-01-01T00:00:00.000Z', local_time = '2026-11-02T06:30'");
  await sched.tick(at('2026-11-02T15:00:00Z'));
  const r = db.prepare('select * from reminders').get();
  assert.equal(r.status, 'pending');
  assert.equal(r.local_time, '2026-11-03T06:30');
  assert.equal(r.due_at, '2026-11-03T14:30:00.000Z');
});

test('inbound texts: only signed texts from the owner get through; approvals need the PIN', async () => {
  reset();
  phone.setPin('4821');
  agentMod.deps.client = { messages: { create: async () => { throw new Error('model should not be called'); } } };
  db.prepare("insert into approvals (agent, tool, input) values ('orchestrator', 'create_agent', ?)").run(JSON.stringify({ name: 'etsy', model: 'claude-haiku-4-5', purpose: 'x', daily_budget_usd: 1 }));
  const id = db.prepare('select max(id) id from approvals').get().id;

  await handleSms({ From: '+15559999999', Body: `Y ${id} 4821` }, true);
  await handleSms({ From: '+15550000002', Body: `Y ${id} 4821` }, false);
  assert.equal(db.prepare('select status from approvals where id = ?').get(id).status, 'pending', 'stranger and unsigned are ignored');
  assert.equal(sent.length, 0);

  await handleSms({ From: '+15550000002', Body: `Y ${id} 0000` }, true);
  assert.equal(db.prepare('select status from approvals where id = ?').get(id).status, 'pending');
  assert.match(sent.at(-1).params.Body, /Wrong PIN/);

  await handleSms({ From: '+15550000002', Body: `yes #${id} 4821` }, true);
  assert.equal(db.prepare('select status from approvals where id = ?').get(id).status, 'approved');
  assert.equal(db.prepare("select count(*) n from agents where name = 'etsy'").get().n, 1);
});

test('a normal text goes to the agents and the reply comes back by text', async () => {
  reset();
  const usage = { input_tokens: 1, output_tokens: 1 };
  const calls = [];
  agentMod.deps.client = { messages: { create: async (p) => (calls.push(p), { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Your name is Logan.' }] }) } };
  await handleSms({ From: '+15550000002', Body: 'what is my name' }, true);
  assert.equal(calls[0].model, 'claude-haiku-4-5', 'Auto routing: simple text goes to Pete');
  assert.match(JSON.stringify(calls[0].messages), /under 300 characters/);
  assert.equal(sent.at(-1).params.Body, 'Your name is Logan.');
});
