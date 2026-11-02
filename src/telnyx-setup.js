// One-time Telnyx setup: `npm run setup:telnyx`. Needs only TELNYX_API_KEY (and a number bought in the portal).
// Creates (or reuses) an outbound voice profile + TeXML application named "Sleeper Agent", attaches your number,
// and writes TELNYX_CONNECTION_ID / TELNYX_FROM into .env. Never prints the API key. Safe to run again.
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NAME = 'Sleeper Agent';

export async function setupTelnyx({ apiKey, from = '', fetch = globalThis.fetch }) {
  if (!apiKey) throw new Error('Put TELNYX_API_KEY in .env first');
  const api = async (method, path, body) => {
    const res = await fetch(`https://api.telnyx.com/v2${path}`, { method, headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Telnyx ${method} ${path} → ${res.status}: ${json.errors?.[0]?.detail || json.errors?.[0]?.title || 'error'}`);
    return json.data;
  };

  const profile = (await api('GET', '/outbound_voice_profiles')).find((p) => p.name === NAME)
    || await api('POST', '/outbound_voice_profiles', { name: NAME, traffic_type: 'conversational', whitelisted_destinations: ['US'] });

  // voice_url is required; inbound calls aren't handled until Build 7, so it points nowhere useful on purpose.
  const app = (await api('GET', '/texml_applications')).find((a) => a.friendly_name === NAME)
    || await api('POST', '/texml_applications', { friendly_name: NAME, voice_url: 'https://example.com/sleeper-agent-inbound-not-enabled', voice_method: 'post',
      outbound: { outbound_voice_profile_id: profile.id } });

  const numbers = await api('GET', '/phone_numbers');
  if (!numbers.length) throw new Error('No phone numbers on this Telnyx account yet. Buy one in the portal (Numbers → Search & Buy), then run this again.');
  const number = from ? numbers.find((n) => n.phone_number === from) : numbers.length === 1 ? numbers[0] : null;
  if (!number) throw new Error(`Several numbers found (${numbers.map((n) => n.phone_number).join(', ')}). Set TELNYX_FROM in .env to the one to use, then run again.`);
  if (String(number.connection_id) !== String(app.id)) await api('PATCH', `/phone_numbers/${number.id}`, { connection_id: app.id });

  return { connectionId: String(app.id), from: number.phone_number, profileId: String(profile.id) };
}

// Replace or add KEY=value lines without touching anything else in .env.
export function upsertEnv(text, values) {
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}=${v}`, re = new RegExp(`^${k}=.*$`, 'm');
    text = re.test(text) ? text.replace(re, line) : text.replace(/\n?$/, `\n${line}\n`);
  }
  return text;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const r = await setupTelnyx({ apiKey: process.env.TELNYX_API_KEY, from: process.env.TELNYX_FROM });
    writeFileSync('.env', upsertEnv(readFileSync('.env', 'utf8'), { TELNYX_CONNECTION_ID: r.connectionId, TELNYX_FROM: r.from }));
    console.log(`Telnyx ready: calls will come from ${r.from} (TeXML app ${r.connectionId}). Wrote TELNYX_CONNECTION_ID and TELNYX_FROM to .env.`);
    if (!/^\+\d{8,15}$/.test(process.env.OWNER_PHONE || '')) console.log('Next: set OWNER_PHONE in .env to your cell, e.g. +19515551234.');
  } catch (e) { console.error(e.message); process.exit(1); }
}
