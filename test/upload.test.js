// ID/document photos from the owner's phone: the agent asks for one upload field, the owner's Telegram file goes only there.
process.env.DB_PATH = ':memory:';
process.env.TELEGRAM_BOT_TOKEN = 'tg';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { set, db } = await import('../src/db.js');
const phone = await import('../src/phone.js');
const b = await import('../src/browser.js');
const upload = await import('../src/upload.js');
const telegram = await import('../src/telegram.js');

set('telegram_chat_id', '42');
const calls = [];
phone.deps.fetch = async (url, o = {}) => {
  if (url.includes('/file/bot')) return { arrayBuffer: async () => new TextEncoder().encode('JPEGDATA').buffer };
  const method = url.split('/').pop();
  calls.push({ method, body: JSON.parse(o.body || '{}') });
  return { ok: true, json: async () => ({ ok: true, result: method === 'getFile' ? { file_path: 'photos/1.jpg' } : { message_id: 7 } }) };
};
let url = 'https://verify.example.com/id';
const files = [];
const page = { goto: async () => {}, waitForLoadState: async () => {}, on: () => {}, url: () => url, title: async () => 'Verify',
  evaluate: async () => ({ title: 'Verify', url, text: '', captcha: false, elements: [{ ref: 3, tag: 'input', type: 'file', label: 'Front of ID' }, { ref: 4, tag: 'button', label: 'Continue', commit: true }] }),
  locator: () => ({ evaluate: async () => true, setInputFiles: async (f) => files.push(f) }) };
b.deps.launch = async () => ({ newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => {}, cookies: async () => [], addCookies: async () => {} }), close: async () => {} });
b.deps.lookup = async () => ['93.184.216.36'];
b.deps.askUpload = (r) => upload.ask(r);
const runs = [];
upload.deps.run = async (agent, text) => (runs.push(text), 'Uploaded, continuing.');

test("request_upload asks the owner with the site's host; only the paired chat's photo goes into that field; the submit goes to the owner", async () => {
  const id = /Session ([0-9a-f]{8})/.exec(await b.act({ action: 'open', url }, 'orchestrator'))[1];
  await assert.rejects(b.act({ action: 'request_upload', session: id, ref: 4, what: 'x' }), /not a file upload/);
  const r = await b.act({ action: 'request_upload', session: id, ref: 3, what: "the front of your driver's license" });
  assert.match(r, /never see the file/);
  const ask = calls.find((c) => c.method === 'sendMessage');
  assert.match(ask.body.text, /verify\.example\.com/);
  await telegram.handleUpdate({ message: { photo: [{ file_id: 'a', file_size: 8 }], chat: { id: 999, type: 'private' } } });
  assert.equal(files.length, 0, "a stranger's photo is ignored");
  await telegram.handleUpdate({ message: { photo: [{ file_id: 's', file_size: 2 }, { file_id: 'big', file_size: 8 }], chat: { id: 42, type: 'private' } } });
  assert.equal(files.length, 1); assert.equal(files[0].mimeType, 'image/jpeg'); assert.equal(String(files[0].buffer), 'JPEGDATA');
  assert.equal(calls.find((c) => c.method === 'getFile').body.file_id, 'big', 'largest size');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(runs[0], /attached the front of your driver's license/);
  await b.act({ action: 'snapshot', session: id });
  assert.equal(b.describeSubmit({ session: id, ref: 4 }).ownerOnly, true, 'a submit after an owner file never goes to Sam');
  const logged = db.prepare("select group_concat(detail, ' ') d from activity").get().d;
  assert.doesNotMatch(logged, /JPEGDATA|photos\/1/, 'the file never reaches the log');
  await telegram.handleUpdate({ message: { photo: [{ file_id: 'b', file_size: 8 }], chat: { id: 42, type: 'private' } } });
  assert.equal(files.length, 1, 'one request = one file');
  assert.match(calls.filter((c) => c.method === 'sendMessage').at(-1).body.text, /No upload is waiting/);

  await b.act({ action: 'request_upload', session: id, ref: 3, what: 'the back' });
  url = 'https://evil.example.net/';
  await telegram.handleUpdate({ message: { photo: [{ file_id: 'c', file_size: 8 }], chat: { id: 42, type: 'private' } } });
  assert.equal(files.length, 1, 'not uploaded once the page left the host the owner was shown');
  assert.match(calls.filter((c) => c.method === 'sendMessage').at(-1).body.text, /Nothing was uploaded: The page moved off verify\.example\.com/);
  url = 'https://verify.example.com/id';

  await b.act({ action: 'request_upload', session: id, ref: 3, what: 'the back' });
  const token = /up:([0-9a-f]{8}):x/.exec(JSON.stringify(calls.filter((c) => c.method === 'sendMessage').at(-1).body.reply_markup))[1];
  assert.match(await upload.onCallback(`up:${token}:x`), /Cancelled/);
  await telegram.handleUpdate({ message: { document: { file_id: 'd', file_size: 8, mime_type: 'application/pdf' }, chat: { id: 42, type: 'private' } } });
  assert.equal(files.length, 1, 'cancelled: nothing uploaded');
  await b.close(id);
});
