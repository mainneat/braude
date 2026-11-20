import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fold, filterComponents, groupByTypeThenProject, parseRoute, enrichComponents, summarize, sinceFromPeriod,
  facetOptions, unanalysed, formatDate, matrixCounts, colorPoints, metricSeries, hexToHsl, contrastRatio, seqStep, unpackComponent,
} from '../gallery/src/logic.mjs';

const TAX = [{ slug: 'button', label: 'Button' }, { slug: 'toggle', label: 'Toggle / switch' }, { slug: 'card', label: 'Card' }, { slug: 'other', label: 'Autre' }];
const C = (key, type, name, project, extra = {}) => ({ key, type, name, project, isDS: false, sources: [{ artifactId: 'a', occurrences: 1 }], occurrences: 1, artifactId: 'a', html: '', metrics: {}, colors: [], ...extra });
const comps = [
  C('k1', 'button', 'Bouton Élevé', 'Nimbus', { updated: '2026-11-10' }),
  C('k2', 'button', 'Ghost', 'Lumen', { updated: '2026-09-01' }),
  C('k3', 'toggle', 'Interrupteur', 'Nimbus', { updated: '2026-11-01' }),
  C('k4', 'other', 'Mesure', 'Nimbus', { measureOnly: true, updated: '2026-11-10' }),
  C('k5', 'card', 'Carte', 'Lumen', { updated: '2026-10-01' }),
  C('k6', 'button', 'Plein', 'Lumen', { updated: '2026-10-01' }),
];
const keys = (xs) => xs.map((c) => c.key);

test('fold lowercases and strips accents', () => {
  assert.equal(fold('Élevé ÇA'), 'eleve ca');
});

test('filterComponents', () => {
  assert.deepEqual(keys(filterComponents(comps, {})), ['k1', 'k2', 'k3', 'k5', 'k6'], 'measureOnly excluded by default');
  assert.equal(filterComponents(comps, { includeMeasureOnly: true }).length, 6);
  assert.deepEqual(keys(filterComponents(comps, { types: new Set(['button']) })), ['k1', 'k2', 'k6']);
  assert.deepEqual(keys(filterComponents(comps, { projects: new Set(['Nimbus']) })), ['k1', 'k3']);
  assert.deepEqual(keys(filterComponents(comps, { q: 'eleve' })), ['k1'], 'accent-insensitive');
  assert.deepEqual(keys(filterComponents(comps, { q: 'ÉLEVÉ' })), ['k1'], 'case-insensitive');
  assert.deepEqual(keys(filterComponents(comps, { q: 'lumen' })), ['k2', 'k5', 'k6'], 'matches project');
  assert.deepEqual(keys(filterComponents(comps, { q: '  nimbus  inter ' })), ['k3'], 'all words must match');
  assert.deepEqual(keys(filterComponents(comps, { since: '2026-10-15' })), ['k1', 'k3']);
  assert.deepEqual(keys(filterComponents(comps, { types: new Set(), projects: new Set() })), ['k1', 'k2', 'k3', 'k5', 'k6'], 'empty sets = no filter');
});

test('groupByTypeThenProject follows taxonomy order and omits empty types', () => {
  const g = groupByTypeThenProject(filterComponents(comps, {}), TAX);
  assert.deepEqual(g.map((x) => x.type), ['button', 'toggle', 'card']);
  assert.equal(g[0].label, 'Button');
  assert.deepEqual(g[0].projects.map((p) => p.project), ['Lumen', 'Nimbus'], 'projects by count desc');
  assert.deepEqual(keys(g[0].projects[0].items), ['k2', 'k6']);
  const unknown = groupByTypeThenProject([C('z', 'mystery', 'x', 'P')], TAX);
  assert.deepEqual(unknown.map((x) => x.type), ['other'], 'unknown types land in other');
});

test('groupByTypeThenProject breaks count ties by project name', () => {
  const g = groupByTypeThenProject([C('a', 'card', 'x', 'Zèbre'), C('b', 'card', 'y', 'Atelier')], TAX);
  assert.deepEqual(g[0].projects.map((p) => p.project), ['Atelier', 'Zèbre']);
});

