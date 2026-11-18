// Build 2: Telnyx calls, Telegram messages, quiet hours, reminders, phone approvals. No network: fetch and the model are faked.
process.env.DB_PATH = ':memory:';
Object.assign(process.env, { TELNYX_API_KEY: 'KEY_test', TELNYX_CONNECTION_ID: '123', TELNYX_FROM: '+15550000001', OWNER_PHONE: '+15550000002', TELEGRAM_BOT_TOKEN: 'bot_test' });
import { test } from 'node:test';
import assert from 'node:assert/strict';
const sysText = (c) => typeof c.system === 'string' ? c.system : c.system.map((b) => b.text).join('');

const { db, set } = await import('../src/db.js');
const phone = await import('../src/phone.js');
const sched = await import('../src/scheduler.js');
const tg = await import('../src/telegram.js');
const agentMod = await import('../src/agent.js');
const { setupTelnyx, upsertEnv } = await import('../src/telnyx-setup.js');

let sent = [];
phone.deps.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true, result: {} }) }; };
const kinds = () => sent.map((s) => s.url.includes('telnyx') ? 'call' : s.url.split('/').pop());
const reset = () => { sent = []; db.exec("delete from activity; delete from reminders; delete from approvals; delete from costs"); set('timezone', 'America/Los_Angeles'); set('quiet_start', '00:00'); set('quiet_end', '07:00'); set('telegram_chat_id', '42'); };
const at = (iso) => new Date(iso);
const tgMsg = (text, chat = 42) => ({ update_id: 1, message: { text, chat: { id: chat, type: 'private' } } });

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

test('a Telnyx call carries inline TeXML to the owner; XML is escaped', async () => {
  reset();
  await phone.call('Server <down> & out');
  assert.equal(sent[0].url, 'https://api.telnyx.com/v2/texml/calls/123');
  assert.equal(sent[0].body.To, '+15550000002');
  assert.equal(sent[0].body.From, '+15550000001');
  assert.match(sent[0].body.Texml, /<Say[^>]*>Server &lt;down&gt; &amp; out<\/Say>/);
  assert.ok(db.prepare("select sum(usd) s from costs where agent = 'phone'").get().s > 0, 'call cost is in the ledger');
});

test('notify routes by urgency; calls become messages in quiet hours unless it is an alarm', async () => {
  reset();
  set('quiet_start', '00:00'); set('quiet_end', '00:00'); // never quiet
  await phone.notify('critical', 'server down');
  assert.deepEqual(kinds(), ['call', 'sendMessage']);
  assert.equal(sent[1].body.chat_id, '42');

  sent = []; set('quiet_end', '24:00'); // always quiet ('23:59' failed during that one minute)
  assert.match(await phone.notify('critical', 'late night'), /quiet hours, so no call, messaged on Telegram/);
  assert.deepEqual(kinds(), ['sendMessage']);
  sent = [];
  await phone.notify('critical', 'wake up', { alarm: true });
  assert.equal(kinds()[0], 'call', 'owner-set alarms ring anyway');

  sent = [];
  assert.match(await phone.notify('low', 'fyi'), /dashboard/);
  assert.equal(sent.length, 0);
});

test('daily caps stop a loop from calling forever', async () => {
  reset();
  for (let i = 0; i < phone.CAPS.call; i++) await phone.call('x');
  await assert.rejects(phone.call('one too many'), /cap/);
});

