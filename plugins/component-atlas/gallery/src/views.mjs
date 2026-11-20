// Construction du DOM des vues (Par type, fiche, non analysés). Aucun état global ici :
// tout passe par `ctx` = { data, byArtifact, renderTheme, ... } fourni par main.mjs.
// Concaténé dans index.html par build.mjs : noms de premier niveau uniques entre modules.
import { mountSnippet, setSnippetTheme, pageScheme } from './tile.mjs';
import {
  groupByTypeThenProject, typeLabel, formatDate, matrixCounts, seqStep, colorPoints, metricSeries, contrastRatio,
} from './logic.mjs';

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

// Aperçu des tuiles : le composant est mis en page à sa largeur naturelle puis réduit
// (jamais agrandi) pour tenir dans la zone d'aperçu, sans rognage sauf sous l'échelle minimale.
const PREVIEW_MAX_H = 240;
const MIN_SCALE = 0.2;
const FIT = typeof ResizeObserver === 'function'
  ? new ResizeObserver((entries) => { for (const e of entries) e.target.__caFit?.(false); })
  : null;

/** Largeur et hauteur naturelles du rendu : la coquille .ca-body et tout ce qui en déborde. */
function naturalSize(host, avail) {
  const root = host.shadowRoot && host.shadowRoot.firstElementChild;
  host.style.width = '';
  if (!root) return null;
  const w = Math.max(avail, Math.ceil(root.scrollWidth));
  host.style.width = w > avail ? `${w}px` : '';
  return { w, h: Math.max(1, Math.ceil(root.scrollHeight), Math.ceil(root.getBoundingClientRect().height)) };
}

function fitPreview(frame, host, mark, maxH = PREVIEW_MAX_H) {
  let lastAvail = -1;
  const fit = (force = true) => {
    const avail = frame.clientWidth;
    if (!avail || (!force && avail === lastAvail)) return;
    lastAvail = avail;
    host.style.transform = '';
    const size = naturalSize(host, avail);
    if (!size) return;
    const scale = Math.max(MIN_SCALE, Math.min(1, avail / size.w, maxH / size.h));
    if (scale < 1) {
      host.style.transform = `scale(${scale})`;
      mark.textContent = `réduit à ${Math.round(scale * 100)} %`;
      mark.hidden = false;
    } else {
      mark.hidden = true;
    }
    frame.style.height = `${Math.min(maxH, Math.ceil(size.h * scale))}px`;
  };
  frame.__caFit = fit;
  if (FIT) FIT.observe(frame);
  fit();
}

/** Recalcule les aperçus (après un changement de thème ou le chargement des polices). */
export function refitPreviews(container) {
  for (const frame of container.querySelectorAll('.preview')) frame.__caFit?.(true);
}

function specimen(comp, ctx, maxH = PREVIEW_MAX_H) {
  const stage = h('div.tile', { 'data-key': comp.key8, inert: true, 'aria-hidden': 'true' });
  const frame = h('div.preview', null, stage);
  const mark = h('span.scaled', { hidden: true });
  const m = comp.metrics && comp.metrics.light;
  const card = h('a.specimen', { href: `#c-${comp.key8}`, 'aria-label': `${comp.name}, ${comp.project}` },
    frame,
    h('div.specimen-cap', null,
      h('span.specimen-name', { text: comp.name }),
      h('span.specimen-meta', null,
        h('span.specimen-project', { text: comp.project }),
        comp.isDS ? h('span.badge', { text: 'DS', title: 'Issu du design system' }) : null,
        comp.occurrences > 1 ? h('span.occ', { text: `×${comp.occurrences}`, title: plural(comp.occurrences, 'occurrence', 'occurrences') }) : null,
        m ? h('span.dim', { text: `${px(m.width)}×${px(m.height)}` }) : null,
        mark)));
  mountTile(stage, comp, ctx, ctx.renderTheme);
  queueMicrotask(() => fitPreview(frame, stage, mark, maxH));
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

/** Groupe de boutons radio segmentés. `opts` = [[valeur, libellé], …]. */
function segSwitch(id, label, opts, current, onChange) {
  const group = h('div.seg', { role: 'radiogroup', 'aria-label': label, id });
  for (const [value, text] of opts) {
    const b = h('button.seg-btn', { type: 'button', role: 'radio', 'data-value': value, 'aria-checked': String(value === current), text });
    b.addEventListener('click', () => {
      for (const x of group.children) x.setAttribute('aria-checked', String(x === b));
      onChange(value);
    });
    group.append(b);
  }
  return group;
}

export function themeSwitch(id, current, onChange) {
  return segSwitch(id, 'Thème du rendu', [['auto', 'Auto'], ['light', 'Clair'], ['dark', 'Sombre']], current, onChange);
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
  // Conteneur de défilement non inerte : l'hôte inerte ne peut pas défiler lui-même.
  const scroller = h('div.stage-scroll', { tabindex: '0', role: 'region', 'aria-label': `Rendu de ${comp.name}` }, stage);
  const sizeStage = () => naturalSize(stage, scroller.clientWidth);
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
        themeSwitch('detail-theme', theme, (v) => { theme = v; setSnippetTheme(stage, v); refreshCss(); sizeStage(); })),
      scroller),
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
  sizeStage();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (stage.isConnected) sizeStage(); });
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