test('parseRoute', () => {
  assert.deepEqual(parseRoute(''), { view: 'types' });
  assert.deepEqual(parseRoute('#'), { view: 'types' });
  assert.deepEqual(parseRoute('#types'), { view: 'types' });
  assert.deepEqual(parseRoute('#matrice'), { view: 'matrice' });
  assert.deepEqual(parseRoute('#couleurs'), { view: 'couleurs' });
  assert.deepEqual(parseRoute('#mesures'), { view: 'mesures' });
  assert.deepEqual(parseRoute('#c-0123abcd'), { view: 'detail', key8: '0123abcd' });
  assert.deepEqual(parseRoute('#nimporte'), { view: 'types' });
  assert.deepEqual(parseRoute('#c-XYZ'), { view: 'types' });
});

test('enrichComponents adds the latest source date and key8', () => {
  const arts = [{ id: 'a', updated: '2026-01-01' }, { id: 'b', updated: '2026-05-01' }];
  const [c] = enrichComponents([C('abcdef0123456', 'button', 'x', 'P', { sources: [{ artifactId: 'a', occurrences: 1 }, { artifactId: 'b', occurrences: 2 }] })], arts);
  assert.equal(c.updated, '2026-05-01');
  assert.equal(c.key8, 'abcdef01');
});

test('summarize counts visible components, analysed artifacts and projects', () => {
  const data = JSON.parse(readFileSync(new URL('./fixtures/data.sample.json', import.meta.url), 'utf8'));
  const s = summarize(data);
  assert.equal(s.components, data.components.filter((c) => !c.measureOnly).length);
  assert.equal(s.artifacts, data.artifacts.length);
  assert.equal(s.projects, new Set(data.components.filter((c) => !c.measureOnly).map((c) => c.project)).size);
});

test('summarize ignores projects that only have measure-only components', () => {
  const s = summarize({ artifacts: [], components: [C('a', 'button', 'x', 'P'), C('b', 'other', 'y', 'Q', { measureOnly: true })] });
  assert.deepEqual(s, { components: 1, artifacts: 0, projects: 1 });
});

test('sinceFromPeriod', () => {
  assert.equal(sinceFromPeriod('all', '2026-11-20T08:00:00Z'), undefined);
  assert.equal(sinceFromPeriod('30', '2026-11-20T08:00:00Z'), '2026-10-21');
  assert.equal(sinceFromPeriod('365', '2026-11-20T08:00:00Z'), '2025-11-20');
});

test('facetOptions lists projects and types with counts', () => {
  const f = facetOptions(comps, TAX);
  assert.deepEqual(f.projects, [{ value: 'Lumen', count: 3 }, { value: 'Nimbus', count: 2 }]);
  assert.deepEqual(f.types.map((t) => [t.value, t.count]), [['button', 3], ['toggle', 1], ['card', 1]]);
});

test('unanalysed lists skipped and error artifacts', () => {
  const u = unanalysed([{ id: 'a', status: 'ok' }, { id: 'b', status: 'skipped', note: 'n' }, { id: 'c', status: 'error', note: 'e' }]);
  assert.deepEqual(u.map((a) => a.id), ['b', 'c']);
});

test('formatDate is French and stable', () => {
  assert.equal(formatDate('2026-11-20T08:30:00.000Z'), '20 nov. 2026');
});

const M = (light, dark) => ({ metrics: { light: { bg: null, fg: null, border: null, radius: 0, fontSize: 14, height: 32, paddingX: 0, paddingY: 0, ...light }, dark: dark && { bg: null, fg: null, border: null, radius: 0, fontSize: 14, height: 32, paddingX: 0, paddingY: 0, ...dark } } });

