// Point d'entrée : chargement de data.json, filtres, onglets, routage par hash.
// Concaténé dans index.html par build.mjs : noms de premier niveau uniques entre modules.
import { setSnippetTheme } from './tile.mjs';
import {
  filterComponents, parseRoute, enrichComponents, summarize, sinceFromPeriod, facetOptions, unanalysed, formatDate,
} from './logic.mjs';
import {
  h, plural, renderTypesView, renderDetail, renderUnanalysed, themeSwitch, refitPreviews,
  renderMatrixView, renderColorsView, renderMetricsView, forgetLazy,
} from './views.mjs';

// Vues à onglet. `measureOnly` : la vue reçoit aussi les composants relevés pour mesure seulement.
const VIEWS = [
  { id: 'types', label: 'Par type', render: renderTypesView },
  { id: 'matrice', label: 'Matrice', render: renderMatrixView },
  { id: 'couleurs', label: 'Couleurs', render: renderColorsView, measureOnly: true },
  { id: 'mesures', label: 'Mesures', render: renderMetricsView, measureOnly: true },
];

const app = {
  data: null,
  comps: [],
  byArtifact: new Map(),
  byKey: new Map(),
  viewState: {}, // état propre aux vues (thème du nuancier, type mesuré), conservé entre rendus
  filters: { project: '', type: '', q: '', period: 'all' },
  renderTheme: 'auto',
  lastView: 'types',
  scroll: {},
};
const $ = (id) => document.getElementById(id);

function currentFilters() {
  const f = app.filters;
  return {
    projects: f.project ? new Set([f.project]) : undefined,
    types: f.type ? new Set([f.type]) : undefined,
    q: f.q,
    since: sinceFromPeriod(f.period, app.data.generatedAt),
  };
}

function ctx() {
  return {
    data: app.data, byArtifact: app.byArtifact, byKey: app.byKey, state: app.viewState,
    // Getter : une tuile montée plus tard (chargement paresseux) prend le thème du moment.
    get renderTheme() { return app.renderTheme; },
    clearFilters, goTypes, rerender: render, load: loadComponent, retry: retryComponent,
  };
}

// ── Fichiers de rendu par artifact (a/<artifactId>.json = {html, css, fonts}) ──
// data.json ne porte ni HTML ni CSS : chaque artifact a ses parts, chargées à la demande
// (tuile proche de l'écran, fiche ouverte, aperçu survolé). Une seule requête par part.
const SHARDS = new Map(); // chemin → Promise

function absorbShard(shard) {
  const d = app.data;
  Object.assign(d.css, (shard && shard.css) || {});
  Object.assign(d.fonts, (shard && shard.fonts) || {});
  for (const [key, html] of Object.entries((shard && shard.html) || {})) {
    const comp = app.byKey.get(key);
    if (comp) comp.html = html;
  }
}

function fetchShard(file) {
  let p = SHARDS.get(file);
  if (!p) {
    p = fetch(file, { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`${file} est introuvable (HTTP ${res.status}).`);
        return res.json();
      })
      .then(absorbShard);
    p.catch(() => { p.failed = true; });
    SHARDS.set(file, p);
  }
  return p;
}

/** Promesse résolue quand le HTML et le CSS du composant sont disponibles (rejet : fichier illisible). */
function loadComponent(comp) {
  if (!comp || comp.measureOnly || typeof comp.html === 'string') return Promise.resolve(comp);
  const art = app.byArtifact.get(comp.artifactId);
  const files = (art && art.shards) || [];
  if (!files.length) return Promise.reject(new Error('Aucun fichier de rendu publié pour cet artifact.'));
  return Promise.all(files.map(fetchShard)).then(() => {
    if (typeof comp.html !== 'string') throw new Error('Ce composant manque dans le fichier de son artifact.');
    return comp;
  });
}

/** Nouvel essai : oublie les parts en échec de l'artifact du composant, puis recharge. */
function retryComponent(comp) {
  const art = comp && app.byArtifact.get(comp.artifactId);
  for (const f of (art && art.shards) || []) if (SHARDS.get(f)?.failed) SHARDS.delete(f);
  return loadComponent(comp);
}

/** Ouvre la vue Par type filtrée sur un type et un projet (clic sur une case de la matrice). */
function goTypes({ type, project }) {
  app.filters.type = type;
  app.filters.project = project;
  $('f-type').value = type;
  $('f-project').value = project;
  if (location.hash === '#types') render();
  else location.hash = '#types';
}

function clearFilters() {
  app.filters = { project: '', type: '', q: '', period: 'all' };
  $('f-project').value = '';
  $('f-type').value = '';
  $('f-q').value = '';
  $('f-period').value = 'all';
  render();
}

function fillSelect(sel, first, options) {
  sel.replaceChildren(h('option', { value: '', text: first }),
    ...options.map((o) => h('option', { value: o.value, text: `${o.label ?? o.value} (${o.count})` })));
}

