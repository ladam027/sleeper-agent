// Solving CAPTCHAs from Telegram: picture + numbered grid, taps become clicks, typed text, Done hands back to the agent.
process.env.DB_PATH = ':memory:';
process.env.TELEGRAM_BOT_TOKEN = 'tg';
process.env.PUBLIC_DASHBOARD_URL = 'https://sleeper.example.ts.net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
const { set } = await import('../src/db.js');
const phone = await import('../src/phone.js');
const b = await import('../src/browser.js');
const captcha = await import('../src/captcha.js');
const telegram = await import('../src/telegram.js');

set('telegram_chat_id', '42');
const calls = [];
phone.deps.fetch = async (url, o) => {
  const method = url.split('/').pop();
  calls.push({ method, body: o.body instanceof FormData ? Object.fromEntries([...o.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '[file]'])) : JSON.parse(o.body || '{}') });
  return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
};
captcha.deps.exec = async (cmd, args) => { writeFileSync(args.at(-1), 'jpg'); return ''; }; // ffmpeg: just make the output file
const clicks = [], typed = [];
const page = { goto: async () => {}, waitForLoadState: async () => {}, on: () => {}, url: () => 'https://www.fiverr.com/join', title: async () => 'Join',
  evaluate: async () => ({ title: 'Join', url: 'https://www.fiverr.com/join', text: '', captcha: true, captchaRect: { x: 400, y: 100, w: 400, h: 560 }, elements: [] }),
  screenshot: async () => Buffer.from('png'), mouse: { click: async (x, y) => clicks.push([x, y]), wheel: async () => {} }, keyboard: { type: async (t) => typed.push(t), press: async () => {} }, locator: () => ({}) };
b.deps.launch = async () => ({ newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => {}, cookies: async () => [], addCookies: async () => {} }), close: async () => {} });
b.deps.lookup = async () => ['93.184.216.36'];
b.deps.onCaptcha = (id) => captcha.offer(id);

test('grid math: ~80 px squares, taps land in the middle of the square', () => {
  const g = captcha.gridFor({ x: 400, y: 100, w: 400, h: 560 });
  assert.deepEqual(g, { cols: 5, rows: 7 });
  assert.deepEqual(captcha.cellCenter({ x: 400, y: 100, w: 400, h: 560 }, g, 0), { x: 440, y: 140 });
  assert.deepEqual(captcha.cellCenter({ x: 400, y: 100, w: 400, h: 560 }, g, 34), { x: 760, y: 620 }, 'last square = bottom right (where Verify usually is)');
});

let id;
test('on the phone, a CAPTCHA arrives as a picture with numbered buttons; taps click that square; other chats are ignored', async () => {
  const o = await b.act({ action: 'open', url: 'https://www.fiverr.com/join' }, 'orchestrator');
  id = /Session ([0-9a-f]{8})/.exec(o)[1];
  await new Promise((r) => setTimeout(r, 20));
  const photo = calls.find((c) => c.method === 'sendPhoto');
  assert.ok(photo, 'picture sent'); assert.equal(photo.body.photo, '[file]');
  const kb = JSON.parse(photo.body.reply_markup).inline_keyboard;
  assert.equal(kb.length, 8, '7 rows of squares + the action row'); assert.equal(kb[0].length, 5);
  assert.equal(kb[0][4].callback_data, `cap:${id}:c4`);
  await telegram.handleUpdate({ callback_query: { id: 'q1', data: `cap:${id}:c4`, from: { id: 999 }, message: { chat: { id: 999 } } } });
  assert.equal(clicks.length, 0, 'a stranger pressing a button does nothing');
  await telegram.handleUpdate({ callback_query: { id: 'q2', data: `cap:${id}:c4`, from: { id: 42 }, message: { chat: { id: 42 } } } });
  assert.deepEqual(clicks, [[770, 130]], 'square 5 = top right of a 5-wide grid (the picture includes a 12 px margin)');
  assert.ok(calls.some((c) => c.method === 'editMessageMedia'), 'picture refreshed after the tap');
  assert.match(calls.filter((c) => c.method === 'answerCallbackQuery').at(-1).body.text, /Clicked 5/);
});

test('"Type text": the next message is typed into the page, not sent to the agents; Done hands back to the agent', async () => {
  await telegram.handleUpdate({ callback_query: { id: 'q3', data: `cap:${id}:t`, from: { id: 42 }, message: { chat: { id: 42 } } } });
  await telegram.handleUpdate({ message: { text: 'x7Kp2', chat: { id: 42, type: 'private' } } });
  assert.deepEqual(typed, ['x7Kp2']);
  const runs = [];
  captcha.deps.run = async (agent, text) => (runs.push([agent, text]), 'Signed up. Check your email.');
  await telegram.handleUpdate({ callback_query: { id: 'q4', data: `cap:${id}:d`, from: { id: 42 }, message: { chat: { id: 42 } } } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(runs[0][0], 'orchestrator'); assert.match(runs[0][1], /finished the CAPTCHA in browser session/);
  assert.ok(calls.some((c) => c.method === 'sendMessage' && /Signed up/.test(c.body.text)), "the agent's answer comes back on Telegram");
  assert.match(await captcha.onCallback(`cap:${id}:c1`), /no longer open/, 'buttons stop working after Done');
  await b.close(id);
});