test('matrixCounts', () => {
  const xs = [
    C('a', 'button', 'a', 'Nimbus'), C('b', 'button', 'b', 'Nimbus', { occurrences: 9 }), C('c', 'button', 'c', 'Lumen'),
    C('d', 'card', 'd', 'Lumen'), C('e', 'card', 'e', 'Nimbus', { measureOnly: true }), C('f', 'toggle', 'f', 'Zèbre', { measureOnly: true }),
  ];
  const m = matrixCounts(xs, TAX, ['Nimbus', 'Lumen', 'Zèbre']);
  assert.deepEqual(m.rows, ['button', 'card'], 'taxonomy order, types with no visible component omitted');
  assert.deepEqual(m.cols, ['Nimbus', 'Lumen'], 'given order, projects with no visible component omitted');
  assert.deepEqual(m.cells, [[2, 1], [0, 1]], 'weighted by 1 (not occurrences), empty cell = 0, measureOnly ignored');
  assert.equal(m.max, 2);
  const derived = matrixCounts(xs, TAX);
  assert.deepEqual(derived.cols, ['Lumen', 'Nimbus'], 'without projects: by count desc then name');
  assert.deepEqual(matrixCounts([], TAX, []), { rows: [], cols: [], cells: [], max: 0 });
  assert.deepEqual(matrixCounts([C('z', 'mystery', 'z', 'P')], TAX).rows, ['other'], 'unknown type lands in other');
});

test('seqStep maps a count to a ramp step', () => {
  assert.equal(seqStep(0, 10, 5), 0, 'empty cell has no step');
  assert.equal(seqStep(1, 10, 5), 1);
  assert.equal(seqStep(10, 10, 5), 5);
  assert.equal(seqStep(5, 10, 5), 3);
  assert.equal(seqStep(1, 1, 5), 5);
});

test('colorPoints dedupes and maps keys', () => {
  const xs = [
    C('a', 'button', 'a', 'P', { ...M({ bg: '#FFFFFF', fg: '#2f6bff' }, { bg: '#121212', fg: '#ffffff' }) }),
    C('b', 'card', 'b', 'P', { ...M({ bg: '#ffffff', border: '#2f6bff' }) }),
    C('c', 'other', 'c', 'P', { measureOnly: true, ...M({ fg: '#ff0000' }) }),
    C('d', 'other', 'd', 'P', { metrics: {} }),
  ];
  const light = colorPoints(xs, 'light');
  const white = light.find((p) => p.hex === '#ffffff');
  assert.ok(white, 'hex normalised to lowercase');
  assert.deepEqual(white.keys, ['a', 'b']);
  assert.deepEqual(light.find((p) => p.hex === '#2f6bff').keys, ['a', 'b'], 'fg and border both count, key listed once');
  assert.deepEqual(light.find((p) => p.hex === '#ff0000').keys, ['c'], 'measureOnly included');
  assert.equal(light.length, 3, 'null ignored');
  assert.equal(light.find((p) => p.hex === '#ff0000').h, 0);
  assert.equal(light.find((p) => p.hex === '#ff0000').s, 1);
  assert.equal(light.find((p) => p.hex === '#ff0000').l, 0.5);
  const dark = colorPoints(xs, 'dark');
  assert.deepEqual(dark.find((p) => p.hex === '#ffffff').keys, ['a', 'b'], 'a dark fg; b falls back to light metrics');
  assert.deepEqual(dark.find((p) => p.hex === '#121212').keys, ['a']);
});

test('hexToHsl and contrastRatio', () => {
  assert.deepEqual(hexToHsl('#ff0000'), { h: 0, s: 1, l: 0.5 });
  assert.deepEqual(hexToHsl('#0000ff80'), { h: 240, s: 1, l: 0.5 }, 'alpha ignored');
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#ffffff', '#ffffff'), 1);
  assert.ok(contrastRatio('#fafafa', '#ffffff') < 1.2);
});

test('metricSeries groups rounded values', () => {
  const xs = [
    C('a', 'button', 'a', 'P', M({ height: 36 })),
    C('b', 'button', 'b', 'P', M({ height: 36.4 })),
    C('c', 'button', 'c', 'P', { measureOnly: true, ...M({ height: 46 }) }),
    C('d', 'card', 'd', 'P', M({ height: 36 })),
    C('e', 'button', 'e', 'P', { metrics: {} }),
  ];
  assert.deepEqual(metricSeries(xs, 'button', 'height'), [{ value: 36, keys: ['a', 'b'] }, { value: 46, keys: ['c'] }]);
  assert.deepEqual(metricSeries(xs, 'button', 'radius'), [{ value: 0, keys: ['a', 'b', 'c'] }]);
  assert.deepEqual(metricSeries(xs, 'chip', 'height'), []);
});

