// Point d'entrée : chargement de data.json, filtres, onglets, routage par hash.
// Concaténé dans index.html par build.mjs : noms de premier niveau uniques entre modules.
import { setSnippetTheme } from './tile.mjs';
import {
  filterComponents, parseRoute, enrichComponents, summarize, sinceFromPeriod, facetOptions, unanalysed, formatDate,
} from './logic.mjs';
import { h, plural, renderTypesView, renderDetail, renderUnanalysed, themeSwitch, refitPreviews } from './views.mjs';

// Vues à onglet. Les vues Matrice, Couleurs et Mesures s'ajoutent ici (Task 8).
const VIEWS = [
  { id: 'types', label: 'Par type', render: renderTypesView },
];

const app = {
  data: null,
  comps: [],
  byArtifact: new Map(),
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
  return { data: app.data, byArtifact: app.byArtifact, renderTheme: app.renderTheme, clearFilters };
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
  const comps = filterComponents(app.comps, currentFilters());
  const total = filterComponents(app.comps, {}).length;
  $('result-count').textContent = comps.length === total ? plural(total, 'composant', 'composants')
    : `${comps.length} sur ${total} composants`;
  def.render(view, comps, ctx());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => refitPreviews(view));
  if (prev === 'detail') scrollTo(0, app.scroll[def.id] || 0);
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
  app.comps = enrichComponents(data.components || [], data.artifacts || []);
  app.byArtifact = new Map((data.artifacts || []).map((a) => [a.id, a]));
  setupChrome();
  render();
  addEventListener('hashchange', render);
}

boot();
