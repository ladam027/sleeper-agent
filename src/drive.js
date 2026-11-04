// Build 10.1: Google Drive. James's own Drive (full) and the owner's Drive (read-only, plus writes only inside a
// "Sleeper Agent" folder the app creates). Plain fetch through google.js auth; no SDK.
// Safety: reading file contents taints the run (files can carry instructions); trash and share are approval-gated tools;
// uploads from a URL go through the browser's public-address check; owner writes are confined to the app folder in code.
import { get, set, log, db } from './db.js';
import * as google from './google.js';
import { publicUrl } from './browser.js';

export const deps = { fetch: (...a) => fetch(...a) }; // for URL uploads; tests swap it
const D = 'https://www.googleapis.com/drive/v3', U = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,size,parents';
const FOLDER = 'application/vnd.google-apps.folder';
const MAX_READ = 20000, MAX_UPLOAD = 25 * 1024 * 1024;
const ACCTS = ['james', 'owner'];
const acctOk = (a) => { if (!ACCTS.includes(a)) throw new Error('account must be james (his own Drive) or owner (your Drive)'); return a; };
const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const slim = (f) => ({ id: f.id, name: f.name, type: f.mimeType === FOLDER ? 'folder' : f.mimeType, modified: f.modifiedTime, link: f.webViewLink, size: f.size ? Number(f.size) : undefined });

// The app's own folder in each Drive ("Sleeper Agent"), created once. Owner writes must land inside it.
export async function appFolder(acct) {
  const key = `drive_folder_${acct}`;
  if (get(key)) return get(key);
  const found = await google.api(acct, `${D}/files?${new URLSearchParams({ q: `name = 'Sleeper Agent' and mimeType = '${FOLDER}' and trashed = false and 'root' in parents`, fields: 'files(id)', pageSize: '1' })}`);
  const id = found.files?.[0]?.id || (await google.api(acct, `${D}/files?fields=id`, { method: 'POST', body: JSON.stringify({ name: 'Sleeper Agent', mimeType: FOLDER }) })).id;
  set(key, id);
  return id;
}
// Is this file (or folder) inside the owner's app folder? Walks up parents (max 10 levels).
async function insideAppFolder(acct, id) {
  const root = await appFolder(acct);
  for (let i = 0, cur = id; i < 10 && cur; i++) {
    if (cur === root) return true;
    cur = (await google.api(acct, `${D}/files/${encodeURIComponent(cur)}?fields=parents`)).parents?.[0];
  }
  return false;
}
async function writableParent(acct, folder_id) {
  if (acct === 'owner') {
    if (!folder_id) return appFolder('owner');
    if (!(await insideAppFolder('owner', folder_id))) throw new Error('In your Drive, agents can only write inside the "Sleeper Agent" folder.');
    return folder_id;
  }
  return folder_id || appFolder('james');
}

export async function search({ account = 'james', query = '', folder_id, max = 20 }) {
  acctOk(account);
  const parts = ['trashed = false'];
  if (query) parts.push(`(name contains '${q(query)}' or fullText contains '${q(query)}')`);
  if (folder_id) parts.push(`'${q(folder_id)}' in parents`);
  const r = await google.api(account, `${D}/files?${new URLSearchParams({ q: parts.join(' and '), fields: `files(${FIELDS})`, orderBy: 'modifiedTime desc', pageSize: String(Math.min(max, 50)) })}`);
  return (r.files || []).map(slim);
}

// Docs/Sheets/Slides are exported as text/CSV; plain text formats are read directly. Others: details only.
export async function read({ account = 'james', file_id }) {
  acctOk(account);
  const f = await google.api(account, `${D}/files/${encodeURIComponent(file_id)}?fields=${FIELDS}`);
  const exportAs = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv', 'application/vnd.google-apps.presentation': 'text/plain' }[f.mimeType];
  const textual = /^text\/|\/(json|csv|xml|markdown)$/.test(f.mimeType);
  if (!exportAs && !textual) return { ...slim(f), note: 'Not a text file, so only its details are shown.' };
  const res = await google.raw(account, exportAs ? `${D}/files/${encodeURIComponent(file_id)}/export?mimeType=${encodeURIComponent(exportAs)}` : `${D}/files/${encodeURIComponent(file_id)}?alt=media`);
  const text = (await res.text()).slice(0, MAX_READ);
  return { ...slim(f), text, truncated: text.length >= MAX_READ };
}

