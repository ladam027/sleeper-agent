// Solving CAPTCHAs from Telegram (owner request 2026-11-04). The owner, not an agent, solves them: the bot sends a picture
// of the CAPTCHA with a numbered grid and buttons; a tap clicks the middle of that square on the live page, "Type text"
// types the owner's next message, Done hands the page back to the agent. Only the paired chat's button presses count.
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get, log } from './db.js';
import * as browser from './browser.js';
import * as phone from './phone.js';
import { deps as vdeps } from './video.js';

export const deps = { run: null, exec: (...a) => vdeps.exec(...a) }; // run = runAgent (set by server.js)
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const live = new Map(); // session id → { rect, cols, rows, msg, agent }
let typing = null; // { session, until }

// Grid: squares of ~80 page pixels, 2-6 across, up to 8 down (≤48 buttons, Telegram allows 100).
export const gridFor = (rect) => ({ cols: Math.min(6, Math.max(2, Math.round(rect.w / 80))), rows: Math.min(8, Math.max(1, Math.round(rect.h / 80))) });
export const cellCenter = (rect, g, i) => ({ x: Math.round(rect.x + ((i % g.cols) + 0.5) * rect.w / g.cols), y: Math.round(rect.y + (Math.floor(i / g.cols) + 0.5) * rect.h / g.rows) });

// The picture's filter: scale small CAPTCHAs up for a phone, red grid, a number in each square's corner.
export function gridFilter(g) {
  const nums = Array.from({ length: g.cols * g.rows }, (_, i) => `drawtext=fontfile=${FONT}:text='${i + 1}':x=${i % g.cols}*w/${g.cols}+6:y=${Math.floor(i / g.cols)}*h/${g.rows}+4:fontsize=22:fontcolor=white:box=1:boxcolor=red@0.75:boxborderw=4`);
  return [`scale='max(iw,720)':-2`, `drawgrid=w=iw/${g.cols}:h=ih/${g.rows}:t=2:c=red@0.8`, ...nums].join(',');
}

async function picture(id) {
  const shot = await browser.captchaShot(id), g = gridFor(shot.rect);
  const dir = mkdtempSync(join(tmpdir(), 'sa-cap-'));
  try {
    writeFileSync(join(dir, 'in.png'), shot.png);
    await deps.exec('ffmpeg', ['-y', '-v', 'error', '-i', join(dir, 'in.png'), '-vf', gridFilter(g), '-frames:v', '1', join(dir, 'out.jpg')], { timeout: 30e3 });
    return { jpg: readFileSync(join(dir, 'out.jpg')), rect: shot.rect, g, url: shot.url, agent: shot.agent };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const keyboard = (id, g) => ({ inline_keyboard: [
  ...Array.from({ length: g.rows }, (_, r) => Array.from({ length: g.cols }, (_, c) => ({ text: String(r * g.cols + c + 1), callback_data: `cap:${id}:c${r * g.cols + c}` }))),
  [{ text: '⌨️ Type text', callback_data: `cap:${id}:t` }, { text: '🔄 Refresh', callback_data: `cap:${id}:r` }, { text: '✅ Done', callback_data: `cap:${id}:d` }],
] });

// Called by the browser when a page shows a CAPTCHA. At the desk: the dashboard's Browser tab. On the phone: Telegram.
export async function offer(id) {
  const link = `${String(process.env.PUBLIC_DASHBOARD_URL || '').replace(/\/$/, '')}/browser`;
  if (!phone.telegramReady() || phone.ownerOnDashboard()) return phone.notify('high', `CAPTCHA while an agent works. Finish it in the Browser tab: ${link}`);
  const p = await picture(id);
  const sent = await phone.telegramFile('sendPhoto', { chat_id: get('telegram_chat_id'), caption: `CAPTCHA on ${new URL(p.url).hostname}. Tap the numbers of the squares to click (e.g. each matching picture, then the Verify/Next button). ⌨️ Type text for letters. ✅ Done when it's solved.`, reply_markup: JSON.stringify(keyboard(id, p.g)) }, 'photo', p.jpg, 'captcha.jpg');
  live.set(id, { rect: p.rect, g: p.g, msg: sent.message_id, agent: p.agent });
  log('phone', 'captcha', `sent the CAPTCHA on ${new URL(p.url).hostname} to Telegram (${p.g.cols}x${p.g.rows} grid)`);
}

async function redraw(id) {
  const c = live.get(id); if (!c) return;
  const p = await picture(id); c.rect = p.rect; c.g = p.g;
  await phone.telegramFile('editMessageMedia', { chat_id: get('telegram_chat_id'), message_id: c.msg, media: JSON.stringify({ type: 'photo', media: 'attach://photo' }), reply_markup: JSON.stringify(keyboard(id, p.g)) }, 'photo', p.jpg, 'captcha.jpg');
}

// A button press from Telegram (telegram.js already checked it came from the paired chat).
export async function onCallback(data) {
  const m = /^cap:([0-9a-f]{8}):(c\d+|t|r|d)$/.exec(data || '');
  if (!m) return 'Unknown button';
  const [, id, act] = m, c = live.get(id);
  if (!c) return 'That CAPTCHA is no longer open';
  if (act === 't') { typing = { session: id, until: Date.now() + 3 * 60e3 }; await phone.message('Send the text to type (your next message goes into the page, not to James).'); return 'Waiting for your text'; }
  if (act === 'd') {
    live.delete(id); if (typing?.session === id) typing = null;
    await phone.telegram('editMessageReplyMarkup', { chat_id: get('telegram_chat_id'), message_id: c.msg, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    log('owner', 'captcha', `owner finished the CAPTCHA in session ${id}`);
    // Hand the page back to the agent that was working.
    if (deps.run) deps.run(c.agent || 'orchestrator', `The owner finished the CAPTCHA in browser session ${id}. Take a fresh snapshot (full=true) and continue the task. If it's still there, say so.`, 0, { tainted: true })
      .then((r) => { const reply = typeof r === 'string' ? r : r?.reply; if (reply) return phone.message(reply); }).catch((e) => log('phone', 'error', e.message));
    return 'Thanks, handing it back';
  }
  if (act === 'r') { await redraw(id); return 'Refreshed'; }
  const i = Number(act.slice(1));
  if (!(i >= 0 && i < c.g.cols * c.g.rows)) return 'That square is not on the grid';
  const { x, y } = cellCenter(c.rect, c.g, i);
  await browser.ownerInput(id, { type: 'click', x, y });
  await new Promise((r) => setTimeout(r, 1200)); // let the CAPTCHA react before the new picture
  await redraw(id).catch(() => {});
  return `Clicked ${i + 1}`;
}

// The owner's next Telegram message after "Type text" goes into the page (then the picture updates).
export function wantsText() { if (typing && typing.until < Date.now()) typing = null; return !!typing; }
export async function typeText(text) {
  const id = typing.session; typing = null;
  await browser.ownerInput(id, { type: 'type', text });
  await new Promise((r) => setTimeout(r, 600));
  await redraw(id).catch(() => {});
  return phone.message('Typed. Tap the button to submit it (or ✅ Done if it went through).');
}
