// Marketing studio: website drafts (sanitized), Netlify publishing, and a social content calendar.
import { deflateRawSync, crc32 } from 'node:zlib';
import { db, get, log } from './db.js';
import { localToUtc } from './scheduler.js';
import * as vault from './vault.js';

export const deps = { fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
const MAX_HTML = 300_000;

// Static brochure sites need no scripts. Strip anything that could run code, phish, or load third-party code.
export function sanitizeHtml(html) {
  let h = String(html);
  h = h.replace(/<(script|iframe|object|embed|applet|frame|frameset|noscript)\b[\s\S]*?<\/\1\s*>/gi, '');
  h = h.replace(/<\/?(script|iframe|object|embed|applet|frame|frameset|base|form|portal)\b[^>]*>/gi, '');
  h = h.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '');
  h = h.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  h = h.replace(/(href|src|action|formaction|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '$1="#"');
  h = h.replace(/<link\b[^>]*>/gi, (tag) => /href\s*=\s*["']https:\/\/fonts\.(googleapis|gstatic)\.com(\/|["'])/i.test(tag) ? tag : '');
  h = h.replace(/@import\s+url\(\s*["']?(?!https:\/\/fonts\.googleapis\.com)[^)]*\)\s*;?/gi, '');
  return h;
}

const slugOk = (s) => /^[a-z0-9][a-z0-9-]{1,40}$/.test(s || '');

export function saveSite({ slug, title, html, contact_id, notes = '' }, by = 'designer') {
  if (!slugOk(slug)) throw new Error('slug must be 2-41 chars: lowercase letters, numbers, hyphens (e.g. raincross-pub)');
  if (!title?.trim()) throw new Error('A site needs a title');
  if (!/<html[\s>]/i.test(html || '') || !/<\/html>/i.test(html)) throw new Error('html must be a complete document (<html>…</html>)');
  if (html.length > MAX_HTML) throw new Error('Page is too large (300 KB max). Use fewer inline images.');
  const clean = sanitizeHtml(html), cur = db.prepare('select * from sites where slug = ?').get(slug);
  if (cur) db.prepare("update sites set title = ?, html = ?, contact_id = coalesce(?, contact_id), notes = ?, status = case when status = 'live' then 'changed' else status end, updated_at = current_timestamp where slug = ?")
    .run(title.trim().slice(0, 120), clean, contact_id ?? null, String(notes).slice(0, 500), slug);
  else db.prepare('insert into sites (slug, title, html, contact_id, notes) values (?, ?, ?, ?, ?)').run(slug, title.trim().slice(0, 120), clean, contact_id ?? null, String(notes).slice(0, 500));
  log(by, 'site', `${cur ? 'updated' : 'drafted'} site "${title.slice(0, 60)}" (${slug})${clean.length < html.length ? ', unsafe parts removed' : ''}`);
  const live = cur?.url;
  return `Saved draft site "${title}" (${slug}). It is NOT public yet${live ? ` (the live link ${live} still shows the old version)` : ''}. Tell the owner it's ready to preview in the Studio tab and offer to ${live ? 'republish' : 'publish'} it: publish_site asks the owner for approval, or they press Publish in Studio.`;
}
export const listSites = () => db.prepare('select s.id, s.slug, s.title, s.status, s.url, s.notes, s.updated_at, c.name contact from sites s left join contacts c on c.id = s.contact_id order by s.updated_at desc').all();
export const siteHtml = (slug) => db.prepare('select html from sites where slug = ?').get(slug)?.html;

// Minimal zip (deflate) for one or more files, for Netlify's zip deploy.
export function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content), comp = deflateRawSync(data), n = Buffer.from(name), crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, comp); centrals.push(central, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function token(name, label) {
  if (!vault.ready()) throw new Error(`The vault is locked, so ${label} can't be used. Unlock it on the dashboard.`);
  const c = vault.reveal(name);
  if (!c?.value) throw new Error(`${label} isn't connected. Add it on the Integrations page.`);
  return c.value;
}
async function netlify(method, path, body, type = 'application/json') {
  const res = await deps.fetch(`https://api.netlify.com/api/v1${path}`, { method, body,
    headers: { authorization: `Bearer ${token('netlify', 'Netlify')}`, 'content-type': type, 'user-agent': 'SleeperAgent (studio)' } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Netlify ${res.status}: ${j.message || 'request failed'}`);
  return j;
}

// Public: always approval-gated (publish_site is high risk) or the owner's own click.
export async function publishSite(slug) {
  const s = db.prepare('select * from sites where slug = ?').get(slug);
  if (!s) throw new Error(`No site "${slug}"`);
  let siteId = s.netlify_id;
  if (!siteId) siteId = (await netlify('POST', '/sites', JSON.stringify({ name: `${slug}-${Math.random().toString(36).slice(2, 7)}` }))).id;
  let d = await netlify('POST', `/sites/${siteId}/deploys`, zip({ 'index.html': s.html }), 'application/zip');
  for (let i = 0; i < 20 && d.state !== 'ready'; i++) {
    if (d.state === 'error') throw new Error('Netlify could not deploy the site');
    await deps.sleep(1500);
    d = await netlify('GET', `/deploys/${d.id}`);
  }
  if (d.state !== 'ready') throw new Error('Netlify is still processing; try again in a minute');
  const site = await netlify('GET', `/sites/${siteId}`);
  const url = site.ssl_url || d.ssl_url || d.deploy_ssl_url;
  db.prepare("update sites set netlify_id = ?, url = ?, status = 'live', published_at = current_timestamp where slug = ?").run(siteId, url, slug);
  log('owner', 'site', `published "${s.title}" → ${url}`);
  return `Published "${s.title}": ${url}`;
}

// ── Content calendar ──
export const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'twitter', 'tiktok', 'threads', 'bluesky', 'pinterest', 'gmb'];
export function draftPost({ text, platforms = [], scheduled_at, media_url }, by = 'owner') {
  if (!text?.trim()) throw new Error('A post needs text');
  const bad = platforms.filter((p) => !PLATFORMS.includes(p));
  if (bad.length) throw new Error(`Unknown platform(s): ${bad.join(', ')}. Use ${PLATFORMS.join(', ')}`);
  if (media_url && !/^https:\/\//.test(media_url)) throw new Error('media_url must be an https link');
  const due = scheduled_at ? localToUtc(scheduled_at, get('timezone')).toISOString() : null;
  const r = db.prepare('insert into posts (text, platforms, scheduled_at, local_time, media_url, created_by) values (?, ?, ?, ?, ?, ?)')
    .run(text.trim().slice(0, 3000), platforms.join(','), due, scheduled_at || null, media_url || null, by);
  log(by, 'post', `drafted post #${r.lastInsertRowid}${platforms.length ? ` for ${platforms.join(', ')}` : ''}: ${text.slice(0, 80)}`);
  return `Drafted post #${r.lastInsertRowid}. The owner reviews it in the Studio tab before anything is posted.`;
}
export const listPosts = () => db.prepare("select * from posts where status in ('draft', 'scheduled', 'ready') or created_at >= datetime('now', '-7 days') order by coalesce(scheduled_at, created_at)").all();

export async function publishPost(id) {
  const p = db.prepare('select * from posts where id = ?').get(id);
  if (!p) throw new Error(`No post #${id}`);
  const have = vault.ready() && vault.names().some((n) => n.name === 'ayrshare');
  if (!have) { db.prepare("update posts set status = 'ready' where id = ?").run(id); return `Post #${id} approved. Copy it from the Studio tab to post it (no posting service connected).`; }
  if (!p.platforms) throw new Error('Choose at least one platform for this post');
  const res = await deps.fetch('https://api.ayrshare.com/api/post', { method: 'POST',
    headers: { authorization: `Bearer ${token('ayrshare', 'Ayrshare')}`, 'content-type': 'application/json' },
    body: JSON.stringify({ post: p.text, platforms: p.platforms.split(','), ...(p.media_url ? { mediaUrls: [p.media_url] } : {}),
      ...(p.scheduled_at && Date.parse(p.scheduled_at) > Date.now() + 60e3 ? { scheduleDate: p.scheduled_at.replace(/\.\d{3}Z$/, 'Z') } : {}) }) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.status === 'error') { db.prepare("update posts set status = 'failed', result = ? where id = ?").run(JSON.stringify(j.errors || j).slice(0, 500), id); throw new Error(`Ayrshare: ${j.errors?.[0]?.message || j.message || res.status}`); }
  db.prepare('update posts set status = ?, result = ? where id = ?').run(j.status === 'scheduled' ? 'scheduled' : 'posted', JSON.stringify(j.postIds || j).slice(0, 500), id);
  log('owner', 'post', `post #${id} ${j.status === 'scheduled' ? 'scheduled' : 'published'} on ${p.platforms}`);
  return `Post #${id} ${j.status === 'scheduled' ? 'scheduled' : 'published'}.`;
}
