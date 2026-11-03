// Build 5: website studio (sanitizing, Netlify publishing), content calendar, approvals.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db } = await import('../src/db.js');
const studio = await import('../src/studio.js');
const vault = await import('../src/vault.js');
const { unzip } = await import('../src/documents.js');
const { deps, runAgent } = await import('../src/agent.js');

const page = (body) => `<!doctype html><html><head><title>x</title></head><body>${body}</body></html>`;

test('sanitizer removes anything that can run code, phish or load third-party code', () => {
  const dirty = page(`<h1 onclick="steal()">Hi</h1><script>alert(1)</script><SCRIPT src=x></SCRIPT><iframe src="https://evil"></iframe>
    <a href="javascript:alert(1)">x</a><a href=" JaVaScRiPt:alert(1)">y</a><img src=x onerror=alert(1)><form action="https://evil"><input></form>
    <meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><link rel="stylesheet" href="https://evil/x.css">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter"><svg><script>x</script><a xlink:href="javascript:x">s</a></svg>
    <style>@import url("https://evil/x.css"); @import url(https://fonts.googleapis.com/css2?family=Lora);</style>`);
  const clean = studio.sanitizeHtml(dirty);
  for (const bad of ['<script', '<SCRIPT', 'onclick', 'onerror', '<iframe', 'javascript:', 'JaVaScRiPt', '<form', 'http-equiv', '<base', 'evil/x.css'])
    assert.ok(!clean.includes(bad), `${bad} survived`);
  assert.match(clean, /fonts\.googleapis\.com\/css2\?family=Inter/, 'Google Fonts allowed');
  assert.match(clean, /family=Lora/);
  assert.match(clean, /<h1>Hi<\/h1>/);
});

test('saving validates and sanitizes; republishing marks a live site as changed', () => {
  assert.throws(() => studio.saveSite({ slug: 'Bad Slug', title: 't', html: page('') }), /slug/);
  assert.throws(() => studio.saveSite({ slug: 'ok', title: 't', html: '<p>not a document</p>' }), /complete document/);
  assert.match(studio.saveSite({ slug: 'raincross-pub', title: 'Raincross Pub', html: page('<h1>Pub</h1><script>x</script>') }), /NOT public yet.*offer to publish/);
  studio.saveSite({ slug: 'fonts', title: 'F', html: page('<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>') });
  assert.equal((studio.siteHtml('fonts').match(/rel="preconnect"/g) || []).length, 2, 'font preconnects kept');
  assert.ok(!studio.siteHtml('raincross-pub').includes('<script'));
  assert.equal(studio.listSites()[0].status, 'draft');
});

test('zip is a valid archive Netlify can read', () => {
  const files = unzip(studio.zip({ 'index.html': '<html>héllo</html>' }));
  assert.equal(files.get('index.html')().toString(), '<html>héllo</html>');
});

test('publishing creates the Netlify site once, deploys, records the live URL, and reuses the site next time', async () => {
  vault.setup('correct horse battery');
  vault.save({ name: 'netlify', kind: 'api_key', value: 'nfp_test' });
  const calls = [];
  studio.deps.sleep = async () => {};
  studio.deps.fetch = async (url, o) => {
    calls.push(`${o.method} ${url.replace('https://api.netlify.com/api/v1', '')}`);
    assert.equal(o.headers.authorization, 'Bearer nfp_test');
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (o.method === 'POST' && url.endsWith('/sites')) return ok({ id: 'site1' });
    if (url.endsWith('/deploys')) { assert.equal(o.headers['content-type'], 'application/zip'); return ok({ id: 'd1', state: 'uploading' }); }
    if (url.endsWith('/deploys/d1')) return ok({ id: 'd1', state: 'ready' });
    if (url.endsWith('/sites/site1')) return ok({ ssl_url: 'https://raincross-pub-ab12c.netlify.app' });
    return ok({});
  };
  assert.match(await studio.publishSite('raincross-pub'), /netlify\.app/);
  assert.equal(studio.listSites()[0].status, 'live');
  studio.saveSite({ slug: 'raincross-pub', title: 'Raincross Pub', html: page('<h1>New menu</h1>') });
  assert.equal(studio.listSites()[0].status, 'changed');
  calls.length = 0;
  await studio.publishSite('raincross-pub');
  assert.ok(!calls.includes('POST /sites'), 'existing Netlify site reused, same URL');
});

test('posts: drafted with schedule; approval without a posting service makes them ready to copy; with Ayrshare they post', async () => {
  assert.throws(() => studio.draftPost({ text: 'x', platforms: ['myspace'] }), /Unknown platform/);
  studio.draftPost({ text: 'New site for @raincrosspub is live!', platforms: ['instagram'], scheduled_at: '2099-01-02T09:00' });
  const p = studio.listPosts()[0];
  assert.ok(p.scheduled_at.startsWith('2099-01-02T'));
  assert.match(await studio.publishPost(p.id), /Copy it/);
  vault.save({ name: 'ayrshare', kind: 'api_key', value: 'ayr_test' });
  studio.deps.fetch = async (url, o) => { const b = JSON.parse(o.body); assert.deepEqual(b.platforms, ['instagram']); assert.match(b.scheduleDate, /^2099-01-02T\d\d:00:00Z$/); return { ok: true, status: 200, json: async () => ({ status: 'scheduled', id: 'a1' }) }; };
  assert.match(await studio.publishPost(p.id), /scheduled/);
});

