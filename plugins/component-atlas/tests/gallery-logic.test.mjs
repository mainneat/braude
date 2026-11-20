import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fold, filterComponents, groupByTypeThenProject, parseRoute, enrichComponents, summarize, sinceFromPeriod,
  facetOptions, unanalysed, formatDate,
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
  assert.equal(s.projects, new Set(data.components.map((c) => c.project)).size);
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
