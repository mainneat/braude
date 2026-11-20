import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadJson, saveJson, planRun } from '../scripts/lib/cache.mjs';

const PLAN = fileURLToPath(new URL('../scripts/plan.mjs', import.meta.url));

test('planRun', () => {
  const cache = { galleryUrl: null, artifacts: { a: { updated: '2026-11-10', status: 'ok' }, b: { updated: '2026-11-10', status: 'ok' }, c: { updated: '2026-11-01', status: 'error' } } };
  const r = planRun([{ id: 'a', updated: '2026-11-10' }, { id: 'b', updated: '2026-11-18' }, { id: 'c', updated: '2026-11-01' }, { id: 'd', updated: '2026-11-20' }], cache);
  assert.deepEqual(r.toProcess.sort(), ['b', 'c', 'd']);
  assert.deepEqual(r.unchanged, ['a']);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(planRun([{ id: 'a', updated: '2026-11-10' }], cache).removed.sort(), ['b', 'c']);
});

test('planRun: skipped only reprocessed when updated changes', () => {
  const cache = { galleryUrl: null, artifacts: { s: { updated: '1', status: 'skipped' } } };
  assert.deepEqual(planRun([{ id: 's', updated: '1' }], cache).unchanged, ['s']);
  assert.deepEqual(planRun([{ id: 's', updated: '2' }], cache).toProcess, ['s']);
});

test('loadJson / saveJson', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-'));
  const p = path.join(dir, 'x', 'y', 'f.json');
  assert.deepEqual(await loadJson(p, { z: 1 }), { z: 1 });
  await saveJson(p, { a: 1 });
  assert.deepEqual(await loadJson(p, null), { a: 1 });
});

test('plan CLI writes plan.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-'));
  const inv = [{ id: 'b', url: 'u', title: 'B', updated: '2' }, { id: 'a', url: 'u', title: 'A', updated: '1' }];
  await fs.writeFile(path.join(dir, 'inventory.json'), JSON.stringify(inv));
  const r = spawnSync('node', [PLAN, '--dir', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(await fs.readFile(path.join(dir, 'plan.json'), 'utf8'));
  assert.deepEqual(plan.toProcess, ['a', 'b']);
  assert.deepEqual(JSON.parse(r.stdout), plan);
});

test('plan CLI fails clearly without inventory.json', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-'));
  const r = spawnSync('node', [PLAN, '--dir', dir], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inventory\.json/);
});
