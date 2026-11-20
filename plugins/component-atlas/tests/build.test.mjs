import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildData, splitFontFaces, assertSize } from '../scripts/build.mjs';

const M = (bg = '#fff') => ({ bg, fg: '#000', border: null, radius: 4, fontFamily: 'Inter', fontSize: 14, fontWeight: 500, width: 80, height: 32, paddingX: 8, paddingY: 4 });
const cand = (index, html, extra = {}) => ({ index, kind: 'control', tag: 'button', text: 't', context: '', html, occurrences: 1, metrics: { light: M(), dark: M('#000') }, colors: ['#fff'], ...extra });
const FACE = (fam, pad = '') => `@font-face{font-family:"${fam}";src:url(data:font/woff2;base64,${pad}AAAA)}`;

async function write(dir, rel, data) {
  const f = path.join(dir, rel);
  await fs.mkdir(path.dirname(f), { recursive: true });
  await fs.writeFile(f, typeof data === 'string' ? data : JSON.stringify(data));
}

async function art(dir, id, { updated = '2026-11-01', kind = 'page', cands = [], classified, extract, styles, typeName } = {}) {
  const meta = { id, url: 'https://claude.ai/artifact/' + id, title: 'T ' + id, updated, kind };
  if (typeName) meta.typeName = typeName;
  await write(dir, `raw/${id}/meta.json`, meta);
  await write(dir, `raw/${id}/extract.json`, extract ?? { status: 'ok', warnings: [], candidates: cands.length });
  await write(dir, `raw/${id}/candidates.json`, cands);
  await write(dir, `raw/${id}/styles.json`, styles ?? { css: 'x', cssLight: '.a{}', cssDark: '.b{}', fontFaceCss: '', fontLinks: [] });
  if (classified !== undefined) await write(dir, `raw/${id}/classified.json`, classified);
  return { id, url: meta.url, title: meta.title, updated };
}

async function setup(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-'));
  try {
    const inv = await fn(dir);
    await write(dir, 'inventory.json', inv);
    return dir;
  } catch (e) { await fs.rm(dir, { recursive: true, force: true }); throw e; }
}
const ok = (project, items) => ({ project, items });

test('merges identical components across artifacts', async () => {
  const dir = await setup(async (d) => [
    await art(d, 'a', { updated: '2026-11-10', cands: [cand(0, '<button>Go</button>', { occurrences: 3 })], classified: ok('Nimb', [{ index: 0, keep: true, type: 'button', name: 'Go' }]) }),
    await art(d, 'b', { updated: '2026-11-01', cands: [cand(0, '<button>Go</button>', { occurrences: 2 })], classified: ok('Nimb', [{ index: 0, keep: true, type: 'button', name: 'Go' }]) }),
  ]);
  const data = await buildData({ dir, now: 'N' });
  assert.equal(data.components.length, 1);
  const c = data.components[0];
  assert.equal(c.sources.length, 2);
  assert.equal(c.occurrences, 5);
  assert.equal(c.artifactId, 'a');
  assert.equal(data.generatedAt, 'N');
  assert.equal(data.taxonomy.length, 18);
});

test('keeps only keep:true items and uses DS preset names', async () => {
  const dir = await setup(async (d) => [
    await art(d, 'a', { kind: 'design-system', cands: [cand(0, '<b>1</b>'), cand(1, '<b>2</b>'), cand(2, '<i>ds</i>', { kind: 'ds', presetName: 'Primary Button', description: 'desc' })],
      classified: ok('P', [{ index: 0, keep: true, type: 'button', name: 'One' }, { index: 1, keep: false, type: 'other', name: '' }, { index: 2, keep: true, type: 'button', name: 'zzz' }]) }),
  ]);
  const data = await buildData({ dir, now: 'N' });
  assert.equal(data.components.length, 2);
  const ds = data.components.find((c) => c.isDS);
  assert.equal(ds.name, 'Primary Button');
  assert.equal(ds.description, 'desc');
  assert.equal(data.artifacts[0].componentCount, 2);
});