export async function createFolder({ account = 'james', name, folder_id }) {
  acctOk(account);
  if (!name?.trim()) throw new Error('A folder needs a name');
  const parent = await writableParent(account, folder_id);
  const f = await google.api(account, `${D}/files?fields=${FIELDS}`, { method: 'POST', body: JSON.stringify({ name: name.trim().slice(0, 200), mimeType: FOLDER, parents: [parent] }) });
  log('orchestrator', 'drive', `${account}: created folder "${f.name}"`);
  return slim(f);
}

function multipart(meta, body, type) {
  const b = `sa${Math.random().toString(36).slice(2)}`;
  return { type: `multipart/related; boundary=${b}`, body: Buffer.concat([
    Buffer.from(`--${b}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${b}\r\ncontent-type: ${type}\r\n\r\n`),
    Buffer.isBuffer(body) ? body : Buffer.from(String(body)), Buffer.from(`\r\n--${b}--`)]) };
}
async function upload(account, meta, body, type) {
  const m = multipart(meta, body, type);
  return google.api(account, `${U}/files?uploadType=multipart&fields=${FIELDS}`, { method: 'POST', body: m.body, headers: { 'content-type': m.type } });
}

// Save bytes the server made (edited images) as a new file, in the right folder.
export async function saveBuffer(account, name, body, type, folder_id) {
  acctOk(account);
  const f = await upload(account, { name: String(name).slice(0, 200), parents: [await writableParent(account, folder_id)] }, body, type);
  log('orchestrator', 'drive', `${account}: saved "${f.name}" (${Math.round(body.length / 1024)} KB)`);
  return slim(f);
}

// kind doc: text or HTML becomes a Google Doc; kind sheet: CSV becomes a Google Sheet.
export async function createDoc({ account = 'james', title, content = '', kind = 'doc', folder_id }) {
  acctOk(account);
  if (!title?.trim()) throw new Error('A document needs a title');
  if (!['doc', 'sheet'].includes(kind)) throw new Error('kind must be doc or sheet');
  const parent = await writableParent(account, folder_id);
  const html = kind === 'doc' && /<[a-z][\s\S]*>/i.test(content);
  const f = await upload(account, { name: title.trim().slice(0, 200), parents: [parent], mimeType: kind === 'doc' ? 'application/vnd.google-apps.document' : 'application/vnd.google-apps.spreadsheet' },
    String(content).slice(0, 500000), kind === 'sheet' ? 'text/csv' : html ? 'text/html' : 'text/plain');
  log('orchestrator', 'drive', `${account}: created ${kind} "${f.name}"`);
  return slim(f);
}

