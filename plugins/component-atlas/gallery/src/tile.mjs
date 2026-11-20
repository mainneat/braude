// Rendu vivant d'un snippet dans un Shadow DOM, avec le CSS scopé de son artifact.
// Partagé par la galerie et la planche-contact (extract-page.mjs) : aucune dépendance.
// Concaténé dans index.html par build.mjs : noms de premier niveau uniques entre modules.

const SHEETS = new WeakMap(); // styles (un objet par artifact) → { light, dark } CSSStyleSheet
const INJECTED = new Set(); // polices et liens déjà ajoutés à document.head
const AUTO_HOSTS = new Set(); // hôtes en thème 'auto', à rebasculer quand le thème change
// Base de l'hôte, placée avant le CSS de l'artifact dans la même feuille : coupe l'héritage
// de la galerie (police, couleur, color-scheme) et rend le canevas par défaut d'une page,
// pour que le composant apparaisse comme dans son artifact. Les règles :host de l'artifact priment.
const HOST_BASE = ':host{all:initial;display:block;color-scheme:light;background:Canvas;color:CanvasText}\n';
const DARK_MQ = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
let themeWatch = false;

// Thème effectif de la page : choix explicite du visualiseur (data-theme sur la racine), sinon le système.
export function pageScheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'dark' || t === 'light') return t;
  return DARK_MQ && DARK_MQ.matches ? 'dark' : 'light';
}

function watchTheme() {
  if (themeWatch) return;
  themeWatch = true;
  const refresh = () => {
    for (const host of AUTO_HOSTS) {
      if (!host.isConnected) AUTO_HOSTS.delete(host);
      else adoptScheme(host, pageScheme());
    }
  };
  if (DARK_MQ) {
    if (DARK_MQ.addEventListener) DARK_MQ.addEventListener('change', refresh);
    else if (DARK_MQ.addListener) DARK_MQ.addListener(refresh);
  }
  if (typeof MutationObserver === 'function') {
    new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
}

function sheetFor(styles, scheme) {
  let entry = SHEETS.get(styles);
  if (!entry) { entry = {}; SHEETS.set(styles, entry); }
  if (!entry[scheme]) {
    const sheet = new CSSStyleSheet();
    const css = scheme === 'dark' ? styles.cssDark : styles.cssLight;
    try { sheet.replaceSync(HOST_BASE + (css ?? styles.css ?? '')); } catch { /* CSS illisible : composant sans style */ }
    entry[scheme] = sheet;
  }
  return entry[scheme];
}

function injectOnce(id, make) {
  if (INJECTED.has(id)) return;
  INJECTED.add(id);
  document.head.appendChild(make());
}

// @font-face et feuilles Google Fonts vont dans le document : les polices y déclarées
// sont visibles depuis les shadow roots.
function injectFonts(styles, fonts) {
  const style = (css) => () => { const el = document.createElement('style'); el.textContent = css; return el; };
  for (const id of styles.fontIds ?? []) if (fonts && fonts[id]) injectOnce(`font:${id}`, style(fonts[id]));
  if (styles.fontFaceCss) injectOnce(`face:${styles.fontFaceCss}`, style(styles.fontFaceCss));
  for (const href of styles.fontLinks ?? []) {
    injectOnce(`link:${href}`, () => { const el = document.createElement('link'); el.rel = 'stylesheet'; el.href = href; return el; });
  }
}

const RESOLVED = new WeakMap(); // data → Map(styleId → styles résolus)

/**
 * Styles d'un composant : data.styles[comp.styleId] ({light,dark: ids de data.css, fontIds, fontLinks}),
 * reconstitués en {cssLight, cssDark, fontIds, fontLinks}. Repli : ancien format par artifact
 * (data.styles[comp.artifactId] = {cssLight, cssDark…}). Objet mémorisé : une feuille par groupe.
 */
export function stylesOf(data, comp) {
  if (!data || !comp) return {};
  let memo = RESOLVED.get(data);
  if (!memo) { memo = new Map(); RESOLVED.set(data, memo); }
  const id = comp.styleId && data.styles && data.styles[comp.styleId] ? comp.styleId : comp.artifactId;
  if (memo.has(id)) return memo.get(id);
  const st = (data.styles && data.styles[id]) || {};
  const chunked = Array.isArray(st.light) || Array.isArray(st.dark);
  const ids = chunked ? [...(st.light || []), ...(st.dark || [])] : [];
  // Morceaux pas encore chargés (fichier a/<artifact>.json en attente) : résultat non mémorisé.
  const complete = ids.every((i) => data.css && typeof data.css[i] === 'string');
  const join = (list) => (list || []).map((i) => (data.css && data.css[i]) || '').join('\n');
  const out = chunked
    ? { cssLight: join(st.light), cssDark: join(st.dark), fontIds: st.fontIds || [], fontLinks: st.fontLinks || [] }
    : st;
  if (complete) memo.set(id, out);
  return out;
}

const DROP_TAGS = 'script,iframe,object,embed,frame,frameset,base,meta,link,noscript';

// Snapshot inerte : aucun script ni gestionnaire d'événement de l'artifact ne s'exécute.
// <template> analyse le HTML sans rien exécuter ni charger.
function sanitizeSnippet(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html ?? '');
  for (const el of tpl.content.querySelectorAll(DROP_TAGS)) el.remove();
  for (const el of tpl.content.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || n === 'autofocus') el.removeAttribute(attr.name);
      else if ((n === 'href' || n === 'src' || n === 'action' || n === 'formaction' || n === 'xlink:href')
        && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
  return tpl.content;
}

function adoptScheme(host, scheme) {
  const st = host.__caSnippet;
  if (!st || !host.shadowRoot) return;
  host.shadowRoot.adoptedStyleSheets = [sheetFor(st.styles, scheme)];
}

/** Applique un thème ('auto' | 'light' | 'dark') à un hôte déjà monté. */
export function setSnippetTheme(host, theme) {
  const st = host.__caSnippet;
  if (!st) return;
  st.theme = theme;
  if (theme === 'light' || theme === 'dark') {
    AUTO_HOSTS.delete(host);
    host.setAttribute('data-theme', theme);
    adoptScheme(host, theme);
  } else {
    host.removeAttribute('data-theme');
    AUTO_HOSTS.add(host);
    watchTheme();
    adoptScheme(host, pageScheme());
  }
}

/**
 * Monte `html` dans le shadow root de `host`, stylé par `styles` ({cssLight, cssDark, fontIds?, fontLinks?, fontFaceCss?}).
 * Une feuille CSSStyleSheet par (artifact, thème), partagée par adoptedStyleSheets.
 */
export function mountSnippet(host, { html, styles, theme = 'auto', fonts } = {}) {
  const st = styles || {};
  injectFonts(st, fonts);
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  root.replaceChildren(sanitizeSnippet(html));
  host.__caSnippet = { styles: st, theme };
  setSnippetTheme(host, theme);
  return root;
}