test('measureOnly candidates are typed by autoType, not by the classifier', async () => {
  const dir = await setup(async (d) => [
    await art(d, 'a', { cands: [
      cand(0, '<div class="ca-body"><button>1</button></div>', { measureOnly: true }),
      cand(1, '<div class="ca-body"><input type="range"></div>', { measureOnly: true, tag: 'input' }),
      cand(2, '<div class="ca-body"><b>2</b></div>', { measureOnly: true, kind: 'ds', tag: 'div' }),
      cand(3, '<div class="ca-body"><button>V</button></div>'),
    ], classified: ok('P', [{ index: 0, keep: true, type: 'chip', name: 'X' }, { index: 3, keep: true, type: 'chip', name: 'Visible' }]) }),
  ]);
  const data = await buildData({ dir, now: 'N' });
  assert.equal(data.artifacts[0].status, 'ok', data.artifacts[0].note);
  assert.equal(data.components.length, 4);
  const m = data.components.filter((c) => c.measureOnly);
  assert.equal(m.length, 3);
  assert.equal(m.find((c) => c.name === 'X').type, 'button', 'classifier type ignored for measureOnly');
  assert.ok(m.some((c) => c.type === 'slider'));
  assert.ok(m.some((c) => c.type === 'other'));
  assert.equal(data.components.find((c) => c.name === 'Visible').type, 'chip', 'classifier type kept for visible');
});

test('classification missing a non-measureOnly item marks the artifact in error', async () => {
  const dir = await setup(async (d) => [
    await art(d, 'a', { cands: [cand(0, '<b>1</b>'), cand(1, '<b>2</b>'), cand(2, '<b>3</b>', { measureOnly: true })],
      classified: ok('P', [{ index: 0, keep: true, type: 'button', name: 'x' }]) }),
  ]);
  const data = await buildData({ dir, now: 'N' });
  assert.equal(data.artifacts[0].status, 'error');
  assert.match(data.artifacts[0].note, /1/);
});

test('design artifacts are built like pages', async () => {
  const dir = await setup(async (d) => [
    await art(d, 'g', { kind: 'design', typeName: 'Design', cands: [cand(0, '<button>Go</button>')], classified: ok('P', [{ index: 0, keep: true, type: 'button', name: 'Go' }]) }),
  ]);
  const data = await buildData({ dir, now: 'N' });
  assert.equal(data.artifacts[0].status, 'ok');
  assert.equal(data.artifacts[0].kind, 'design');
  assert.equal(data.components.length, 1);
});

test('invalid classified.json marks artifact error, others survive', async () => {
  const dir = await setup(async (d) => [
    await art(d, 'bad', { cands: [cand(0, '<b>1</b>')], classified: ok('P', [{ index: 9, keep: true, type: 'button', name: 'x' }]) }),
    await art(d, 'good', { cands: [cand(0, '<b>2</b>')], classified: ok('P', [{ index: 0, keep: true, type: 'button', name: 'y' }]) }),
    await art(d, 'none', { cands: [cand(0, '<b>3</b>')] }),
    await art(d, 'boom', { extract: { status: 'error', error: 'Page plantée', warnings: [], candidates: 0 } }),
  ]);
  const data = await buildData({ dir, now: 'N' });
  const by = Object.fromEntries(data.artifacts.map((a) => [a.id, a]));
  assert.equal(by.bad.status, 'error');
  assert.match(by.bad.note, /hors bornes/);
  assert.equal(by.good.status, 'ok');
  assert.equal(by.none.status, 'error');
  assert.equal(by.none.note, 'Classification manquante');
  assert.equal(by.boom.status, 'error');
  assert.equal(by.boom.note, 'Page plantée');
  assert.equal(data.components.length, 1);
  assert.equal(data.styles.bad, undefined);
});

test('other-type artifact is listed as skipped with 0 components', async () => {
  const dir = await setup(async (d) => [await art(d, 'o', { kind: 'other-type', typeName: 'Slides' })]);
  const data = await buildData({ dir, now: 'N' });
  assert.equal(data.artifacts[0].status, 'skipped');
  assert.equal(data.artifacts[0].note, 'Type Slides non analysé');
  assert.equal(data.artifacts[0].componentCount, 0);
  assert.equal(data.components.length, 0);
});

test('warnings carried and styles shaped without auto css', async () => {
  const dir = await setup(async (d) => [
    await art(d, 'a', { extract: { status: 'ok', warnings: ['CDN KO'], candidates: 1 }, cands: [cand(0, '<b>1</b>')], classified: ok('P', [{ index: 0, keep: true, type: 'button', name: 'y' }]) }),
  ]);
  const data = await buildData({ dir, now: 'N' });
  assert.deepEqual(data.artifacts[0].warnings, ['CDN KO']);
  assert.deepEqual(Object.keys(data.styles.a).sort(), ['cssDark', 'cssLight', 'fontIds', 'fontLinks']);
});

