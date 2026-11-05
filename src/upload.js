// ID and document uploads from the owner's phone (owner request 2026-11-04). An agent asks for a file for one upload
// field on the page it's on (browser request_upload); the owner sees the site's host and sends the photo on Telegram;
// the server attaches it straight to that field. The file stays in memory only: never saved, logged, put in the DB,
// or shown to a model. Sending it is the owner's consent; the submit after it still goes to the owner (never Sam).
import { randomBytes } from 'node:crypto';
import { get, log } from './db.js';
import * as browser from './browser.js';
import * as phone from './phone.js';

export const deps = { run: null }; // run = runAgent (set by server.js)
const TTL = 15 * 60e3, MAX = 10 * 1024 * 1024;
const TYPES = /^(image\/(jpeg|png|webp)|application\/pdf)$/;
let pending = null; // { token, session, ref, what, host, agent, until }
const who = (a) => (a === 'orchestrator' ? 'James' : a);

export async function ask({ session, ref, what, host, agent }) {
  if (!phone.telegramReady()) throw new Error('Telegram is not paired, so the owner cannot send files. Ask the owner to upload it in the dashboard\'s Browser tab.');
  if (pending && pending.until > Date.now() && pending.session !== session) throw new Error('Already waiting for the owner to send a file for another session.');
  pending = { token: randomBytes(4).toString('hex'), session, ref, what, host, agent, until: Date.now() + TTL };
  await phone.telegram('sendMessage', { chat_id: get('telegram_chat_id'),
    text: `${who(agent)} wants to upload ${what} on ${host}.\nSend it here (photo, or a PDF as a file) and it goes into that page's upload field only. It isn't saved anywhere or shown to the AI. Only send it if you trust ${host}.`,
    reply_markup: { inline_keyboard: [[{ text: '✖️ Cancel', callback_data: `up:${pending.token}:x` }]] } });
  log('phone', 'upload', `asked the owner for ${what} on ${host}`);
}

const handBack = (p, text) => deps.run?.(p.agent, text, 0, { tainted: true })
  .then((r) => { const reply = typeof r === 'string' ? r : r?.reply; if (reply) return phone.message(reply); }).catch((e) => log('phone', 'error', e.message));

export async function onFile(msg) {
  const p = pending;
  if (!p || p.until < Date.now()) { pending = null; return phone.message('No upload is waiting, so nothing was done with that file.'); }
  const f = msg.document ?? msg.photo?.at(-1), type = msg.document ? msg.document.mime_type : 'image/jpeg';
  if (!TYPES.test(type || '')) return phone.message('Send a photo (JPG/PNG) or a PDF.');
  if (!(f?.file_id) || f.file_size > MAX) return phone.message('That file is too big (10 MB max).');
  const info = await phone.telegram('getFile', { file_id: f.file_id });
  const res = await phone.deps.fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${info.file_path}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length || buffer.length > MAX) throw new Error('could not download the file');
  pending = null;
  const name = msg.document ? String(msg.document.file_name || 'upload.pdf').replace(/[^\w.-]/g, '_').slice(0, 60) : 'photo.jpg';
  await browser.attachFile(p.session, p.ref, p.host, { name, mimeType: type, buffer });
  log('owner', 'upload', `attached ${p.what} on ${p.host}`); // never the file
  handBack(p, `The owner attached ${p.what} to [${p.ref}] in browser session ${p.session}. Take a fresh snapshot (full=true) and continue. Submitting still goes through browser_submit.`);
  return phone.message(`Attached to ${p.host}. Handing back to ${who(p.agent)}.`);
}

export async function onCallback(data) {
  const m = /^up:([0-9a-f]{8}):x$/.exec(data || '');
  if (!m || pending?.token !== m[1]) return 'That upload is no longer waiting';
  const p = pending; pending = null;
  log('owner', 'upload', `declined ${p.what} on ${p.host}`);
  handBack(p, `The owner declined to upload ${p.what} on ${p.host}. Don't ask again; tell them what you'd need it for and stop.`);
  return 'Cancelled. Nothing was sent';
}