// ── Vues de comparaison : Matrice, Couleurs, Mesures (SVG dessiné à la main) ──────────
// Couleurs des marques et du texte : classes CSS adossées aux tokens --ca-* (clair et sombre).

const SVG_NS = 'http://www.w3.org/2000/svg';
const HEX_RE = /^#[0-9a-f]{3,8}$/i;
const SMALL_PREVIEW_H = 120;
const SEQ_STEPS = 5;
// Surfaces de la galerie (--ca-surface clair / sombre) : une pastille trop proche reçoit un contour.
const SURFACE_LIGHT = '#ffffff';
const SURFACE_DARK = '#1d1d1b';
const NEAR_SURFACE = 1.35;

function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) if (kid) el.append(kid);
  return el;
}

/** Largeur de dessin : la place disponible, avec un minimum (le conteneur défile au-delà). */
const chartWidth = (container, min) => Math.max(min, Math.floor(container.clientWidth || 0));
// Largeur estimée d'un libellé en 12 px (aucune mesure DOM avant insertion).
const textW = (s) => String(s).length * 7;

function emptyState(container, ctx) {
  container.append(h('div.empty', null,
    h('p', { text: 'Aucun composant ne correspond à ces filtres.' }),
    h('button.btn', { type: 'button', onclick: ctx.clearFilters, text: 'Effacer les filtres' })));
}

function vizHead(title, lede, ...extra) {
  return h('header.viz-head', null,
    h('div', null, h('h2', { text: title }), h('p.muted', { text: lede })),
    extra.length ? h('div.viz-controls', null, extra) : null);
}

/**
 * Zone sous un graphique : aperçus des composants de la marque survolée ou focalisée.
 * `group` partage la sélection entre plusieurs zones (une seule remplie à la fois).
 */
function detailZone(ctx, hint, group) {
  const el = h('div.viz-detail', { 'aria-live': 'polite' }, h('p.muted.viz-hint', { text: hint }));
  let current = null;
  const zone = {
    el,
    show(id, title, keys, mark) {
      if (current === id) return;
      if (group) for (const z of group) if (z !== zone) z.clear();
      current = id;
      el.closest('.viz-block')?.querySelectorAll('.is-active').forEach((m) => m.classList.remove('is-active'));
      mark?.classList.add('is-active');
      const comps = keys.map((k) => ctx.byKey.get(k)).filter(Boolean);
      el.replaceChildren(
        h('h3.viz-detail-title', null, title, h('span.count', { text: plural(comps.length, 'composant', 'composants') })),
        h('div.grid.grid-small', null, comps.map((c) => specimen(c, ctx, SMALL_PREVIEW_H))));
    },
    clear() {
      if (current === null) return;
      current = null;
      el.closest('.viz-block')?.querySelectorAll('.is-active').forEach((m) => m.classList.remove('is-active'));
      el.replaceChildren(h('p.muted.viz-hint', { text: hint }));
    },
  };
  if (group) group.push(zone);
  return zone;
}

/** Marque SVG focalisable : survol, focus et clic sélectionnent ; Entrée/Espace aussi. */
function interactive(mark, label, select) {
  mark.setAttribute('tabindex', '0');
  mark.setAttribute('role', 'button');
  mark.setAttribute('aria-label', label);
  mark.addEventListener('mouseenter', select);
  mark.addEventListener('focus', select);
  mark.addEventListener('click', select);
  mark.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
  return mark;
}

// ── Matrice ──

