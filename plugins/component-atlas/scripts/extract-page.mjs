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

const DETECT_SRC = readFileSync(new URL('./browser/detect.js', import.meta.url), 'utf8');
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
// opts.contactPath (interne au CLI) : capture de la page avec les candidats numérotés.
export async function extractFromHtml(html, { maxCandidates = 150, timeoutMs = 20000, browser, contactPath, wholeBody = false, badgeOffset = 0, keepRules = false } = {}) {
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

    if (contactPath) {
      try {
        await page.emulateMedia({ colorScheme: 'light' });
        await run(settle, undefined, 'Stabilisation');
        await run((pairs) => window.__caBadges(pairs), kept.map((g, i) => [g.raw, i + badgeOffset]), 'Badges');
        const height = await run(() => document.documentElement.scrollHeight, undefined, 'Hauteur');
        await page.screenshot({ path: contactPath, fullPage: true, timeout: timeoutMs,
          ...(height > CONTACT_MAX_HEIGHT ? { clip: { x: 0, y: 0, width: VIEWPORT.width, height: CONTACT_MAX_HEIGHT } } : {}) });
      } catch (e) {
        note(`Planche-contact : ${firstLine(e.message)}`);
      }
    }

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

async function main(argv) {
  const dir = argv[0];
  if (!dir) {
    process.stderr.write('Usage : node scripts/extract-page.mjs <rawDir>\n');
    process.exit(2);
  }
  const r = await extractPage(join(dir, 'index.html'), { contactPath: join(dir, 'contact.png') });
  await writeFile(join(dir, 'candidates.json'), JSON.stringify(r.candidates, null, 1));
  await writeFile(join(dir, 'styles.json'), JSON.stringify(r.styles));
  const summary = { status: r.status, ...(r.error ? { error: r.error } : {}), warnings: r.warnings, candidates: r.candidates.length };
  await writeFile(join(dir, 'extract.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(JSON.stringify(summary) + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
}