test('matrix ramp: each step ink reaches 4.5:1 on its fill, in both themes', () => {
  const tpl = readFileSync(new URL('../gallery/index.template.html', import.meta.url), 'utf8');
  const blocks = [...tpl.matchAll(/(:root(?::not\(\[data-theme="light"\]\))?|:root\[data-theme="dark"\]) \{([^}]*)\}/g)].map((m) => m[2]);
  assert.equal(blocks.length, 3, 'light :root, media dark, data-theme dark');
  const ramp = (css) => [1, 2, 3, 4, 5].map((n) => ({
    n, fill: (css.match(new RegExp(`--ca-seq-${n}: (#[0-9a-f]{6})`)) || [])[1], ink: (css.match(new RegExp(`--ca-seq-ink-${n}: (#[0-9a-f]{6})`)) || [])[1],
  }));
  const [light, dark, darkToggle] = blocks.map(ramp);
  assert.deepEqual(dark, darkToggle, 'both dark blocks agree');
  for (const [theme, steps] of [['light', light], ['dark', dark]]) {
    for (const { n, fill, ink } of steps) {
      assert.ok(fill && ink, `${theme} step ${n} defined`);
      const r = contrastRatio(fill, ink);
      assert.ok(r >= 4.5, `${theme} step ${n}: ${ink} on ${fill} = ${r.toFixed(2)}:1`);
    }
  }
});

test('colorPoints order: neutrals first (light to dark), then by hue', () => {
  const xs = [
    C('a', 'button', 'a', 'P', M({ bg: '#2f6bff', fg: '#ffffff' })),
    C('b', 'button', 'b', 'P', M({ bg: '#ff0000', fg: '#000000', border: '#00ff00' })),
    C('c', 'button', 'c', 'P', M({ bg: '#fafafa', fg: '#800000' })),
  ];
  assert.deepEqual(colorPoints(xs, 'light').map((p) => p.hex),
    ['#ffffff', '#fafafa', '#000000', '#ff0000', '#800000', '#00ff00', '#2f6bff']);
});

test('stylesOf resolves per-group chunked styles, with legacy per-artifact fallback', async () => {
  const { stylesOf } = await import('../gallery/src/tile.mjs');
  const data = {
    css: { c1: '.btn{color:red}', c2: ':host{--a:1}', c3: ':host{--a:2}' },
    styles: { 'x:g1': { light: ['c1', 'c2'], dark: ['c1'], fontIds: ['f'], fontLinks: [] }, 'x:g2': { light: ['c1', 'c3'], dark: [], fontIds: [], fontLinks: [] },
      old: { cssLight: '.o{}', cssDark: '.p{}' } },
  };
  const a = stylesOf(data, { artifactId: 'x', styleId: 'x:g1' });
  assert.equal(a.cssLight, '.btn{color:red}\n:host{--a:1}');
  assert.equal(a.cssDark, '.btn{color:red}');
  assert.deepEqual(a.fontIds, ['f']);
  assert.equal(stylesOf(data, { artifactId: 'x', styleId: 'x:g1' }), a, 'memoised: one sheet per group');
  assert.match(stylesOf(data, { artifactId: 'x', styleId: 'x:g2' }).cssLight, /--a:2/);
  assert.equal(stylesOf(data, { artifactId: 'old' }).cssLight, '.o{}');
});

test('unpackComponent restores the compact data.json record', () => {
  const c = unpackComponent({ key: 'k', artifactId: 'x', occurrences: 3, sg: 'g1',
    metrics: { light: { bg: '#fff', fg: '#000', height: 32 }, dark: { bg: '#111' } } });
  assert.deepEqual(c.sources, [{ artifactId: 'x', occurrences: 3 }]);
  assert.equal(c.styleId, 'x:g1');
  assert.equal(c.sg, undefined);
  assert.equal(c.isDS, false);
  assert.deepEqual(c.metrics.dark, { bg: '#111', fg: '#000', height: 32 });
  // Déjà complet : inchangé.
  const full = { key: 'k', artifactId: 'x', occurrences: 1, isDS: true, styleId: 'x:main', sources: [{ artifactId: 'y', occurrences: 1 }],
    metrics: { light: { bg: '#fff' }, dark: { bg: '#000' } } };
  assert.deepEqual(unpackComponent(full), full);
});