export function renderMatrixView(container, components, ctx) {
  const tax = ctx.data.taxonomy;
  const m = matrixCounts(components, tax);
  if (!m.rows.length) { emptyState(container, ctx); return; }
  const labels = m.rows.map((r) => typeLabel(tax, r));
  const labelW = Math.max(...labels.map(textW)) + 16;
  const colLen = Math.max(...m.cols.map(textW));
  const ROT = 40 * Math.PI / 180;
  const top = Math.ceil(colLen * Math.sin(ROT)) + 18;
  const avail = Math.floor(container.clientWidth || 0) - labelW - Math.ceil(colLen * Math.cos(ROT)) - 8;
  const cw = Math.max(44, Math.min(96, Math.floor(avail / m.cols.length)));
  const ch = 32;
  const W = labelW + m.cols.length * cw + Math.ceil(colLen * Math.cos(ROT)) + 8;
  const H = top + m.rows.length * ch + 4;

  const chart = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'Matrice type × projet' });
  m.cols.forEach((p, j) => {
    const x = labelW + j * cw + cw / 2;
    chart.append(svg('text', { class: 'ax-label', x, y: top - 8, transform: `rotate(-40 ${x} ${top - 8})`, text: p }));
  });
  m.rows.forEach((type, i) => {
    const y = top + i * ch;
    chart.append(svg('text', { class: 'ax-label ax-row', x: labelW - 10, y: y + ch / 2, 'text-anchor': 'end', 'dominant-baseline': 'central', text: labels[i] }));
    m.cols.forEach((project, j) => {
      const n = m.cells[i][j];
      const x = labelW + j * cw;
      const step = seqStep(n, m.max, SEQ_STEPS);
      const cell = svg('g', { class: n ? 'mx-cell' : 'mx-cell mx-empty', 'data-type': type, 'data-project': project },
        svg('rect', { class: n ? `mx-rect seq-${step}` : 'mx-rect', x: x + 1, y: y + 1, width: cw - 2, height: ch - 2, rx: 3 }));
      if (n) {
        const label = `${labels[i]} · ${project} : ${plural(n, 'composant', 'composants')}`;
        cell.append(svg('title', { text: label }),
          svg('text', { class: `mx-count seq-ink-${step}`, x: x + cw / 2, y: y + ch / 2, 'text-anchor': 'middle', 'dominant-baseline': 'central', text: String(n) }));
        cell.setAttribute('tabindex', '0');
        cell.setAttribute('role', 'link');
        cell.setAttribute('aria-label', `${label}. Voir ces composants`);
        const go = () => ctx.goTypes({ type, project });
        cell.addEventListener('click', go);
        cell.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      }
      chart.append(cell);
    });
  });

  const legend = h('div.seq-legend', { 'aria-hidden': 'true' },
    h('span.muted', { text: '1' }),
    ...Array.from({ length: SEQ_STEPS }, (_, k) => h(`span.seq-key.seq-bg-${k + 1}`)),
    h('span.muted', { text: plural(m.max, 'composant', 'composants') }));

  container.append(h('section.viz-block', null,
    vizHead('Matrice', 'Nombre de composants par type et par projet. Une case mène à ces composants dans la vue Par type.', legend),
    h('div.viz', null, chart)));
}

// ── Couleurs (nuancier) ──

const HUE_TICKS = [[0, 'rouge'], [60, 'jaune'], [120, 'vert'], [180, 'cyan'], [240, 'bleu'], [300, 'magenta'], [360, 'rouge']];
const NEUTRAL_S = 0.1;

function swatchClasses(hex) {
  const cls = ['sw-mark'];
  if (contrastRatio(hex, SURFACE_LIGHT) < NEAR_SURFACE) cls.push('near-l');
  if (contrastRatio(hex, SURFACE_DARK) < NEAR_SURFACE) cls.push('near-d');
  return cls.join(' ');
}

