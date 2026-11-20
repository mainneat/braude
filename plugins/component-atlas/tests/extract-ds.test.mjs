import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from '../scripts/lib/browser.mjs';
import { extractDesignSystem } from '../scripts/extract-ds.mjs';

const fx = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });
const run = () => extractDesignSystem(fx('ds'), { browser });

test('one ds tile per component, Cover skipped, metadata from source', async () => {
  const r = await run();
  assert.equal(r.status, 'ok', r.error);
  const tiles = r.candidates.filter((c) => c.kind === 'ds');
  assert.deepEqual(tiles.map((t) => t.presetName).sort(), ['Button', 'Toggle']);
  const b = tiles.find((t) => t.presetName === 'Button');
  assert.equal(b.context, 'Actions');
  assert.match(b.description, /^[^.]+\.$/);
  assert.equal(b.description, 'Primary action button.');
  assert.match(b.html, /^<div class="ca-body/);
  assert.doesNotMatch(b.html, /<link|<style/);
  r.candidates.forEach((c, i) => assert.equal(c.index, i));
});

test('inner controls are measureOnly and linked to their tile', async () => {
  const r = await run();
  const inner = r.candidates.filter((c) => c.measureOnly);
  assert.ok(inner.length >= 1);
  assert.ok(inner.every((c) => r.candidates[c.parentIndex].kind === 'ds'));
  const btnTile = r.candidates.findIndex((c) => c.presetName === 'Button');
  assert.ok(inner.some((c) => c.parentIndex === btnTile && c.tag === 'button'));
});

test('tokens reach the render (button bg equals token value)', async () => {
  const r = await run();
  const btn = r.candidates.find((c) => c.measureOnly && c.tag === 'button');
  assert.equal(btn.metrics.light.bg, '#2f6bff');
  assert.equal(btn.metrics.light.radius, 8);
  assert.match(r.styles.css, /fx-btn/);
});

test('missing library produces a warning, not a failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-ds-'));
  try {
    cpSync(fx('ds'), dir, { recursive: true });
    const p = join(dir, 'project', 'design-system.json');
    const j = JSON.parse(readFileSync(p, 'utf8'));
    j.libraries = [{ name: 'somelib', version: '1.0.0' }];
    (await import('node:fs')).writeFileSync(p, JSON.stringify(j));
    const r = await extractDesignSystem(dir, { browser });
    assert.equal(r.status, 'ok');
    assert.ok(r.warnings.some((w) => /somelib/.test(w)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI writes the same files as the page CLI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-ds-'));
  try {
    cpSync(fx('ds'), dir, { recursive: true });
    const out = execFileSync('node', [fileURLToPath(new URL('../scripts/extract-ds.mjs', import.meta.url)), dir], { encoding: 'utf8' });
    assert.equal(JSON.parse(out).status, 'ok');
    for (const f of ['candidates.json', 'styles.json', 'extract.json', 'contact.png']) assert.ok(existsSync(join(dir, f)), f);
    assert.ok(JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8')).length >= 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