test('agents: drafts are allowed after web research, but publishing always waits for approval', async () => {
  db.exec('delete from approvals');
  const usage = { input_tokens: 1, output_tokens: 1 };
  const script = [
    { stop_reason: 'end_turn', usage: { ...usage, server_tool_use: { web_search_requests: 1 } }, content: [{ type: 'server_tool_use', id: 's', name: 'web_search', input: { query: 'raincross pub hours' } }, { type: 'text', text: 'researched' }] },
  ];
  deps.client = { messages: { create: async (p) => script.length ? script.shift() : null } };
  const calls = [];
  const replies = [
    { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't1', name: 'save_site', input: { slug: 'cafe', title: 'Cafe', html: page('<h1>Cafe</h1>') } }] },
    { stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 't2', name: 'publish_site', input: { slug: 'cafe' } }] },
    { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'done' }] },
  ];
  deps.client = { messages: { create: async (p) => (calls.push(p), replies.shift()) } };
  await runAgent('designer', 'build a site for Cafe', 1, { tainted: true });
  assert.ok(studio.siteHtml('cafe'), 'draft saved despite tainted run');
  assert.equal(db.prepare("select count(*) n from approvals where tool = 'publish_site'").get().n, 0, 'designer cannot publish at all (not in its tools)');
  assert.ok(!calls[0].tools.some((t) => t.name === 'publish_site'));
});

test('James asking to publish files an approval instead of going live', async () => {
  db.exec('delete from approvals');
  const usage = { input_tokens: 1, output_tokens: 1 }, sent = [];
  const replies = [{ stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'p1', name: 'publish_site', input: { slug: 'cafe' } }] }, { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'Waiting for your approval.' }] }];
  deps.client = { messages: { create: async () => replies.shift() } };
  studio.deps.fetch = async (url) => (sent.push(url), { ok: true, json: async () => ({}) });
  await runAgent('orchestrator', 'publish the cafe site');
  assert.equal(db.prepare("select count(*) n from approvals where tool = 'publish_site' and status = 'pending'").get().n, 1);
  assert.equal(sent.length, 0, 'nothing sent to Netlify');
});

test('private draft links: per-site unguessable token, wrong token gets nothing, strict no-script headers', () => {
  const t = studio.previewToken('raincross-pub');
  assert.ok(t.length >= 20);
  assert.equal(studio.previewToken('raincross-pub'), t, 'stable per site');
  assert.match(studio.previewHtml('raincross-pub', t), /<h1>/);
  assert.equal(studio.previewHtml('raincross-pub', 'x'.repeat(t.length)), null);
  assert.equal(studio.previewHtml('raincross-pub', ''), null);
  assert.equal(studio.previewHtml('cafe', t), null, "one site's token doesn't open another");
  assert.match(studio.PREVIEW_HEADERS['content-security-policy'], /default-src 'none'.*sandbox/);
  assert.ok(!/script-src/.test(studio.PREVIEW_HEADERS['content-security-policy']), 'no scripts allowed at all');
});

test('images: generated once, cost counted, inlined in previews, shipped in the publish zip, refused over budget', async () => {
  vault.save({ name: 'openai', kind: 'api_key', value: 'sk-test' });
  const png = Buffer.from('fake-webp-bytes');
  let zipped;
  studio.deps.fetch = async (url, o) => {
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (url.includes('openai.com')) {
      assert.equal(o.headers.authorization, 'Bearer sk-test');
      assert.equal(JSON.parse(o.body).size, '1536x1024');
      return ok({ data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 100, output_tokens: 1000 } });
    }
    if (url.endsWith('/deploys')) { zipped = o.body; return ok({ id: 'd2', state: 'ready' }); }
    if (url.endsWith('/sites/site1')) return ok({ ssl_url: 'https://raincross-pub-ab12c.netlify.app' });
    return ok({});
  };
  const spent = () => db.prepare("select coalesce(sum(usd), 0) u from costs where agent = 'designer'").get().u, before = spent();
  assert.match(await studio.generateImage({ name: 'hero-cake', prompt: 'a three-tier wedding cake' }, 'designer'), /img\/hero-cake\.webp/);
  const cost = spent() - before;
  assert.ok(Math.abs(cost - 0.0405) < 1e-9, `cost recorded (${cost})`);
  studio.saveSite({ slug: 'raincross-pub', title: 'Raincross Pub', html: page('<img src="img/hero-cake.webp" alt="cake"><img src="https://x.com/img/hero-cake.webp" alt="">') });
  const prev = studio.inlineImages(studio.siteHtml('raincross-pub'));
  assert.ok(prev.includes(`src="data:image/webp;base64,${png.toString('base64')}"`), 'inlined for preview');
  assert.ok(prev.includes('https://x.com/img/hero-cake.webp'), 'external URLs untouched');
  await studio.publishSite('raincross-pub');
  const files = unzip(zipped);
  assert.deepEqual(files.get('img/hero-cake.webp')(), png, 'image shipped next to index.html');
  db.prepare("update agents set daily_budget_usd = 0.01 where name = 'designer'").run();
  await assert.rejects(studio.generateImage({ name: 'x2', prompt: 'more' }, 'designer'), /daily budget/);
});
