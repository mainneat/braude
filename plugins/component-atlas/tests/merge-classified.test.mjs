import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeClassified } from '../scripts/merge-classified.mjs';

const CLI = fileURLToPath(new URL('../scripts/merge-classified.mjs', import.meta.url));
const it = (index, name = 'n' + index) => ({ index, keep: true, type: 'button', name });
const setup = () => {
  const d = mkdtempSync(join(tmpdir(), 'atlas-merge-'));
  writeFileSync(join(d, 'candidates.json'), JSON.stringify([{ index: 0 }, { index: 1 }, { index: 2, measureOnly: true }, { index: 3 }]));
  return d;
};

test('merges partial classifications into classified.json and validates', () => {
  const d = setup();
  try {
    writeFileSync(join(d, 'classified.part1.json'), JSON.stringify({ project: 'Hyperbeat', items: [it(0), it(1)] }));
    writeFileSync(join(d, 'classified.part2.json'), JSON.stringify({ project: 'Hyperbeat', items: [it(3), it(1, 'dup')] }));
    const r = spawnSync(process.execPath, [CLI, d], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ok/);
    const c = JSON.parse(readFileSync(join(d, 'classified.json'), 'utf8'));
    assert.equal(c.project, 'Hyperbeat');
    assert.deepEqual(c.items.map((x) => x.index), [0, 1, 3]);
    assert.equal(c.items[1].name, 'n1', 'first part wins on duplicates');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('incomplete merge is reported (exit 1) but still written; majority project kept', () => {
  const d = setup();
  try {
    writeFileSync(join(d, 'classified.part1.json'), JSON.stringify({ project: 'A', items: [it(0)] }));
    writeFileSync(join(d, 'classified.part2.json'), JSON.stringify({ project: 'B', items: [it(1)] }));
    writeFileSync(join(d, 'classified.part3.json'), JSON.stringify({ project: 'B', items: [] }));
    const r = spawnSync(process.execPath, [CLI, d], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /manquante/);
    assert.ok(existsSync(join(d, 'classified.json')));
    assert.equal(mergeClassified(d).data.project, 'B');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('no part files is an error', () => {
  const d = setup();
  try {
    const r = spawnSync(process.execPath, [CLI, d], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /classified\.part/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