export function renderColorsView(container, components, ctx) {
  const st = ctx.state;
  if (!st.swTheme) st.swTheme = pageScheme();
  const points = colorPoints(components, st.swTheme).filter((p) => HEX_RE.test(p.hex));
  const toggle = segSwitch('sw-theme', 'Thème des couleurs', [['light', 'Clair'], ['dark', 'Sombre']], st.swTheme,
    (v) => { st.swTheme = v; ctx.rerender(); });
  const head = vizHead('Couleurs',
    'Chaque pastille est une couleur de fond, de texte ou de bordure ; sa taille suit le nombre de composants qui l’utilisent.', toggle);
  if (!points.length) {
    container.append(h('section.viz-block', null, head, h('p.muted.viz-hint', { text: 'Aucune couleur relevée pour ces composants.' })));
    return;
  }

  const W = chartWidth(container, 560);
  const H = 360;
  const M = { l: 44, r: 28, t: 18, b: 40 };
  const band = 56; // colonne des neutres (saturation faible : teinte sans signification)
  const hx0 = M.l + band + 36;
  const hx1 = W - M.r;
  const yOf = (l) => M.t + (1 - l) * (H - M.t - M.b);
  const xOf = (p) => (p.s < NEUTRAL_S ? M.l + band / 2 : hx0 + (p.h / 360) * (hx1 - hx0));
  const rOf = (n) => Math.min(14, 6 + 2 * Math.sqrt(n - 1));

  const chart = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `Nuancier : ${plural(points.length, 'couleur', 'couleurs')}` });
  for (const l of [0, 0.25, 0.5, 0.75, 1]) {
    const y = yOf(l);
    chart.append(svg('line', { class: 'grid-line', x1: M.l, x2: W - M.r, y1: y, y2: y }),
      svg('text', { class: 'ax-tick', x: M.l - 8, y, 'text-anchor': 'end', 'dominant-baseline': 'central', text: `${l * 100} %` }));
  }
  for (const [deg, name] of HUE_TICKS) {
    const x = hx0 + (deg / 360) * (hx1 - hx0);
    chart.append(svg('line', { class: 'grid-line', x1: x, x2: x, y1: M.t, y2: H - M.b }),
      svg('text', { class: 'ax-tick', x, y: H - M.b + 16, 'text-anchor': 'middle', text: name }));
  }
  chart.append(svg('rect', { class: 'sw-band', x: M.l, y: M.t, width: band, height: H - M.t - M.b, rx: 4 }),
    svg('text', { class: 'ax-tick', x: M.l + band / 2, y: H - M.b + 16, 'text-anchor': 'middle', text: 'neutres' }),
    svg('text', { class: 'ax-title', x: M.l, y: H - 4, text: 'Luminosité ↑ · teinte →' }));

  const zone = detailZone(ctx, 'Survolez une pastille, ou parcourez-les au clavier, pour voir les composants qui l’utilisent.');
  // Les plus grosses d'abord : les petites restent visibles au-dessus.
  for (const p of [...points].sort((a, b) => b.keys.length - a.keys.length)) {
    const x = xOf(p);
    const y = yOf(p.l);
    const r = rOf(p.keys.length);
    const role = `${p.hex}, ${plural(p.keys.length, 'composant', 'composants')}`;
    const g = svg('g', { class: 'sw-dot', 'data-hex': p.hex },
      svg('circle', { class: 'hit', cx: x, cy: y, r: r + 4 }),
      svg('circle', { class: swatchClasses(p.hex), cx: x, cy: y, r, style: `fill:${p.hex}` }),
      svg('title', { text: role }));
    interactive(g, role, () => zone.show(p.hex, h('span.sw', null, h('span.chip', { style: `background:${p.hex}` }), h('code', { text: p.hex })), p.keys, g));
    chart.append(g);
  }

  const table = h('details.viz-table', null, h('summary', { text: 'Voir en tableau' }),
    h('div.scroll-x', null, h('table.metrics', null,
      h('thead', null, h('tr', null, ['Couleur', 'Teinte', 'Saturation', 'Luminosité', 'Composants'].map((t) => h('th', { scope: 'col', text: t })))),
      h('tbody', null, points.map((p) => h('tr', null,
        h('td', null, h('span.sw', null, h('span.chip', { style: `background:${p.hex}` }), h('code', { text: p.hex }))),
        h('td', { text: `${Math.round(p.h)}°` }), h('td', { text: `${Math.round(p.s * 100)} %` }),
        h('td', { text: `${Math.round(p.l * 100)} %` }), h('td', { text: String(p.keys.length) })))))));

  container.append(h('section.viz-block', null, head, h('div.viz', null, chart), zone.el, table));
}

// ── Mesures ──

const METRICS = [
  ['height', 'Hauteur'], ['radius', 'Rayon'], ['fontSize', 'Taille de police'],
  ['paddingX', 'Marge interne horizontale'], ['paddingY', 'Marge interne verticale'],
];
const PILL = 100; // rayon ≥ 100 px : forme pilule, regroupée hors échelle

function niceTicks(lo, hi, count = 6) {
  if (hi <= lo) { lo -= 4; hi += 4; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) || raw;
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}

