// Safe document fetching for research: PDF, CSV and .xlsx only. Files are read as data, never opened, run or saved.
// Guards: public internet only (no private/tailnet/cloud-metadata addresses, re-checked on every redirect),
// size caps (download and decompressed), file type checked by content (magic bytes), macro workbooks refused.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { inflateRawSync } from 'node:zlib';

export const deps = { fetch: (...a) => fetch(...a), lookup: (h) => lookup(h, { all: true }) };
export const MAX_BYTES = 10 * 1024 * 1024, MAX_UNZIPPED = 30 * 1024 * 1024, MAX_TEXT = 60000;

// IPv4/IPv6 ranges that are not the public internet (incl. Tailscale 100.64/10 and 169.254.169.254 metadata).
export function isPrivate(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff');
}

async function assertPublic(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('Only https:// links can be downloaded');
  if (u.username || u.password) throw new Error('Links with credentials are not allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await deps.lookup(host);
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('That address is not on the public internet');
  return u;
}

// ponytail: DNS is checked before connecting, not pinned; a rebinding attacker could race it. Pin the IP if this ever fetches untrusted links unattended at scale.
async function download(url) {
  let u = await assertPublic(url);
  for (let hop = 0; hop <= 3; hop++) {
    const res = await deps.fetch(u.href, { redirect: 'manual', headers: { 'user-agent': 'SleeperAgent/1.0 (research)' }, signal: AbortSignal.timeout(20000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) { u = await assertPublic(new URL(res.headers.get('location'), u).href); continue; }
    if (!res.ok) throw new Error(`The site returned ${res.status}`);
    if (Number(res.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('File is larger than 10 MB');
    const chunks = []; let size = 0;
    for await (const c of res.body) { size += c.length; if (size > MAX_BYTES) throw new Error('File is larger than 10 MB'); chunks.push(c); }
    return { buf: Buffer.concat(chunks), type: String(res.headers.get('content-type') || ''), url: u.href };
  }
  throw new Error('Too many redirects');
}

// Minimal zip reader (stored + deflate), enough for .xlsx. Caps total decompressed size against zip bombs.
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a valid spreadsheet (zip structure missing)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16), total = 0;
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt spreadsheet');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    files.set(name, () => {
      if ((total += usize) > MAX_UNZIPPED) throw new Error('Spreadsheet expands to more than 30 MB');
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), data = buf.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED });
      throw new Error('Unsupported compression');
    });
  }
  return files;
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');
const csvCell = (v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
const colNum = (ref) => ref.replace(/\d+/g, '').split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export function xlsxToText(buf) {
  const files = unzip(buf);
  if (!files.has('xl/workbook.xml')) throw new Error('Not an Excel workbook');
  if ([...files.keys()].some((n) => /vbaProject\.bin$/i.test(n))) throw new Error('Workbooks with macros are not allowed');
  const read = (n) => files.has(n) ? files.get(n)().toString('utf8') : '';
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const names = [...read('xl/workbook.xml').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => unxml(m[1]));
  const sheets = [...files.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  let out = '';
  sheets.forEach((s, i) => {
    out += `## Sheet: ${names[i] || `Sheet${i + 1}`}\n`;
    for (const row of read(s).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], body = c[2] || '', t = /\bt="(\w+)"/.exec(attrs)?.[1], ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
        const val = t === 's' ? shared[+v] ?? '' : t === 'inlineStr' ? unxml([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')) : unxml(v);
        cells[ref ? colNum(ref) : cells.length] = csvCell(val);
      }
      out += Array.from(cells, (x) => x ?? '').join(',') + '\n';
      if (out.length > MAX_TEXT) return;
    }
  });
  return out.slice(0, MAX_TEXT);
}

// Fetch and classify by content, not by what the server claims.
export async function fetchDocument(url) {
  const { buf, type, url: finalUrl } = await download(url);
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { kind: 'pdf', base64: buf.toString('base64'), url: finalUrl, bytes: buf.length };
  if (buf.readUInt32LE(0) === 0x04034b50) return { kind: 'sheet', text: xlsxToText(buf), url: finalUrl, bytes: buf.length };
  const looksCsv = /text\/csv|application\/csv/.test(type) || /\.csv(\?|$)/i.test(new URL(finalUrl).pathname);
  if (looksCsv && !buf.includes(0)) return { kind: 'sheet', text: buf.toString('utf8').slice(0, MAX_TEXT), url: finalUrl, bytes: buf.length };
  throw new Error('Only PDF, CSV and .xlsx files can be downloaded');
}
