// Inbound texts from the owner: approvals ("Y 12 1234") or a message to the agents (Auto routing).
import { log } from './db.js';
import * as phone from './phone.js';
import { auto, decide } from './agent.js';

export async function handleSms(params, signatureOk) {
  if (!signatureOk) { log('phone', 'sms:blocked', 'bad Twilio signature'); return; }
  if (!phone.isOwner(params.From)) { log('phone', 'sms:blocked', `text from unknown number •••${String(params.From).slice(-4)}`); return; }
  const text = String(params.Body || '').trim().slice(0, 2000);
  log('phone', 'sms:in', text.slice(0, 200));
  const ap = phone.parseApproval(text);
  if (ap) {
    if (!phone.checkPin(ap.pin)) { log('phone', 'sms:blocked', `approval #${ap.id} with wrong PIN`); return phone.sms('Wrong PIN. Nothing was approved.'); }
    const result = await decide(ap.id, ap.approve);
    return phone.sms(result === null ? `Approval #${ap.id} isn't pending.` : `#${ap.id} ${ap.approve ? 'approved' : 'denied'}: ${result}`.slice(0, 300));
  }
  const reply = await auto(`[Sent by text message. Reply in under 300 characters, plain text, no markdown.]\n${text}`);
  return phone.sms(reply);
}
