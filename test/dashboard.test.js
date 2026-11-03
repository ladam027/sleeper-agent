// The dashboard is one static HTML file; a syntax error in its script would blank the whole page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';

test('dashboard inline script compiles', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1);
  for (const code of scripts) assert.doesNotThrow(() => new Script(code), 'syntax error in public/index.html');
});