test('reminders fire once; repeating ones roll forward keeping wall-clock time', async () => {
  reset();
  const future = sched.localNow('America/Los_Angeles').slice(0, 10) + 'T23:59';
  assert.match(sched.addReminder({ message: 'call mom', when: future, channel: 'message' }), /Reminder #\d+ set/);
  assert.throws(() => sched.addReminder({ message: 'x', when: '2020-01-01T00:00' }), /past/);
  db.exec("update reminders set due_at = '2000-01-01T00:00:00.000Z'");
  await sched.tick();
  assert.deepEqual(kinds(), ['sendMessage']);
  assert.match(sent[0].body.text, /Reminder: call mom/);
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

test('Telegram pairing needs the one-time dashboard code; one wrong guess burns it', async () => {
  reset();
  set('telegram_chat_id', '');
  const code = tg.startPairing();
  await tg.handleUpdate(tgMsg('/pair 000000', 99));
  await tg.handleUpdate(tgMsg(`/pair ${code}`, 99));
  assert.equal(db.prepare("select value from settings where key = 'telegram_chat_id'").get().value, '', 'code burned by the wrong guess');
  const code2 = tg.startPairing();
  await tg.handleUpdate(tgMsg(`/pair ${code2}`, 42));
  assert.equal(db.prepare("select value from settings where key = 'telegram_chat_id'").get().value, '42');
});

test('Telegram: only the paired chat gets through; approvals need the PIN', async () => {
  reset();
  phone.setPin('4821');
  agentMod.deps.client = { messages: { create: async () => { throw new Error('model should not be called'); } } };
  db.prepare("insert into approvals (agent, tool, input) values ('orchestrator', 'create_agent', ?)").run(JSON.stringify({ name: 'etsy', model: 'claude-haiku-4-5', purpose: 'x', daily_budget_usd: 1 }));
  const id = db.prepare('select max(id) id from approvals').get().id;

  await tg.handleUpdate(tgMsg(`Y ${id} 4821`, 99));
  assert.equal(db.prepare('select status from approvals where id = ?').get(id).status, 'pending', 'stranger ignored');
  assert.equal(sent.length, 0);

  await tg.handleUpdate(tgMsg(`Y ${id} 0000`));
  assert.equal(db.prepare('select status from approvals where id = ?').get(id).status, 'pending');
  assert.match(sent.at(-1).body.text, /Wrong PIN/);

  await tg.handleUpdate(tgMsg(`yes #${id} 4821`));
  assert.equal(db.prepare('select status from approvals where id = ?').get(id).status, 'approved');
  assert.equal(db.prepare("select count(*) n from agents where name = 'etsy'").get().n, 1);
});

test('a normal Telegram message goes to the agents and the reply comes back', async () => {
  reset();
  const usage = { input_tokens: 1, output_tokens: 1 }, calls = [];
  agentMod.deps.client = { messages: { create: async (p) => (calls.push(p), { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Your name is Alex.' }] }) } };
  await tg.handleUpdate(tgMsg('what is my name'));
  assert.equal(calls[0].model, 'claude-haiku-4-5', 'Auto routing: simple message goes to Pete');
  assert.match(JSON.stringify(calls[0].messages), /Sent from Telegram/);
  assert.equal(sent.at(-1).body.text, 'Your name is Alex.');
});

test('Telnyx setup creates profile + app, attaches the number, and reuses them on a rerun', async () => {
  const store = { profiles: [], apps: [], numbers: [{ id: 'n1', phone_number: '+15550000001', connection_id: null }] }, log = [];
  const fakeFetch = async (url, o) => {
    const path = url.replace('https://api.telnyx.com/v2', ''), body = o.body && JSON.parse(o.body);
    log.push(`${o.method} ${path}`);
    assert.equal(o.headers.authorization, 'Bearer K');
    const data = o.method === 'GET' ? { '/outbound_voice_profiles': store.profiles, '/texml_applications': store.apps, '/phone_numbers': store.numbers }[path]
      : path === '/outbound_voice_profiles' ? (store.profiles.push({ id: 'p1', ...body }), store.profiles[0])
      : path === '/texml_applications' ? (store.apps.push({ id: 'a1', ...body }), store.apps[0])
      : Object.assign(store.numbers[0], body);
    return { ok: true, json: async () => ({ data }) };
  };
  const r = await setupTelnyx({ apiKey: 'K', fetch: fakeFetch });
  assert.deepEqual(r, { connectionId: 'a1', from: '+15550000001', profileId: 'p1' });
  assert.equal(store.apps[0].outbound.outbound_voice_profile_id, 'p1');
  assert.equal(store.numbers[0].connection_id, 'a1');
  log.length = 0;
  await setupTelnyx({ apiKey: 'K', fetch: fakeFetch });
  assert.ok(!log.some((l) => l.startsWith('POST') || l.startsWith('PATCH')), 'idempotent');
  await assert.rejects(setupTelnyx({ apiKey: '', fetch: fakeFetch }), /TELNYX_API_KEY/);
  assert.equal(upsertEnv('A=1\nTELNYX_FROM=\nB=2\n', { TELNYX_FROM: '+1555', TELNYX_CONNECTION_ID: '9' }), 'A=1\nTELNYX_FROM=+1555\nB=2\nTELNYX_CONNECTION_ID=9\n');
});

test('Telnyx setup reuses the default outbound profile on accounts limited to one', async () => {
  const store = { profiles: [{ id: 'default1', name: 'Default' }], apps: [], numbers: [{ id: 'n1', phone_number: '+15550000001', connection_id: null }] }, posts = [];
  const fakeFetch = async (url, o) => {
    const path = url.replace('https://api.telnyx.com/v2', ''), body = o.body && JSON.parse(o.body);
    if (o.method === 'POST') posts.push(path);
    const data = o.method === 'GET' ? { '/outbound_voice_profiles': store.profiles, '/texml_applications': store.apps, '/phone_numbers': store.numbers }[path]
      : path === '/texml_applications' ? (store.apps.push({ id: 'a1', ...body }), store.apps[0]) : Object.assign(store.numbers[0], body);
    return { ok: true, json: async () => ({ data }) };
  };
  const r = await setupTelnyx({ apiKey: 'K', fetch: fakeFetch });
  assert.equal(r.profileId, 'default1');
  assert.deepEqual(posts, ['/texml_applications'], 'no new profile created');
});

test('PINs never reach the activity log or the model; helpful replies when no PIN is set', async () => {
  reset();
  db.exec("delete from settings where key = 'sms_pin'");
  agentMod.deps.client = { messages: { create: async () => { throw new Error('model should not be called'); } } };
  await tg.handleUpdate(tgMsg('Y 12 7777'));
  assert.match(sent.at(-1).body.text, /No approval PIN is set/);
  await tg.handleUpdate(tgMsg('7777'));
  assert.match(sent.at(-1).body.text, /No approval PIN is set/);
  phone.setPin('7777');
  await tg.handleUpdate(tgMsg('7777'));
  assert.match(sent.at(-1).body.text, /Y <request number> <PIN>/);
  await tg.handleUpdate(tgMsg('N 5 7777'));
  const logged = db.prepare("select group_concat(detail, ' | ') d from activity where type = 'msg:in'").get().d;
  assert.ok(!logged.includes('7777'), `PIN leaked into the log: ${logged}`);
});

test('delivered reminders record the result so agents can say whether they went through', async () => {
  reset();
  const { TOOLS } = await import('../src/tools.js');
  const future = sched.localNow('America/Los_Angeles').slice(0, 10) + 'T23:59';
  sched.addReminder({ message: 'call Raincross Pub', when: future, channel: 'message' });
  db.exec("update reminders set due_at = '2000-01-01T00:00:00.000Z'");
  await sched.tick();
  const out = JSON.parse(TOOLS.list_reminders.run({}));
  assert.equal(out.upcoming.length, 0);
  assert.equal(out.recently_delivered[0].message, 'call Raincross Pub');
  assert.match(out.recently_delivered[0].result, /messaged on Telegram/);
});

test('Telegram replies have markdown stripped', () => {
  assert.equal(tg.plain('**Fixes:** done\n## Next\nRun `npm test`'), 'Fixes: done\nNext\nRun npm test');
});

test('ultra concise style reaches the model for James and Pete by default', async () => {
  const calls = [];
  agentMod.deps.client = { messages: { create: async (p) => (calls.push(p), { stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'ok' }] }) } };
  await agentMod.runAgent('quick', 'hi');
  assert.match(sysText(calls[0]), /ULTRA CONCISE/);
  assert.match(sysText(calls[0]), /Never mention what you fixed/);
});

test('no Telegram while the owner is active on the dashboard, unless they are working from the phone', async () => {
  reset();
  set('quiet_start', '00:00'); set('quiet_end', '00:00');
  set('dashboard_active_at', Date.now()); set('last_owner_channel', 'dashboard'); set('last_owner_channel_at', Date.now());
  assert.match(await phone.notify('high', 'research finished'), /dashboard \(the owner is active there/);
  assert.equal(sent.length, 0);
  await phone.notify('critical', 'server down');
  assert.deepEqual(kinds(), ['call'], 'urgent call still rings, but no text');

  sent = [];
  phone.ownerUsed('telegram'); // owner just messaged the bot: they're on the phone
  await phone.notify('high', 'research finished');
  assert.deepEqual(kinds(), ['sendMessage']);

  sent = []; set('last_owner_channel', 'dashboard');
  await phone.notify('high', 'reminder you set', { explicit: true });
  assert.deepEqual(kinds(), ['sendMessage'], "the owner's own reminders always go out as chosen");

  sent = []; set('dashboard_active_at', Date.now() - 10 * 60e3); // walked away
  await phone.notify('high', 'task done');
  assert.deepEqual(kinds(), ['sendMessage']);
});