function stripPlot(container, ctx, metric, label, series, group) {
  const pills = metric === 'radius' ? series.filter((s) => s.value >= PILL) : [];
  const scaled = series.filter((s) => !pills.includes(s));
  const W = chartWidth(container, 520);
  const H = 76;
  const M = { l: 16, r: pills.length ? 76 : 20, t: 22 };
  const y = M.t + 18;
  const vals = scaled.map((s) => s.value);
  const ticks = niceTicks(vals.length ? Math.min(...vals) : 0, vals.length ? Math.max(...vals) : PILL);
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const xOf = (v) => M.l + ((v - lo) / (hi - lo)) * (W - M.l - M.r);
  const rOf = (n) => Math.min(12, 4 + 2.5 * Math.sqrt(n - 1));

  const chart = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': `${label} : ${plural(series.length, 'valeur différente', 'valeurs différentes')}` });
  chart.append(svg('line', { class: 'axis-line', x1: M.l, x2: W - M.r, y1: y, y2: y }));
  for (const t of ticks) {
    chart.append(svg('line', { class: 'grid-line', x1: xOf(t), x2: xOf(t), y1: y - 4, y2: y + 4 }),
      svg('text', { class: 'ax-tick', x: xOf(t), y: H - 6, 'text-anchor': 'middle', text: String(t) }));
  }
  const pillX = W - M.r / 2 - 6;
  if (pills.length) chart.append(svg('text', { class: 'ax-tick', x: pillX, y: H - 6, 'text-anchor': 'middle', text: `≥ ${PILL} (pilule)` }));

  const zone = detailZone(ctx, 'Survolez un point pour voir les composants qui ont cette valeur.', group);
  const extremes = new Set(scaled.length > 1 ? [scaled[0].value, scaled[scaled.length - 1].value] : []);
  for (const s of [...series].sort((a, b) => b.keys.length - a.keys.length)) {
    const x = pills.includes(s) ? pillX : xOf(s.value);
    const r = rOf(s.keys.length);
    const text = `${label} ${s.value} px, ${plural(s.keys.length, 'composant', 'composants')}`;
    const g = svg('g', { class: 'st-dot', 'data-value': s.value },
      svg('circle', { class: 'hit', cx: x, cy: y, r: Math.max(r + 4, 10) }),
      svg('circle', { class: 'st-mark', cx: x, cy: y, r }),
      svg('title', { text }));
    if (extremes.has(s.value)) g.append(svg('text', { class: 'ax-value', x, y: y - r - 6, 'text-anchor': 'middle', text: `${s.value}` }));
    interactive(g, text, () => zone.show(`${metric}:${s.value}`, `${label} · ${s.value} px`, s.keys, g));
    chart.append(g);
  }

  const n = series.length;
  return h('section.viz-block.strip', { 'data-metric': metric },
    h('header.strip-head', null, h('h3', { text: label }),
      h('span.count', { text: n > 1 ? `${n} valeurs différentes` : n === 1 ? '1 seule valeur' : 'aucune valeur' })),
    h('div.viz', null, chart),
    zone.el,
    h('details.viz-table', null, h('summary', { text: 'Voir en tableau' }),
      h('table.metrics', null,
        h('thead', null, h('tr', null, h('th', { scope: 'col', text: 'Valeur' }), h('th', { scope: 'col', text: 'Composants' }))),
        h('tbody', null, series.map((s) => h('tr', null, h('td', { text: `${s.value} px` }),
          h('td', { text: s.keys.map((k) => ctx.byKey.get(k)?.name ?? k).join(', ') })))))));
}

export function renderMetricsView(container, components, ctx) {
  const tax = ctx.data.taxonomy;
  const present = new Map();
  for (const c of components) present.set(c.type, (present.get(c.type) ?? 0) + 1);
  const types = tax.filter((t) => present.has(t.slug));
  if (!types.length) { emptyState(container, ctx); return; }
  const st = ctx.state;
  if (!st.mType) st.mType = 'button';
  const type = present.has(st.mType) ? st.mType : types[0].slug;
  const select = h('select', { id: 'm-type' }, types.map((t) => h('option', { value: t.slug, selected: t.slug === type, text: `${t.label} (${present.get(t.slug)})` })));
  select.addEventListener('change', () => { st.mType = select.value; ctx.rerender(); });

  container.append(h('div.viz-block', null, vizHead('Mesures',
    'Chaque point est une valeur distincte, arrondie au pixel ; sa taille suit le nombre de composants qui la partagent.',
    h('label.field', null, h('span', { text: 'Type mesuré' }), select))));
  const group = [];
  for (const [metric, label] of METRICS) {
    container.append(stripPlot(container, ctx, metric, label, metricSeries(components, type, metric), group));
  }
}
