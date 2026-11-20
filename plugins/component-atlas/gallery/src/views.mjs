// Construction du DOM des vues (Par type, fiche, non analysés). Aucun état global ici :
// tout passe par `ctx` = { data, byArtifact, renderTheme, ... } fourni par main.mjs.
// Concaténé dans index.html par build.mjs : noms de premier niveau uniques entre modules.
import { mountSnippet, setSnippetTheme, pageScheme } from './tile.mjs';
import { groupByTypeThenProject, typeLabel, formatDate } from './logic.mjs';

/** h('div.a.b', {attr}, ...enfants) : chaînes → nœuds texte, null/false ignorés. */
export function h(tag, attrs, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const px = (n) => (Number.isFinite(n) ? `${Math.round(n)}` : '–');

function mountTile(host, comp, ctx, theme) {
  mountSnippet(host, { html: comp.html, styles: ctx.data.styles[comp.artifactId], fonts: ctx.data.fonts, theme });
}

function specimen(comp, ctx) {
  const stage = h('div.tile', { 'data-key': comp.key8, inert: true, 'aria-hidden': 'true' });
  const m = comp.metrics && comp.metrics.light;
  const card = h('a.specimen', { href: `#c-${comp.key8}`, 'aria-label': `${comp.name}, ${comp.project}` },
    stage,
    h('div.specimen-cap', null,
      h('span.specimen-name', { text: comp.name }),
      h('span.specimen-meta', null,
        comp.isDS ? h('span.badge', { text: 'DS', title: 'Issu du design system' }) : null,
        comp.occurrences > 1 ? h('span.occ', { text: `×${comp.occurrences}`, title: plural(comp.occurrences, 'occurrence', 'occurrences') }) : null,
        m ? h('span.dim', { text: `${px(m.width)}×${px(m.height)}` }) : null)));
  mountTile(stage, comp, ctx, ctx.renderTheme);
  return card;
}

export function renderTypesView(container, components, ctx) {
  const groups = groupByTypeThenProject(components, ctx.data.taxonomy);
  if (!groups.length) {
    container.append(h('div.empty', null,
      h('p', { text: 'Aucun composant ne correspond à ces filtres.' }),
      h('button.btn', { type: 'button', onclick: ctx.clearFilters, text: 'Effacer les filtres' })));
    return;
  }
  for (const g of groups) {
    const n = g.projects.reduce((s, p) => s + p.items.length, 0);
    const section = h('section.type', { id: `type-${g.type}`, 'aria-labelledby': `th-${g.type}` },
      h('header.type-head', null,
        h('h2', { id: `th-${g.type}`, text: g.label }),
        h('span.count', { text: plural(n, 'composant', 'composants') })));
    for (const p of g.projects) {
      section.append(h('div.project', null,
        h('h3.project-head', null, h('span', { text: p.project }), h('span.count', { text: String(p.items.length) })),
        h('div.grid', null, p.items.map((c) => specimen(c, ctx)))));
    }
    container.append(section);
  }
}

/** Copie `text` ; si le presse-papiers refuse, sélectionne le contenu de `pre`. */
function copyButton(label, getText, pre) {
  const btn = h('button.btn.btn-small', { type: 'button', text: label });
  const say = (msg) => {
    btn.textContent = msg;
    clearTimeout(btn.__t);
    btn.__t = setTimeout(() => { btn.textContent = label; }, 1800);
  };
  const selectPre = () => {
    const range = document.createRange();
    range.selectNodeContents(pre);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    say('Sélectionné, copiez avec Ctrl+C');
  };
  btn.addEventListener('click', () => {
    const text = getText();
    try {
      navigator.clipboard.writeText(text).then(() => say('Copié'), selectPre);
    } catch { selectPre(); }
  });
  return btn;
}

function swatch(hex) {
  if (!hex) return h('span.muted', { text: '–' });
  return h('span.sw', null, h('span.chip', { style: `background:${hex}` }), h('code', { text: hex }));
}

function metricsTable(metrics) {
  const L = metrics.light || {};
  const D = metrics.dark || L;
  const rows = [
    ['Fond', swatch(L.bg), swatch(D.bg)],
    ['Texte', swatch(L.fg), swatch(D.fg)],
    ['Bordure', swatch(L.border), swatch(D.border)],
    ['Rayon', `${px(L.radius)} px`, `${px(D.radius)} px`],
    ['Police', L.fontFamily || '–', D.fontFamily || '–'],
    ['Taille', `${px(L.fontSize)} px`, `${px(D.fontSize)} px`],
    ['Graisse', px(L.fontWeight), px(D.fontWeight)],
    ['Largeur × hauteur', `${px(L.width)} × ${px(L.height)} px`, `${px(D.width)} × ${px(D.height)} px`],
    ['Marge interne H / V', `${px(L.paddingX)} / ${px(L.paddingY)} px`, `${px(D.paddingX)} / ${px(D.paddingY)} px`],
  ];
  return h('div.scroll-x', null, h('table.metrics', null,
    h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Mesure' }), h('th', { scope: 'col', text: 'Clair' }), h('th', { scope: 'col', text: 'Sombre' }))),
    h('tbody', null, rows.map(([k, a, b]) => h('tr', null, h('th', { scope: 'row', text: k }), h('td', null, a), h('td', null, b))))));
}

export function themeSwitch(id, current, onChange) {
  const opts = [['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']];
  const group = h('div.seg', { role: 'radiogroup', 'aria-label': 'Thème du rendu', id });
  for (const [value, label] of opts) {
    const b = h('button.seg-btn', { type: 'button', role: 'radio', 'data-value': value, 'aria-checked': String(value === current), text: label });
    b.addEventListener('click', () => {
      for (const x of group.children) x.setAttribute('aria-checked', String(x === b));
      onChange(value);
    });
    group.append(b);
  }
  return group;
}

export function renderDetail(container, comp, ctx) {
  if (!comp) {
    container.append(h('div.empty', null,
      h('p', { text: "Ce composant n'est plus dans l'atlas. Il a peut-être changé depuis la dernière génération." }),
      h('a.btn', { href: '#types', text: 'Revenir à la galerie' })));
    return;
  }
  const art = ctx.byArtifact.get(comp.artifactId);
  const styles = ctx.data.styles[comp.artifactId] || {};
  let theme = ctx.renderTheme;
  const scheme = () => (theme === 'auto' ? pageScheme() : theme);
  const cssFor = () => (scheme() === 'dark' ? styles.cssDark : styles.cssLight) || '';
  const cssLabel = () => (scheme() === 'dark' ? 'sombre' : 'clair');

  const stage = h('div.tile.tile-large', { 'data-key': comp.key8, inert: true, 'aria-hidden': 'true' });
  const cssPre = h('pre.code', { tabindex: '0' }, h('code', { text: cssFor() }));
  const htmlPre = h('pre.code', { tabindex: '0' }, h('code', { text: comp.html }));
  const cssTitle = h('h2', { text: `CSS scopé (${cssLabel()})` });
  const refreshCss = () => { cssPre.firstChild.textContent = cssFor(); cssTitle.textContent = `CSS scopé (${cssLabel()})`; };

  const sources = comp.sources.map((s) => {
    const a = ctx.byArtifact.get(s.artifactId);
    return h('li', null,
      a ? h('a', { href: a.url, target: '_blank', rel: 'noopener', text: a.title }) : h('span', { text: s.artifactId }),
      h('span.muted', { text: ` · ${a ? a.project : ''}${a ? ` · ${formatDate(a.updated)}` : ''}` }),
      s.occurrences > 1 ? h('span.occ', { text: ` ×${s.occurrences}` }) : null);
  });

  container.append(h('article.detail', { 'aria-labelledby': 'detail-title' },
    h('a.back', { href: '#types', text: '← Retour à la galerie' }),
    h('header.detail-head', null,
      h('p.eyebrow', null, typeLabel(ctx.data.taxonomy, comp.type), ' · ', comp.project,
        comp.isDS ? h('span.badge', { text: 'DS' }) : null),
      h('h1', { id: 'detail-title', tabindex: '-1', text: comp.name }),
      comp.description ? h('p.lede', { text: comp.description }) : null),
    h('div.detail-stage', null,
      h('div.stage-bar', null,
        h('span.muted', { text: comp.occurrences > 1 ? `${comp.occurrences} occurrences` : '1 occurrence' }),
        themeSwitch('detail-theme', theme, (v) => { theme = v; setSnippetTheme(stage, v); refreshCss(); })),
      stage),
    h('div.detail-cols', null,
      h('section.panel', null, h('h2', { text: 'Mesures' }), metricsTable(comp.metrics || {})),
      h('section.panel', null,
        h('h2', { text: comp.sources.length > 1 ? 'Sources' : 'Source' }),
        h('ul.sources', null, sources),
        art ? h('a.btn', { href: art.url, target: '_blank', rel: 'noopener', text: "Ouvrir l'artifact source" }) : null)),
    h('section.panel', null,
      h('div.panel-head', null, h('h2', { text: 'HTML' }), copyButton('Copier le HTML', () => comp.html, htmlPre)),
      htmlPre),
    h('section.panel', null,
      h('div.panel-head', null, cssTitle, copyButton('Copier le CSS', cssFor, cssPre)),
      cssPre)));
  mountTile(stage, comp, ctx, theme);
}

export function renderUnanalysed(container, artifacts, notes) {
  container.replaceChildren();
  if (!artifacts.length && !notes.length) return;
  const label = { skipped: 'Non analysé', error: 'Erreur' };
  container.append(h('details.unanalysed', null,
    h('summary', null, 'Non analysés', h('span.count', { text: String(artifacts.length) })),
    artifacts.length ? h('ul.status-list', null, artifacts.map((a) => h('li', null,
      h('span', { class: `status status-${a.status}`, text: label[a.status] || a.status }),
      h('a', { href: a.url, target: '_blank', rel: 'noopener', text: a.title }),
      a.note ? h('span.muted', { text: a.note }) : null))) : null,
    notes.length ? h('div.notes', null, h('h3', { text: 'Remarques' }), h('ul', null, notes.map((n) => h('li', { text: n })))) : null));
}
