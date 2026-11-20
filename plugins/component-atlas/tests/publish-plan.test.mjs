import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publishPlan, recordPublished } from '../scripts/publish-plan.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/publish-plan.mjs', import.meta.url));

/** dist/ factice : `n` artifacts, une part chacun (le premier en deux parts), cache optionnel. */
async function fakeDist(n, cache) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-pub-'));
  const dist = path.join(dir, 'dist');
  await fs.mkdir(path.join(dist, 'a'), { recursive: true });
  await fs.writeFile(path.join(dist, 'index.html'), '<title>x</title>');
  const artifacts = [];
  for (let i = 0; i < n; i++) {
    const shards = i === 0 ? [`a/art${i}.json`, `a/art${i}-2.json`] : [`a/art${i}.json`];
    for (const s of shards) await fs.writeFile(path.join(dist, s), JSON.stringify({ html: { k: 'x'.repeat(100) }, css: {} }));
    artifacts.push({ id: `art${i}`, shards });
  }
  artifacts.push({ id: 'skipped', shards: [] });
  await fs.writeFile(path.join(dist, 'data.json'), JSON.stringify({ artifacts, components: [] }));
  if (cache) await fs.writeFile(path.join(dir, 'cache.json'), JSON.stringify(cache));
  return dir;
}

test('a small gallery is one batch: page, data.json and every shard', async () => {
  const dir = await fakeDist(3);
  const batches = await publishPlan({ dir });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].file_path, path.join(dir, 'dist', 'index.html'));
  assert.deepEqual(Object.keys(batches[0].files).sort(), ['a/art0-2.json', 'a/art0.json', 'a/art1.json', 'a/art2.json', 'data.json']);
  assert.equal(batches[0].files['a/art1.json'], path.join(dir, 'dist', 'a', 'art1.json'));
});

test('more than 250 files are spread over several batches, data.json in the first', async () => {
  const dir = await fakeDist(300);
  const batches = await publishPlan({ dir });
  assert.equal(batches.length, 2);
  for (const b of batches) {
    assert.ok(Object.keys(b.files).length <= 250);
    assert.equal(b.file_path, path.join(dir, 'dist', 'index.html'));
  }
  assert.ok('data.json' in batches[0].files);
  assert.ok(!('data.json' in batches[1].files));
  const all = batches.flatMap((b) => Object.keys(b.files));
  assert.equal(all.length, 302); // data.json + 301 parts
  assert.equal(new Set(all).size, all.length);
});

test('a byte budget per publish also opens a new batch', async () => {
  const dir = await fakeDist(5);
  const batches = await publishPlan({ dir, maxBytes: 400 });
  assert.ok(batches.length >= 3);
});

test('shards published before but gone now are removed with null', async () => {
  const dir = await fakeDist(2, { galleryUrl: 'u', publishedShards: ['a/art0.json', 'a/art1.json', 'a/removed.json', 'a/art1-2.json'] });
  const [first, ...rest] = await publishPlan({ dir });
  assert.equal(rest.length, 0);
  assert.equal(first.files['a/removed.json'], null);
  assert.equal(first.files['a/art1-2.json'], null);
  assert.equal(typeof first.files['a/art0.json'], 'string');
});

test('--done records the gallery url and the published shards; the next plan removes nothing', async () => {
  const dir = await fakeDist(2, { galleryUrl: null, artifacts: { art0: { updated: 'x', status: 'ok' } } });
  const r = spawnSync('node', [SCRIPT, '--dir', dir, '--done', 'https://claude.ai/artifact/X'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const cache = JSON.parse(await fs.readFile(path.join(dir, 'cache.json'), 'utf8'));
  assert.equal(cache.galleryUrl, 'https://claude.ai/artifact/X');
  assert.deepEqual(cache.publishedShards, ['a/art0.json', 'a/art0-2.json', 'a/art1.json']);
  assert.deepEqual(cache.artifacts, { art0: { updated: 'x', status: 'ok' } });
  const out = spawnSync('node', [SCRIPT, '--dir', dir], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const plan = JSON.parse(out.stdout);
  assert.ok(Object.values(plan[0].files).every((v) => v !== null));
  await recordPublished({ dir, url: 'https://claude.ai/artifact/X' });
});

test('fails clearly when the build has not run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-pub-'));
  const r = spawnSync('node', [SCRIPT, '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /build\.mjs/);
});
