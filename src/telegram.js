// Telegram: the owner's two-way chat with the agents. Long-polls getUpdates, so no public URL or webhook is needed.
// Only the paired private chat is answered; pairing needs a one-time code shown on the dashboard.
import { randomInt } from 'node:crypto';
import { get, set, log } from './db.js';
import * as phone from './phone.js';
import { auto, decide } from './agent.js';

let pairing = null; // { code, exp } from the dashboard; one guess only
export function startPairing() {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('Add TELEGRAM_BOT_TOKEN to .env first');
  pairing = { code: String(randomInt(100000, 1000000)), exp: Date.now() + 10 * 60e3 };
  return pairing.code;
}
export function unpair() { set('telegram_chat_id', ''); log('owner', 'settings', 'Telegram unpaired'); }

const HELP = "I'm your Sleeper Agent. Message me like a person: questions go to Pete, bigger jobs to James.\nApprove a request: Y 12 <PIN>  ·  Deny: N 12 <PIN>";

export async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text || msg.chat?.type !== 'private') return;
  const chat = String(msg.chat.id), text = msg.text.trim().slice(0, 2000);

  const pm = /^\/pair\s+(\d{6})$/.exec(text);
  if (pm) {
    const ok = pairing && Date.now() < pairing.exp && pm[1] === pairing.code;
    pairing = null; // any attempt burns the code
    if (!ok) { log('phone', 'msg:blocked', 'wrong or expired Telegram pairing code'); return; }
    set('telegram_chat_id', chat);
    log('phone', 'settings', 'Telegram paired');
    return phone.message(`Paired! ${HELP}`, chat);
  }
  if (!get('telegram_chat_id') || chat !== get('telegram_chat_id')) { log('phone', 'msg:blocked', 'message from an unpaired Telegram chat'); return; }

  log('phone', 'msg:in', text.slice(0, 200));
  if (text === '/start' || text === '/help') return phone.message(HELP);
  const ap = phone.parseApproval(text);
  if (ap) {
    if (!phone.checkPin(ap.pin)) { log('phone', 'msg:blocked', `approval #${ap.id} with wrong PIN`); return phone.message('Wrong PIN. Nothing was approved.'); }
    const result = await decide(ap.id, ap.approve);
    return phone.message(result === null ? `Approval #${ap.id} isn't pending.` : `#${ap.id} ${ap.approve ? 'approved' : 'denied'}: ${result}`);
  }
  phone.telegram('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  return phone.message(await auto(`[Sent from Telegram on the owner's phone. Keep the reply short and plain text, no markdown.]\n${text}`));
}

export async function poll() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  let offset = 0;
  for (;;) {
    try {
      const updates = await phone.telegram('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch((e) => log('phone', 'error', e.message));
      }
    } catch (e) { log('phone', 'error', e.message); await new Promise((r) => setTimeout(r, 10e3)); }
  }
}
