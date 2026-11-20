import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { TAXONOMY } from '../scripts/lib/taxonomy.mjs';

const SKILL_DIR = fileURLToPath(new URL('../skills/component-atlas/', import.meta.url));
const md = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');

test('frontmatter has name and description', () => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  assert.ok(m, 'frontmatter missing');
  assert.match(m[1], /^name:\s*component-atlas\s*$/m);
  assert.match(m[1], /^description:\s*\S+/m);
});

test('every referenced script exists', () => {
  const refs = [...md.matchAll(/<base>\/\.\.\/\.\.\/([\w./-]+\.mjs)/g)].map((r) => r[1]);
  assert.ok(refs.length >= 4);
  for (const r of new Set(refs)) assert.ok(existsSync(path.join(SKILL_DIR, '..', '..', r)), `missing ${r}`);
});

test('every taxonomy slug appears', () => {
  for (const { slug } of TAXONOMY) assert.ok(md.includes('`' + slug + '`'), `slug ${slug} missing`);
});

test('check.mjs exits 0 when the browser is available', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('node', [fileURLToPath(new URL('../scripts/check.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok/);
});