function setupChrome() {
  const d = app.data;
  const s = summarize(d);
  $('stats').replaceChildren(
    h('span', null, h('b', { text: String(s.components) }), s.components > 1 ? ' composants' : ' composant'),
    h('span', null, h('b', { text: String(s.artifacts) }), s.artifacts > 1 ? ' artifacts' : ' artifact'),
    h('span', null, h('b', { text: String(s.projects) }), s.projects > 1 ? ' projets' : ' projet'),
    h('span', null, 'généré le ', h('time', { datetime: d.generatedAt, text: formatDate(d.generatedAt) })));

  const facets = facetOptions(app.comps, d.taxonomy);
  fillSelect($('f-project'), 'Tous les projets', facets.projects);
  fillSelect($('f-type'), 'Tous les types', facets.types);
  $('f-project').addEventListener('change', (e) => { app.filters.project = e.target.value; render(); });
  $('f-type').addEventListener('change', (e) => { app.filters.type = e.target.value; render(); });
  $('f-period').addEventListener('change', (e) => { app.filters.period = e.target.value; render(); });
  let t;
  $('f-q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { app.filters.q = e.target.value; render(); }, 120);
  });

  $('render-theme').replaceChildren(themeSwitch('f-theme', app.renderTheme, (v) => {
    app.renderTheme = v;
    for (const tile of $('view').querySelectorAll('.tile')) setSnippetTheme(tile, v);
    refitPreviews($('view'));
  }));

  $('tabs').replaceChildren(...VIEWS.map((v) => h('a.tab', { href: `#${v.id}`, 'data-view': v.id, text: v.label })));
  renderUnanalysed($('unanalysed'), unanalysed(d.artifacts), d.notes || []);
  $('toolbar').hidden = false;
}

function render() {
  const route = parseRoute(location.hash);
  const view = $('view');
  const prev = app.lastView;
  if (prev !== 'detail') app.scroll[prev] = scrollY;
  // Rendu de la même vue (contrôle propre à la vue) : on garde le défilement et le focus.
  const focusId = view.contains(document.activeElement) ? document.activeElement.closest('[id]')?.id : null;
  forgetLazy(view);
  view.replaceChildren();
  view.removeAttribute('aria-busy');

  if (route.view === 'detail') {
    $('toolbar').hidden = true;
    const comp = app.comps.find((c) => c.key8 === route.key8);
    document.title = comp ? `${comp.name} · Component Atlas` : 'Component Atlas';
    renderDetail(view, comp, ctx());
    app.lastView = 'detail';
    scrollTo(0, 0);
    view.querySelector('h1')?.focus?.();
    return;
  }

  const def = VIEWS.find((v) => v.id === route.view) || VIEWS[0];
  document.title = 'Component Atlas';
  $('toolbar').hidden = false;
  for (const tab of $('tabs').children) {
    if (tab.dataset.view === def.id) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  }
  const filters = currentFilters();
  const comps = filterComponents(app.comps, filters);
  const total = filterComponents(app.comps, {}).length;
  $('result-count').textContent = comps.length === total ? plural(total, 'composant', 'composants')
    : `${comps.length} sur ${total} composants`;
  def.render(view, def.measureOnly ? filterComponents(app.comps, { ...filters, includeMeasureOnly: true }) : comps, ctx());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => refitPreviews(view));
  if (prev === 'detail') scrollTo(0, app.scroll[def.id] || 0);
  if (prev === def.id) {
    scrollTo(0, app.scroll[def.id] || 0);
    const el = focusId && document.getElementById(focusId);
    if (el) (el.querySelector('[aria-checked="true"]') || el).focus();
  }
  app.lastView = def.id;
}

function showError(message) {
  const view = $('view');
  view.removeAttribute('aria-busy');
  view.replaceChildren(h('div.state.state-error', { role: 'alert' },
    h('p.state-title', { text: "L'atlas n'a pas pu être chargé." }),
    h('p', { text: message }),
    h('p.muted', { text: 'Relancez la génération de l’atlas puis republiez la galerie avec son fichier data.json.' }),
    h('button.btn', { type: 'button', onclick: () => location.reload(), text: 'Réessayer' })));
}

async function boot() {
  let data;
  try {
    const res = await fetch('data.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`data.json est introuvable (HTTP ${res.status}).`);
    data = await res.json();
  } catch (e) {
    showError(e instanceof SyntaxError ? 'data.json est illisible (JSON invalide).' : (e.message || String(e)));
    return;
  }
  app.data = data;
  data.css = data.css || {};
  data.fonts = data.fonts || {};
  app.comps = enrichComponents(data.components || [], data.artifacts || []);
  app.byArtifact = new Map((data.artifacts || []).map((a) => [a.id, a]));
  app.byKey = new Map(app.comps.map((c) => [c.key, c]));
  setupChrome();
  render();
  addEventListener('hashchange', render);
}

boot();
