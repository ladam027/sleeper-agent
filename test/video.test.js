// Build 10.2: the edit spec → ffmpeg plan (validated, no shell), and frames reaching the agent as images.
process.env.DB_PATH = ':memory:';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { db } = await import('../src/db.js');
const video = await import('../src/video.js');
const { TOOLS } = await import('../src/tools.js');
const { deps, runAgent } = await import('../src/agent.js');

const job = { duration: 60, has_audio: 1, transcript: JSON.stringify({ segments: [{ start: 2, end: 6, text: 'Welcome to the bakery' }, { start: 40, end: 44, text: 'Order by Friday' }] }) };

test('cuts, speed, vertical crop, captions re-timed to the edit, text from files, fades, ducked music', () => {
  const p = video.plan({ clips: [{ start: 0, end: 10 }, { start: 40, end: 50, speed: 2 }], crop: 'vertical', captions: true,
    texts: [{ text: "Maya's cakes", start: 0, end: 3, position: 'top' }], fade: { in: 0.5, out: 1 }, music: { volume: 0.2 } }, job);
  assert.equal(p.total, 15, '10s + 10s at 2x');
  assert.match(p.filter, /\[0:v\]trim=start=0:end=10,setpts=\(PTS-STARTPTS\)\/1\[v0\]/);
  assert.match(p.filter, /\[0:a\]atrim=start=40:end=50,asetpts=PTS-STARTPTS,atempo=2\[a1\]/);
  assert.match(p.filter, /concat=n=2:v=1:a=1\[vc\]\[ac\]/);
  assert.match(p.filter, /crop='min\(iw,ih\*9\/16\)'/);
  assert.match(p.files['captions.srt'], /00:00:02,000 --> 00:00:06,000\nWelcome to the bakery/, 'first line keeps its time');
  assert.match(p.files['captions.srt'], /00:00:10,000 --> 00:00:12,000\nOrder by Friday/, 'second line lands after the first clip, at 2x speed');
  assert.equal(p.files['text-0.txt'], "Maya's cakes", 'overlay text goes through a file, not the filter string');
  assert.ok(!p.filter.includes('Maya'), 'agent text never enters the filter string');
  assert.match(p.filter, /fade=t=out:st=14\.000:d=1/);
  assert.match(p.filter, /sidechaincompress/); assert.deepEqual(p.maps, ['-map', '[vout]', '-map', '[amix]']);
});

test('the spec is validated: speed, range, length, crop, captions without a transcript', () => {
  assert.throws(() => video.plan({ clips: [{ start: 0, end: 10, speed: 4 }] }, job), /speed must be between 0.5 and 2/);
  assert.throws(() => video.plan({ clips: [{ start: 50, end: 90 }] }, job), /end must be between/);
  assert.throws(() => video.plan({ crop: 'fisheye' }, job), /crop must be/);
  assert.throws(() => video.plan({ captions: true }, { ...job, transcript: '{"segments":[]}' }), /No transcript/);
  assert.throws(() => video.plan({ clips: Array.from({ length: 30 }, () => ({ start: 0, end: 30, speed: 0.5 })) }, job), /10 minutes or shorter/);
  const silent = video.plan({}, { ...job, has_audio: 0 });
  assert.deepEqual(silent.maps, ['-map', '[vout]'], 'no audio track, no audio map');
});

test('frames reach the agent as images; their text part is still redacted; the run is tainted', async () => {
  const orig = TOOLS.video_inspect.run;
  TOOLS.video_inspect.run = async (input, ctx) => { ctx.taint?.(); return { blocks: [{ type: 'text', text: 'card 4242 4242 4242 4242 on screen' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }] }; };
  const usage = { input_tokens: 1, output_tokens: 1 }, seen = [];
  const replies = [{ stop_reason: 'tool_use', usage, content: [{ type: 'tool_use', id: 'v1', name: 'video_inspect', input: { file_id: 'x' } }] }, { stop_reason: 'end_turn', usage, content: [{ type: 'text', text: 'ok' }] }];
  deps.client = { messages: { create: async (p) => (seen.push(JSON.parse(JSON.stringify(p.messages.at(-1)))), replies.shift()) } };
  await runAgent('designer', 'look at my clip');
  const result = seen[1].content[0];
  assert.equal(result.content[1].type, 'image');
  assert.match(result.content[0].text, /\[card number removed\]/);
  assert.ok(db.prepare("select count(*) n from activity where type = 'tainted'").get().n >= 1);
  TOOLS.video_inspect.run = orig;
});
