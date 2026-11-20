#!/usr/bin/env node
// Rendu d'une page d'artifact dans Chromium, détection des composants (clair puis sombre),
// CSS scopé pour Shadow DOM. CLI : node scripts/extract-page.mjs <rawDir>
import { readFileSync } from 'node:fs';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/browser.mjs';
import { serializeScoped } from './lib/css.mjs';
import { toHex } from './lib/color.mjs';
import { componentKey } from './lib/hash.mjs';
import { moduleToScript } from './lib/inline.mjs';

const DETECT_SRC = readFileSync(new URL('./browser/detect.js', import.meta.url), 'utf8');
// Même code de rendu que les tuiles de la galerie.
const TILE_SRC = moduleToScript(readFileSync(new URL('../gallery/src/tile.mjs', import.meta.url), 'utf8'));
const VIEWPORT = { width: 1280, height: 900 };
const CONTACT_MAX_HEIGHT = 2200; // Read réduit les images très hautes : planches courtes
const RAW_LIMIT_MIN = 3000; // éléments détectés avant dédoublonnage (garde-fou mémoire)

const emptyStyles = () => ({ css: '', cssLight: '', cssDark: '', fontFaceCss: '', fontLinks: [] });
const FONT_LINK_HOSTS = new Set(['fonts.googleapis.com']); // seuls liens autorisés par la CSP de la galerie
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const firstLine = (s) => String(s ?? '').split('\n')[0].trim();