// Upload from: an image the agents generated (images table), plain text, or a public https URL (SSRF-checked, 25 MB max).
export async function uploadFile({ account = 'james', name, image, url, text, folder_id }, ctx = {}) {
  acctOk(account);
  if ([image, url, text].filter((v) => v != null && v !== '').length !== 1) throw new Error('Give exactly one source: image, url or text');
  let body, type;
  if (image) { const r = db.prepare('select name, data from images where name = ?').get(String(image).replace(/^img\//, '')); if (!r) throw new Error(`No generated image "${image}"`); body = Buffer.from(r.data); type = 'image/webp'; name ||= r.name; }
  else if (text != null) { body = Buffer.from(String(text).slice(0, 2_000_000)); type = 'text/plain'; }
  else {
    await publicUrl(url);
    const res = await deps.fetch(url, { redirect: 'error' });
    if (!res.ok) throw new Error(`Couldn't download it (${res.status})`);
    type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    if (!/^(image|video|audio|text)\/|\/pdf$/.test(type)) throw new Error(`Only images, video, audio, text and PDFs can be uploaded (got ${type})`);
    body = Buffer.from(await res.arrayBuffer());
    ctx.taint?.(); // downloaded content
  }
  if (body.length > MAX_UPLOAD) throw new Error('Files are limited to 25 MB');
  if (!name?.trim()) throw new Error('Give the file a name');
  const parent = await writableParent(account, folder_id);
  const f = await upload(account, { name: name.trim().slice(0, 200), parents: [parent] }, body, type);
  log('orchestrator', 'drive', `${account}: uploaded "${f.name}" (${Math.round(body.length / 1024)} KB)`);
  return slim(f);
}

export async function move({ account = 'james', file_id, name, folder_id }) {
  acctOk(account);
  if (!name && !folder_id) throw new Error('Give a new name or a folder to move it to');
  if (account === 'owner' && !(await insideAppFolder('owner', file_id))) throw new Error('In your Drive, agents can only change files inside the "Sleeper Agent" folder.');
  const parent = folder_id ? await writableParent(account, folder_id) : null;
  const cur = parent ? (await google.api(account, `${D}/files/${encodeURIComponent(file_id)}?fields=parents`)).parents || [] : [];
  const qs = new URLSearchParams({ fields: FIELDS, ...(parent ? { addParents: parent, removeParents: cur.join(',') } : {}) });
  const f = await google.api(account, `${D}/files/${encodeURIComponent(file_id)}?${qs}`, { method: 'PATCH', body: JSON.stringify(name ? { name: String(name).slice(0, 200) } : {}) });
  return slim(f);
}

// Approval-gated tools (risk 'high'). Trash is recoverable for 30 days; nothing is ever permanently deleted.
export async function trash({ account = 'james', file_id }) {
  acctOk(account);
  if (account === 'owner' && !(await insideAppFolder('owner', file_id))) throw new Error('In your Drive, agents can only trash files inside the "Sleeper Agent" folder.');
  const f = await google.api(account, `${D}/files/${encodeURIComponent(file_id)}?fields=${FIELDS}`, { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
  log('orchestrator', 'drive', `${account}: moved "${f.name}" to trash (approved)`);
  return `Moved "${f.name}" to the trash (recoverable for 30 days).`;
}
export async function share({ account = 'james', file_id, email, anyone = false, role = 'reader' }) {
  acctOk(account);
  if (!['reader', 'commenter', 'writer'].includes(role)) throw new Error('role must be reader, commenter or writer');
  if (!anyone && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw new Error('Give an email address, or anyone=true for a link');
  await google.api(account, `${D}/files/${encodeURIComponent(file_id)}/permissions?sendNotificationEmail=${anyone ? 'false' : 'true'}`, { method: 'POST',
    body: JSON.stringify(anyone ? { type: 'anyone', role } : { type: 'user', role, emailAddress: email }) });
  const f = await google.api(account, `${D}/files/${encodeURIComponent(file_id)}?fields=${FIELDS}`);
  log('orchestrator', 'drive', `${account}: shared "${f.name}" with ${anyone ? 'anyone with the link' : email} as ${role} (approved)`);
  return `Shared "${f.name}" with ${anyone ? 'anyone who has the link' : email} (${role}): ${f.webViewLink}`;
}

// For the dashboard: recent files in James's Drive and in the owner's Sleeper Agent folder.
export async function recent() {
  const out = {};
  for (const a of ACCTS) {
    if (!google.driveReady(a)) { out[a] = { ready: false }; continue; }
    try { out[a] = { ready: true, files: await search({ account: a, folder_id: a === 'owner' ? await appFolder('owner') : undefined, max: 12 }) }; }
    catch (e) { out[a] = { ready: true, error: e.message }; }
  }
  return out;
}
