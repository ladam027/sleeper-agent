// Build 8: routing cases taken from the real logs (paraphrased). A wrong route either wastes a Pete call before James
// takes over, or pays James's price for a quick answer. Run before every deploy (npm test).
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { pickRoute } = await import('../src/agent.js');
const TG = "[Sent from Telegram on the owner's phone. Keep the reply short and plain text, no markdown.]\n";
const recent = { jamesAnsweredMsAgo: 5 * 60e3 }, open = { sessionOpen: true };

const CASES = [
  // [message, context, expected agent]
  ['what is my name?', {}, 'quick'],
  ['remind me to call the dentist at 5', {}, 'quick'],
  ['add Maya Torres as a lead for the bakery', {}, 'quick'],
  ['log $125 income for the bakery site', {}, 'quick'],
  ['what assignments are due this week?', {}, 'quick'],
  [TG + 'set a reminder for noon to add a file system', {}, 'quick'],
  ['plan my week around the launch', {}, 'orchestrator'],
  ['research how people make money on Kalshi', {}, 'orchestrator'],
  ['use live trading: buy NO on the LA high', {}, 'orchestrator'],
  ['add my car to my dmv account', {}, 'orchestrator'],
  ['use car-details from the vault', {}, 'orchestrator'],
  ['log into canvas with the browser', {}, 'orchestrator'],
  ['open dmv.ca.gov', {}, 'orchestrator'],
  ['draft an email to the barbershop about a website', {}, 'orchestrator'],
  ['design a website for the taqueria', {}, 'designer'],
  ['redesign the bakery site with the new style', {}, 'designer'],
  ['design a website and email it to them', {}, 'orchestrator'],
  // follow-ups to James
  ['add the car now', recent, 'orchestrator'],
  ['try again', recent, 'orchestrator'],
  [TG + 'Send', recent, 'orchestrator'],
  ['666405', open, 'orchestrator'],
  ['use 93265', open, 'orchestrator'],
  ['what time is it?', recent, 'quick'],
  ['try again', { jamesAnsweredMsAgo: 3 * 3600e3 }, 'quick'],
];

test('routing sends each logged case to the right agent', () => {
  const wrong = CASES.filter(([m, ctx, want]) => pickRoute(m, ctx).agent !== want).map(([m, ctx, want]) => `${JSON.stringify(m.replace(TG, 'TG: '))} → ${pickRoute(m, ctx).agent} (want ${want})`);
  assert.deepEqual(wrong, [], `${wrong.length}/${CASES.length} misrouted:\n${wrong.join('\n')}`);
});
