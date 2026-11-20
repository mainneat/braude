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

export function enrichComponents(components, artifacts) {
  const updated = new Map(artifacts.map((a) => [a.id, a.updated]));
  return components.map((c) => {
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
