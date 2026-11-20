// Logique pure de la galerie (aucun accès au DOM) : filtres, regroupements, routage.
// Concaténé dans index.html par build.mjs : noms de premier niveau uniques entre modules.

const MONTHS_FR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const ROUTE_VIEWS = new Set(['types', 'matrice', 'couleurs', 'mesures']);
const DAY_MS = 86400000;

export function fold(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const hasAny = (set) => set && set.size > 0;

export function filterComponents(components, { types, projects, q, since, includeMeasureOnly = false } = {}) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  return components.filter((c) => {
    if (c.measureOnly && !includeMeasureOnly) return false;
    if (hasAny(types) && !types.has(c.type)) return false;
    if (hasAny(projects) && !projects.has(c.project)) return false;
    if (since && !(String(c.updated ?? '') >= since)) return false;
    if (words.length) {
      const hay = fold(`${c.name} ${c.project}`);
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

const byCountThenName = (a, b) => b.count - a.count || a.value.localeCompare(b.value, 'fr');

export function groupByTypeThenProject(components, taxonomy) {
  const known = new Set(taxonomy.map((t) => t.slug));
  const byType = new Map();
  for (const c of components) {
    const type = known.has(c.type) ? c.type : 'other';
    if (!byType.has(type)) byType.set(type, new Map());
    const byProject = byType.get(type);
    if (!byProject.has(c.project)) byProject.set(c.project, []);
    byProject.get(c.project).push(c);
  }
  const out = [];
  for (const t of taxonomy) {
    const byProject = byType.get(t.slug);
    if (!byProject) continue;
    const projects = [...byProject].map(([project, items]) => ({ value: project, count: items.length, items }))
      .sort(byCountThenName).map(({ value, items }) => ({ project: value, items }));
    out.push({ type: t.slug, label: t.label, projects });
  }
  return out;
}

export function parseRoute(hash) {
  const h = String(hash ?? '').replace(/^#/, '');
  const m = /^c-([0-9a-f]{8})$/.exec(h);
  if (m) return { view: 'detail', key8: m[1] };
  return { view: ROUTE_VIEWS.has(h) ? h : 'types' };
}

/**
 * Reconstitue un composant de data.json (format compact écrit par build.mjs) : `sources` implicite,
 * `isDS`, `styleId` depuis son groupe `sg`, mesures sombres complétées par les claires.
 * Sans effet sur un composant déjà complet.
 */
export function unpackComponent(c) {
  const out = { ...c, isDS: !!c.isDS };
  if (!out.sources) out.sources = [{ artifactId: c.artifactId, occurrences: c.occurrences ?? 1 }];
  if (!out.styleId && c.sg !== undefined) out.styleId = `${c.artifactId}:${c.sg}`;
  delete out.sg;
  const m = c.metrics;
  if (m && m.light) out.metrics = { light: m.light, dark: { ...m.light, ...(m.dark || {}) } };
  return out;
}

export function enrichComponents(components, artifacts) {
  const updated = new Map(artifacts.map((a) => [a.id, a.updated]));
  return components.map(unpackComponent).map((c) => {
    let latest = '';
    for (const s of c.sources ?? []) {
      const u = updated.get(s.artifactId) ?? '';
      if (u > latest) latest = u;
    }
    return { ...c, updated: latest || c.updated || '', key8: String(c.key).slice(0, 8) };
  });
}

export function summarize(data) {
  const visible = data.components.filter((c) => !c.measureOnly);
  return {
    components: visible.length,
    artifacts: data.artifacts.length,
    projects: new Set(visible.map((c) => c.project)).size,
  };
}

/** Période ('all' | nombre de jours) → date ISO (AAAA-MM-JJ) à partir de laquelle garder, relative à `ref`. */
export function sinceFromPeriod(period, ref) {
  if (!period || period === 'all') return undefined;
  const days = Number(period);
  const base = Date.parse(ref);
  if (!Number.isFinite(days) || !Number.isFinite(base)) return undefined;
  return new Date(base - days * DAY_MS).toISOString().slice(0, 10);
}

export function facetOptions(components, taxonomy) {
  const visible = components.filter((c) => !c.measureOnly);
  const count = (key) => {
    const m = new Map();
    for (const c of visible) m.set(c[key], (m.get(c[key]) ?? 0) + 1);
    return m;
  };
  const p = count('project');
  const t = count('type');
  return {
    projects: [...p].map(([value, n]) => ({ value, count: n })).sort(byCountThenName),
    types: taxonomy.filter((x) => t.has(x.slug)).map((x) => ({ value: x.slug, label: x.label, count: t.get(x.slug) })),
  };
}

export function unanalysed(artifacts) {
  return artifacts.filter((a) => a.status === 'skipped' || a.status === 'error');
}

export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS_FR[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Libellé affiché d'un type (slug inconnu : le slug). */
export function typeLabel(taxonomy, slug) {
  return (taxonomy.find((t) => t.slug === slug) ?? { label: slug }).label;
}

// ── Vues de comparaison (Matrice, Couleurs, Mesures) ──────────────────────────

const COLOR_ROLES = ['bg', 'fg', 'border'];
/** Saturation sous laquelle la teinte n'a plus de sens (gris, blancs, noirs). */
export const NEUTRAL_S = 0.1;

/** Comptes type × projet des composants visibles (non measureOnly), pondérés par 1. */
export function matrixCounts(components, taxonomy, projects) {
  const known = new Set(taxonomy.map((t) => t.slug));
  const counts = new Map(); // type → Map(projet → n)
  const perProject = new Map();
  for (const c of components) {
    if (c.measureOnly) continue;
    const type = known.has(c.type) ? c.type : 'other';
    if (!counts.has(type)) counts.set(type, new Map());
    const row = counts.get(type);
    row.set(c.project, (row.get(c.project) ?? 0) + 1);
    perProject.set(c.project, (perProject.get(c.project) ?? 0) + 1);
  }
  const rows = taxonomy.map((t) => t.slug).filter((s) => counts.has(s));
  const cols = (projects ?? [...perProject].map(([value, count]) => ({ value, count })).sort(byCountThenName).map((p) => p.value))
    .filter((p) => perProject.has(p));
  const cells = rows.map((r) => cols.map((p) => counts.get(r).get(p) ?? 0));
  const max = cells.reduce((m, row) => Math.max(m, ...row), 0);
  return { rows, cols, cells, max };
}

/** Marche (1..steps) d'une rampe séquentielle pour `count` sur `max` ; 0 pour une case vide. */
export function seqStep(count, max, steps) {
  if (!(count > 0) || !(max > 0)) return 0;
  return Math.min(steps, Math.max(1, Math.ceil((count / max) * steps)));
}

// '#rgb'|'#rrggbb'[aa] → {h:0-360, s:0-1, l:0-1} (alpha ignoré). Partagé avec scripts/lib/color.mjs.
export function hexToHsl(hex) {
  let v = String(hex).replace('#', '');
  if (v.length === 3 || v.length === 4) v = [...v].map((c) => c + c).join('');
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function relLuminance(hex) {
  const v = String(hex).replace('#', '');
  const full = v.length === 3 || v.length === 4 ? [...v].map((c) => c + c).join('') : v;
  const lin = (i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}

/** Rapport de contraste WCAG 2 entre deux couleurs hex (alpha ignoré). */
export function contrastRatio(a, b) {
  const [x, y] = [relLuminance(a), relLuminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const themeMetrics = (c, theme) => (c.metrics && ((theme === 'dark' && c.metrics.dark) || c.metrics.light)) || null;

/** Couleurs uniques (fond, texte, bordure) du thème, avec les clés des composants qui les utilisent, triées (voir plus bas). */
export function colorPoints(components, theme) {
  const byHex = new Map();
  for (const c of components) {
    const m = themeMetrics(c, theme);
    if (!m) continue;
    for (const role of COLOR_ROLES) {
      if (!m[role]) continue;
      const hex = String(m[role]).toLowerCase();
      if (!byHex.has(hex)) byHex.set(hex, new Set());
      byHex.get(hex).add(c.key);
    }
  }
  // Ordre de lecture (et de tabulation) : neutres du clair au foncé, puis par teinte, puis du clair au foncé.
  const neutral = (p) => (p.s < NEUTRAL_S ? 0 : 1);
  return [...byHex].map(([hex, keys]) => ({ hex, ...hexToHsl(hex), keys: [...keys] }))
    .sort((a, b) => neutral(a) - neutral(b) || (neutral(a) ? a.h - b.h : 0) || b.l - a.l);
}

/** Valeurs distinctes (arrondies au px, triées) d'une mesure pour un type, measureOnly inclus. */
export function metricSeries(components, type, metric) {
  const byValue = new Map();
  for (const c of components) {
    if (c.type !== type) continue;
    const v = c.metrics && c.metrics.light ? c.metrics.light[metric] : undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const r = Math.round(v);
    if (!byValue.has(r)) byValue.set(r, []);
    byValue.get(r).push(c.key);
  }
  return [...byValue].sort((a, b) => a[0] - b[0]).map(([value, keys]) => ({ value, keys }));
}
