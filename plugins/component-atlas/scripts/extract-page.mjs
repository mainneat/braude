#!/usr/bin/env node
// Rendu d'une page d'artifact dans Chromium, détection des composants (clair puis sombre),
// CSS scopé pour Shadow DOM. CLI : node scripts/extract-page.mjs <rawDir>
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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
const CONTACT_MAX_HEIGHT = 6000;
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
export async function extractFromHtml(html, { maxCandidates = 150, timeoutMs = 20000, browser, wholeBody = false, keepRules = false } = {}) {
  const warnings = [];
  const note = (msg) => { if (!warnings.includes(msg)) warnings.push(msg); };
  const ok = (styles, candidates) => ({ status: 'ok', warnings, styles, candidates });
  const fail = (error) => ({ status: 'error', error: error.slice(0, 1000), warnings, styles: emptyStyles(), candidates: [] });
  let b = browser;
  let context;
  try {
    b ??= await launch();
    context = await b.newContext({ viewport: VIEWPORT, colorScheme: 'light' });
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.on('pageerror', (e) => note(`Erreur JS : ${firstLine(e.message)}`));
    page.on('requestfailed', (req) => {
      if (['script', 'stylesheet'].includes(req.resourceType())) {
        note(`Ressource injoignable : ${req.url()} (${req.failure()?.errorText ?? 'échec'})`);
      }
    });
    const run = (fn, arg, what) => withTimeout(page.evaluate(fn, arg), timeoutMs, what);
    try {
      await page.setContent(html, { waitUntil: 'networkidle', timeout: timeoutMs });
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
      const { kind, tag, text, context: ctx, html: snippet } = g.c;
      const inner = wholeBody && g.raw > 0 ? { measureOnly: true, parentIndex: 0 } : {};
      return { index, kind, tag, text, context: ctx, html: snippet, occurrences: g.occurrences,
        metrics: { light: g.light, dark: d }, colors, ...inner };
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
    if (context) await withTimeout(context.close(), 5000, 'Fermeture').catch(() => {});
    if (b && !browser) await b.close().catch(() => {});
  }
}

const SHEET_CSS = `body{margin:0;padding:16px;background:#f4f4f2;font:12px/1.4 ui-monospace,Menlo,monospace;color:#222}
#sheet{display:grid;grid-template-columns:repeat(auto-fill,minmax(296px,1fr));gap:12px;align-items:start}
figure{margin:0;border:1px solid #c9c9c4;background:#fff;min-width:0}
figcaption{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid #c9c9c4;overflow:hidden;white-space:nowrap}
figcaption b{flex:none;min-width:22px;height:20px;padding:0 5px;border-radius:10px;background:#e5484d;color:#fff;font-weight:700;text-align:center;line-height:20px}
figcaption span{overflow:hidden;text-overflow:ellipsis;color:#666}
.tile{display:block;max-height:320px;overflow:hidden}`;

/**
 * Planche-contact : chaque candidat rendu comme une tuile de la galerie (Shadow DOM + CSS scopé clair),
 * avec un badge numéroté = candidate.index. Capture PNG pleine page (coupée à 6000 px).
 * styles = { cssLight, cssDark?, css?, fontFaceCss?, fontLinks? } de l'artifact.
 */
export async function renderContactSheet(candidates, styles, outPath, browser, { timeoutMs = 20000 } = {}) {
  const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'light' });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${SHEET_CSS}</style></head>`
      + `<body><div id="sheet"></div></body></html>`);
    await page.addScriptTag({ content: `(() => {\n${TILE_SRC}\nwindow.__caMount = mountSnippet;\n})();` });
    const items = candidates.map((c) => ({ index: c.index, html: c.html,
      label: [c.presetName, c.measureOnly ? 'mesure' : null, c.tag, c.text].filter(Boolean).join(' · ').slice(0, 80) }));
    await withTimeout(page.evaluate(({ items, styles }) => {
      const sheet = document.getElementById('sheet');
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
        window.__caMount(host, { html: it.html, styles, theme: 'light' });
      }
      const links = [...document.head.querySelectorAll('link[rel=stylesheet]')]
        .map((l) => new Promise((r) => { l.addEventListener('load', r); l.addEventListener('error', r); }));
      return Promise.race([Promise.all(links), new Promise((r) => setTimeout(r, 5000))])
        .then(() => document.fonts.ready).then(() => true);
    }, { items, styles: styles || {} }), timeoutMs, 'Planche-contact');
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: outPath, fullPage: true, timeout: timeoutMs,
      ...(height > CONTACT_MAX_HEIGHT ? { clip: { x: 0, y: 0, width: VIEWPORT.width, height: CONTACT_MAX_HEIGHT } } : {}) });
  } finally {
    await withTimeout(context.close(), 5000, 'Fermeture').catch(() => {});
  }
}

/** Écrit candidates.json, styles.json, contact.png et extract.json dans `dir` (CLI page et design system). */
export async function writeRawOutputs(dir, r, browser) {
  if (r.candidates.length) {
    try { await renderContactSheet(r.candidates, r.styles, join(dir, 'contact.png'), browser); } catch (e) {
      r.warnings.push(`Planche-contact : ${firstLine(e.message)}`);
    }
  }
  await writeFile(join(dir, 'candidates.json'), JSON.stringify(r.candidates, null, 1));
  await writeFile(join(dir, 'styles.json'), JSON.stringify(r.styles));
  const summary = { status: r.status, ...(r.error ? { error: r.error } : {}), warnings: r.warnings, candidates: r.candidates.length };
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