function withTimeout(promise, ms, what) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} : délai de ${ms} ms dépassé`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

const normMetrics = (m) => (m ? { ...m, bg: toHex(m.bg), fg: toHex(m.fg), border: toHex(m.border) } : null);

// Deux images d'animation + un court délai : laisse les écouteurs matchMedia de la page réagir.
const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))));

export async function extractPage(htmlPath, opts = {}) {
  let html;
  try {
    html = await readFile(htmlPath, 'utf8');
  } catch (e) {
    return { status: 'error', error: `Lecture impossible : ${e.message}`, warnings: [], styles: emptyStyles(), candidates: [] };
  }
  return extractFromHtml(html, opts);
}

// Statut 'error' seulement quand rien ne se rend (fichier absent, chargement en échec sans DOM,
// navigateur ou détection en échec). Erreurs JS, ressources injoignables, délais avec DOM
// utilisable → 'ok' + warnings.
export async function extractFromHtml(html, opts = {}) {
  return extractRendered((page, timeout) => page.setContent(html, { waitUntil: 'networkidle', timeout }), opts);
}

/**
 * Même extraction, le chargement étant délégué à `load(page, timeoutMs)` (ex. page.goto).
 * `page` : page Playwright réutilisée (non fermée ici, remise en thème clair) ; sinon un
 * contexte est créé sur `browser` (ou un navigateur lancé) et fermé à la fin.
 */
export async function extractRendered(load, { maxCandidates = 150, timeoutMs = 20000, browser, page: shared, wholeBody = false, keepRules = false, ownKeys = false } = {}) {
  const warnings = [];
  const note = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };
  const ok = (styles, candidates) => ({ status: 'ok', warnings, styles, candidates });
  const fail = (error) => ({ status: 'error', error: error.slice(0, 1000), warnings, styles: emptyStyles(), candidates: [] });
  let b = browser;
  let context;
  let page = shared;
  const onError = (e) => note(`Erreur JS : ${firstLine(e.message)}`);
  const onFailed = (req) => {
    if (['script', 'stylesheet'].includes(req.resourceType())) {
      note(`Ressource injoignable : ${req.url()} (${req.failure()?.errorText ?? 'échec'})`);
    }
  };
  try {
    if (!page) {
      b ??= await launch();
      context = await b.newContext({ viewport: VIEWPORT, colorScheme: 'light' });
      page = await context.newPage();
    } else {
      await page.emulateMedia({ colorScheme: 'light' });
    }
    page.setDefaultTimeout(timeoutMs);
    page.on('pageerror', onError);
    page.on('requestfailed', onFailed);
    const run = (fn, arg, what) => withTimeout(page.evaluate(fn, arg), timeoutMs, what);
    try {
      await load(page, timeoutMs);
    } catch (e) {
      const msg = `Chargement : ${firstLine(e.message)}`;
      const rendered = await run(() => (document.body?.childElementCount ?? 0) > 0, undefined, 'DOM').catch(() => false);
      if (!rendered) return fail(msg);
      note(msg); // DOM utilisable : on extrait quand même
    }
    await run(() => document.fonts?.ready.then(() => true), undefined, 'Polices').catch((e) => note(firstLine(e.message)));
    await run(DETECT_SRC, undefined, 'Injection');
    await run(settle, undefined, 'Stabilisation');

    const rawLimit = Math.max(RAW_LIMIT_MIN, maxCandidates * 20);
    const raw = await run((a) => window.__caDetect(a.n, { wholeBody: a.wholeBody }), { n: rawLimit, wholeBody }, 'Détection');

    // Dédoublonnage par componentKey AVANT le plafond, ordre de première apparition.
    const groups = new Map();
    raw.candidates.forEach((c, i) => {
      const light = normMetrics(c.metrics);
      const key = componentKey(c.html, light);
      const g = groups.get(key);
      if (g) g.occurrences++;
      else groups.set(key, { raw: i, c, light, occurrences: 1 });
    });
    const kept = [...groups.values()].slice(0, maxCandidates);

    let dark = null;
    try {
      await page.emulateMedia({ colorScheme: 'dark' });
      await run(settle, undefined, 'Stabilisation');
      dark = await run(() => window.__caMeasure(), undefined, 'Mesure sombre');
    } catch (e) {
      note(`Thème sombre : ${firstLine(e.message)}`);
    }

    let missing = 0;
    const candidates = kept.map((g, index) => {
      let d = dark ? normMetrics(dark[g.raw]) : g.light;
      if (!d) { missing++; d = g.light; }
      const colors = [...new Set([g.light.bg, g.light.fg, g.light.border, d.bg, d.fg, d.border].filter(Boolean))];
      const { kind, tag, text, context: ctx, html: snippet, role, inputType, shellLen } = g.c;
      const inner = wholeBody && g.raw > 0 ? { measureOnly: true, parentIndex: 0 } : {};
      // ownKey : clé de l'élément seul (sans la coquille d'ancêtres), pour fusionner entre documents.
      if (ownKeys && shellLen) inner.ownKey = componentKey(snippet.slice(shellLen[0], snippet.length - shellLen[1]), g.light);
      return { index, kind, tag, text, context: ctx, html: snippet, occurrences: g.occurrences,
        metrics: { light: g.light, dark: d }, colors, ...(role ? { role } : {}), ...(inputType ? { inputType } : {}), ...inner };
    });

    if (missing) note(`Thème sombre : ${missing} élément(s) introuvable(s) après le changement de thème, mesures claires reprises`);

    const { css, fontFaceCss } = serializeScoped(raw.rules);
    const cssLight = serializeScoped(raw.rules, { scheme: 'light' }).css;
    const cssDark = serializeScoped(raw.rules, { scheme: 'dark' }).css;
    const fontLinks = raw.fontLinks.filter((u) => {
      if (FONT_LINK_HOSTS.has(hostOf(u))) return true;
      note(`Feuille de style externe ignorée (illisible ou hors Google Fonts) : ${u}`);
      return false;
    });
    const res = ok({ css, cssLight, cssDark, fontFaceCss, fontLinks }, candidates);
    if (keepRules) res.rules = raw.rules;
    return res;
  } catch (e) {
    return fail(firstLine(e.message));
  } finally {
    if (page) { page.off('pageerror', onError); page.off('requestfailed', onFailed); }
    if (context) await withTimeout(context.close(), 5000, 'Fermeture').catch(() => {});
    if (b && !browser && !shared) await b.close().catch(() => {});
  }
}

const SHEET_CSS = `body{margin:0;padding:16px;background:#f4f4f2;font:12px/1.4 ui-monospace,Menlo,monospace;color:#222}
#sheet{display:grid;grid-template-columns:repeat(auto-fill,minmax(296px,1fr));gap:12px;align-items:start}
figure{margin:0;border:1px solid #c9c9c4;background:#fff;min-width:0}
figcaption{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid #c9c9c4;overflow:hidden;white-space:nowrap}
figcaption b{flex:none;min-width:22px;height:20px;padding:0 5px;border-radius:10px;background:#e5484d;color:#fff;font-weight:700;text-align:center;line-height:20px}
figcaption span{overflow:hidden;text-overflow:ellipsis;color:#666}
.tile{display:block;max-height:320px;overflow:hidden}`;

/** Styles d'un résultat d'extraction, par groupe : r.styleGroups ({gid: Styles}) ou { main: r.styles }. */
export const styleGroupsOf = (r) => r.styleGroups ?? { main: r.styles ?? emptyStyles() };

/**
 * Planche-contact : chaque candidat rendu comme une tuile de la galerie (Shadow DOM + CSS scopé clair
 * de son groupe de styles), avec un badge numéroté = candidate.index. Découpée entre deux rangées de
 * tuiles toutes les ~2200 px : outPath (contact.png), puis contact-2.png… (au plus maxSheets).
 * `styles` : un objet Styles, ou { groups: {gid: Styles} } (candidat → groups[c.styleGroup]).
 * Renvoie { files, sheets: [{file, from, to}], blank: [index…] } ; `blank` = tuiles dont l'élément
 * est vide ou hors du cadre de la tuile (régressions de rendu).
 */
export async function renderContactSheet(candidates, styles, outPath, browser, { timeoutMs = 20000, maxSheets = 16 } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${SHEET_CSS}</style></head>`
      + `<body><div id="sheet"></div></body></html>`);
    await page.addScriptTag({ content: `(() => {\n${TILE_SRC}\nwindow.__caMount = mountSnippet;\n})();` });
    const groups = styles?.groups ?? { main: styles || {} };
    const firstGroup = Object.keys(groups)[0] ?? 'main';
    const items = candidates.map((c) => ({ index: c.index, html: c.html,
      group: groups[c.styleGroup] ? c.styleGroup : firstGroup,
      label: [c.presetName, c.measureOnly ? 'mesure' : null, c.tag, c.text].filter(Boolean).join(' · ').slice(0, 80) }));
    const blank = await withTimeout(page.evaluate(({ items, groups }) => {
      const sheet = document.getElementById('sheet');
      const hosts = [];
      for (const it of items) {
        const fig = document.createElement('figure');
        const cap = document.createElement('figcaption');
        const num = document.createElement('b');
        num.textContent = String(it.index);
        const lab = document.createElement('span');
        lab.textContent = it.label;
        cap.append(num, lab);
        const host = document.createElement('div');
        host.className = 'tile';
        fig.append(cap, host);
        sheet.append(fig);
        window.__caMount(host, { html: it.html, styles: groups[it.group] || {}, theme: 'light' });
        hosts.push([it.index, host]);
      }
      const links = [...document.head.querySelectorAll('link[rel=stylesheet]')]
        .map((l) => new Promise((r) => { l.addEventListener('load', r); l.addEventListener('error', r); }));
      return Promise.race([Promise.all(links), new Promise((r) => setTimeout(r, 5000))])
        .then(() => document.fonts.ready)
        .then(() => hosts.filter(([, host]) => {
          // L'élément du composant : premier élément ni racine .ca-body ni ancêtre de coquille.
          const el = [...host.shadowRoot.querySelectorAll('*')].find((e) => !e.classList.contains('ca-body') && !e.hasAttribute('data-ca-shell'));
          if (!el) return true;
          const r = el.getBoundingClientRect();
          const f = host.getBoundingClientRect();
          const w = Math.min(r.right, f.right) - Math.max(r.left, f.left);
          const h = Math.min(r.bottom, f.bottom) - Math.max(r.top, f.top);
          return r.width < 1 || r.height < 1 || w < 4 || h < 4;
        }).map(([i]) => i));
    }, { items, groups }), timeoutMs, 'Planche-contact');
    const { height, boxes } = await page.evaluate(() => ({
      height: document.documentElement.scrollHeight,
      boxes: [...document.querySelectorAll('figure')].map((f) => {
        const r = f.getBoundingClientRect();
        return [Math.floor(r.top + scrollY), Math.ceil(r.bottom + scrollY), Number(f.querySelector('figcaption b').textContent)];
      }),
    }));
    // Découpe aux débuts de rangée : une tranche se ferme avant la tuile qui la ferait déborder.
    const slices = [];
    let start = 0;
    let members = [];
    for (const [top, bottom, index] of boxes.sort((a, b) => a[0] - b[0])) {
      if (bottom - start > CONTACT_MAX_HEIGHT && top > start) { slices.push([start, top, members]); start = top; members = []; }
      members.push(index);
    }
    slices.push([start, height, members]);
    const files = [];
    const sheets = [];
    for (const [i, [y0, y1, idx]] of slices.slice(0, maxSheets).entries()) {
      const path = i === 0 ? outPath : outPath.replace(/(\.png)?$/i, `-${i + 1}.png`);
      const h = Math.max(1, Math.min(CONTACT_MAX_HEIGHT, y1 - y0));
      await page.screenshot({ path, fullPage: true, timeout: timeoutMs, clip: { x: 0, y: y0, width: VIEWPORT.width, height: h } });
      files.push(path);
      sheets.push({ file: basename(path), from: idx.length ? Math.min(...idx) : null, to: idx.length ? Math.max(...idx) : null });
    }
    const omitted = slices.slice(maxSheets).reduce((n, sl) => n + sl[2].length, 0);
    return { files, sheets, blank, omitted };
  } finally {
    await withTimeout(context.close(), 5000, 'Fermeture').catch(() => {});
  }
}

/**
 * Écrit candidates.json (chaque candidat avec son styleGroup), styles.json = { groups: {gid: Styles} },
 * contact.png (+ contact-2.png…), contact.json (planche → plage d'index) et extract.json dans `dir`
 * (CLI page, design system et design). `r.stats` (facultatif) est recopié dans extract.json.
 */
export async function writeRawOutputs(dir, r, browser) {
  for (const f of await readdir(dir).catch(() => [])) {
    if (/^contact(-\d+)?\.(png|json)$/.test(f)) await unlink(join(dir, f)).catch(() => {});
  }
  const groups = styleGroupsOf(r);
  const first = Object.keys(groups)[0] ?? 'main';
  const candidates = r.candidates.map((c) => ({ ...c, styleGroup: groups[c.styleGroup] ? c.styleGroup : first }));
  let sheets = [];
  if (candidates.length) {
    try {
      const sheet = await renderContactSheet(candidates, { groups }, join(dir, 'contact.png'), browser);
      sheets = sheet.sheets;
      if (sheet.blank.length) {
        r.warnings.push(`Planche-contact : ${sheet.blank.length} tuile(s) vide(s) ou hors cadre (index ${sheet.blank.slice(0, 30).join(', ')}${sheet.blank.length > 30 ? '…' : ''})`);
      }
      if (sheet.omitted) r.warnings.push(`Planche-contact : ${sheet.omitted} tuile(s) au-delà de la dernière planche`);
      r.stats = { ...(r.stats ?? {}), blankTiles: sheet.blank.length };
      await writeFile(join(dir, 'contact.json'), JSON.stringify(sheets, null, 1));
    } catch (e) {
      r.warnings.push(`Planche-contact : ${firstLine(e.message)}`);
    }
  }
  await writeFile(join(dir, 'candidates.json'), JSON.stringify(candidates, null, 1));
  await writeFile(join(dir, 'styles.json'), JSON.stringify({ groups }));
  const summary = { status: r.status, ...(r.error ? { error: r.error } : {}), warnings: r.warnings, candidates: candidates.length,
    ...(sheets.length > 1 ? { contactSheets: sheets.length } : {}), ...(r.stats && Object.keys(r.stats).some((k) => k !== 'blankTiles' || r.stats[k]) ? r.stats : {}) };
  await writeFile(join(dir, 'extract.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary) + '\n');
}

async function main(argv) {
  const dir = argv[0];
  if (!dir) {
    process.stderr.write('Usage : node scripts/extract-page.mjs <rawDir>\n');
    process.exit(2);
  }
  let browser;
  try {
    browser = await launch();
  } catch (e) {
    await writeRawOutputs(dir, { status: 'error', error: firstLine(e.message), warnings: [], styles: emptyStyles(), candidates: [] }, null);
    return;
  }
  try {
    const r = await extractPage(join(dir, 'index.html'), { browser });
    await writeRawOutputs(dir, r, browser);
  } finally { await browser.close().catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
}
