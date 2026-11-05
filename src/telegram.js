// Telegram: the owner's two-way chat with the agents. Long-polls getUpdates, so no public URL or webhook is needed.
// Only the paired private chat is answered; pairing needs a one-time code shown on the dashboard.
import { randomInt } from 'node:crypto';
import { get, set, log } from './db.js';
import * as phone from './phone.js';
import { auto, decide } from './agent.js';
import { redact } from './vault.js';
import * as captcha from './captcha.js';
import * as upload from './upload.js';

let pairing = null; // { code, exp } from the dashboard; one guess only
export function startPairing() {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('Add TELEGRAM_BOT_TOKEN to .env first');
  pairing = { code: String(randomInt(100000, 1000000)), exp: Date.now() + 10 * 60e3 };
  return pairing.code;
}
export function unpair() { set('telegram_chat_id', ''); log('owner', 'settings', 'Telegram unpaired'); }

// Telegram shows markdown literally; models still use it sometimes.
export const plain = (t) => String(t).replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/`([^`]+)`/g, '$1');

const HELP = "I'm your Sleeper Agent. Message me like a person: questions go to Pete, bigger jobs to James.\nWhen I ask for approval I'll send a request number. Reply Y <number> <PIN> to approve or N <number> <PIN> to deny. Set your PIN on the dashboard: Settings → Phone & alerts.";
const NO_PIN = 'No approval PIN is set yet. Set one on the dashboard under Settings → Phone & alerts (not in the Vault), then reply Y <request number> <PIN>.';

export async function handleUpdate(update) {
  // CAPTCHA buttons: only from the paired private chat.
  const cb = update.callback_query;
  if (cb) {
    if (!get('telegram_chat_id') || String(cb.message?.chat?.id) !== get('telegram_chat_id') || String(cb.from?.id) !== get('telegram_chat_id')) { log('phone', 'msg:blocked', 'button press from an unpaired Telegram chat'); return; }
    phone.ownerUsed('telegram');
    const note = await (String(cb.data).startsWith('up:') ? upload.onCallback(cb.data) : captcha.onCallback(cb.data)).catch((e) => `Failed: ${e.message}`.slice(0, 190));
    return phone.telegram('answerCallbackQuery', { callback_query_id: cb.id, text: note }).catch(() => {});
  }
  const msg = update.message;
  // A photo or file: only ever for an upload an agent asked for (upload.js). Never logged, saved, or shown to a model.
  if ((msg?.photo || msg?.document) && msg.chat?.type === 'private') {
    if (!get('telegram_chat_id') || String(msg.chat.id) !== get('telegram_chat_id')) { log('phone', 'msg:blocked', 'file from an unpaired Telegram chat'); return; }
    phone.ownerUsed('telegram'); log('phone', 'msg:in', '[a file]');
    return upload.onFile(msg).catch((e) => phone.message(`Nothing was uploaded: ${e.message}`.slice(0, 300)));
  }
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

  const ap = phone.parseApproval(text);
  const barePin = /^\d{4,8}$/.test(text);
  // Never write a PIN to the activity log; everything else is logged vault-redacted.
  phone.ownerUsed('telegram');
  log('phone', 'msg:in', ap ? `${ap.approve ? 'Y' : 'N'} #${ap.id} [PIN hidden]` : barePin ? '[number hidden]' : redact(text).slice(0, 200));
  if (text === '/start' || text === '/help') return phone.message(HELP);
  if (barePin) return phone.message(phone.pinSet() ? 'To approve, send Y <request number> <PIN> (or N to deny). The request number is in the approval message.' : NO_PIN);
  if (ap && !phone.pinSet()) return phone.message(NO_PIN);
  if (ap) {
    if (!phone.checkPin(ap.pin)) { log('phone', 'msg:blocked', `approval #${ap.id} with wrong PIN`); return phone.message('Wrong PIN. Nothing was approved.'); }
    const result = await decide(ap.id, ap.approve);
    return phone.message(result === null ? `Approval #${ap.id} isn't pending.` : `#${ap.id} ${ap.approve ? 'approved' : 'denied'}: ${result}`);
  }
  if (captcha.wantsText()) return captcha.typeText(text); // the owner pressed "Type text" on a CAPTCHA
  phone.telegram('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  return phone.message(plain(await auto(`[Sent from Telegram on the owner's phone. Keep the reply short and plain text, no markdown.]\n${text}`, { owner: true })));
}

export async function poll() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  let offset = 0;
  for (;;) {
    try {
      const updates = await phone.telegram('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u).catch((e) => log('phone', 'error', e.message));
      }
    } catch (e) { log('phone', 'error', e.message); await new Promise((r) => setTimeout(r, 10e3)); }
  }
}