test('projects.json manual edits are preserved and new ones written', async () => {
  const dir = await setup(async (d) => {
    await write(d, 'projects.json', { a: 'Perso' });
    return [
      await art(d, 'a', { cands: [], classified: ok('Nimb', []) }),
      await art(d, 'b', { cands: [], classified: ok('Predict', []) }),
    ];
  });
  const data = await buildData({ dir, now: 'N' });
  const by = Object.fromEntries(data.artifacts.map((a) => [a.id, a.project]));
  assert.equal(by.a, 'Perso');
  assert.equal(by.b, 'Predict');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'projects.json'), 'utf8'));
  assert.deepEqual(saved, { a: 'Perso', b: 'Predict' });
});

test('seed only applies to inventory ids when projects.json is missing', async () => {
  const dir = await setup(async (d) => [await art(d, 'A4S58UgDUdvGZz7FfijDJz', { cands: [], classified: ok('Autre', []) })]);
  const data = await buildData({ dir, now: 'N' });
  assert.equal(data.artifacts[0].project, 'Hyperbeat');
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'projects.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), ['A4S58UgDUdvGZz7FfijDJz']);
});

test('removed artifacts disappear from data and cache', async () => {
  const dir = await setup(async (d) => {
    await write(d, 'plan.json', { toProcess: ['a'], removed: ['z'], unchanged: [] });
    await write(d, 'cache.json', { galleryUrl: 'u', artifacts: { z: { updated: '1', status: 'ok' }, a: { updated: '0', status: 'error' } } });
    await art(d, 'z', { cands: [], classified: ok('P', []) }); // stale raw leftover
    return [await art(d, 'a', { updated: '2026-11-05', cands: [], classified: ok('P', []) })];
  });
  const data = await buildData({ dir, now: 'N' });
  assert.deepEqual(data.artifacts.map((a) => a.id), ['a']);
  const cache = JSON.parse(await fs.readFile(path.join(dir, 'cache.json'), 'utf8'));
  assert.equal(cache.galleryUrl, 'u');
  assert.deepEqual(cache.artifacts, { a: { updated: '2026-11-05', status: 'ok' } });
});

test('fonts deduped by hash and oversized faces dropped with a note', async () => {
  const small = FACE('Inter');
  const huge = FACE('Mainneat Grotesk', 'A'.repeat(2_100_000));
  const styles = { css: '', cssLight: '', cssDark: '', fontFaceCss: small + huge, fontLinks: ['https://fonts.googleapis.com/css?family=X'] };
  const dir = await setup(async (d) => [
    await art(d, 'a', { styles, cands: [], classified: ok('P', []) }),
    await art(d, 'b', { styles: { ...styles, fontFaceCss: small }, cands: [], classified: ok('P', []) }),
  ]);
  const data = await buildData({ dir, now: 'N' });
  assert.equal(Object.keys(data.fonts).length, 1);
  assert.equal(data.styles.a.fontIds.length, 1);
  assert.deepEqual(data.styles.a.fontIds, data.styles.b.fontIds);
  assert.deepEqual(data.styles.a.fontLinks, styles.fontLinks);
  assert.ok(data.notes.includes('Police Mainneat Grotesk retirée (trop lourde) — T a'));
});

test('splitFontFaces is brace-aware', () => {
  const css = '@font-face{font-family:A;src:url("data:x{y}")}\n@font-face { font-family:B; }';
  assert.equal(splitFontFaces(css).length, 2);
  assert.deepEqual(splitFontFaces(''), []);
});

test('assertSize refuses data.json over 15 MB and lists biggest artifacts', () => {
  const data = { artifacts: [{ id: 'a', title: 'Big' }], styles: {}, fonts: { f: 'x'.repeat(16 * 1024 * 1024) }, components: [] };
  data.styles.a = { fontIds: ['f'] };
  assert.throws(() => assertSize(data, JSON.stringify(data)), /15 Mo[\s\S]*Big/);
});

test('0 candidates without classified.json is ok and empty', async () => {
  const dir = await setup(async (d) => [await art(d, 'empty', { cands: [] })]);
  const data = await buildData({ dir, now: 'N' });
  assert.equal(data.artifacts[0].status, 'ok');
  assert.equal(data.components.length, 0);
});
