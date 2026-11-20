#!/usr/bin/env node
// Extraction d'un artifact de type « Design » (canevas d'artboards `.dc.html`).
// Chaque planche est rendue dans Chromium comme dans l'éditeur : servie depuis une origine
// locale interceptée (aucun serveur), avec le runtime du type (`artifact-type/dc-runtime.js`,
// demandé par les planches sous le nom `./support.js`) qui résout gabarits, {{trous}},
// <sc-for>/<sc-if> et <dc-import> (planches sœurs), et avec les CSS du projet (DS embarqué
// sous project/ds/…). Détection standard, candidats fusionnés entre planches.
// CLI : node scripts/extract-design.mjs <rawDir>
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/browser.mjs';
import { serializeScoped, SHELL_RESET_CSS, CSS_CHUNK_SEP } from './lib/css.mjs';
import { createHash } from 'node:crypto';
import { extractRendered, writeRawOutputs } from './extract-page.mjs';

const ORIGIN = 'http://design.atlas.invalid';
const RUNTIME = join('artifact-type', 'dc-runtime.js');
const CONTEXT_MAX = 80;
const SKIP_DIRS = new Set(['audit', 'assets', 'uploads', 'node_modules']);
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf' };

const emptyStyles = () => ({ css: '', cssLight: '', cssDark: '', fontFaceCss: '', fontLinks: [] });
const firstLine = (s) => String(s ?? '').split('\n')[0].trim();
const clamp = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

async function listDcFiles(project, dir = project, out = []) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await listDcFiles(project, join(dir, e.name), out); }
    else if (e.name.endsWith('.dc.html')) out.push(relative(project, join(dir, e.name)).split(sep).join('/'));
  }
  return out;
}

/**
 * Planches à rendre, dans l'ordre de priorité : planches de composants (page du canevas nommée
 * « Components » ou fichier c-*), puis l'ordre du canevas, puis les fichiers hors canevas.
 */
export async function listArtboards(project, canvas) {
  const boards = canvas?.boards && typeof canvas.boards === 'object' ? canvas.boards : {};
  const pageName = Object.fromEntries((Array.isArray(canvas?.pages) ? canvas.pages : []).map((p) => [p?.id, String(p?.name ?? p?.id ?? '')]));
  const order = Array.isArray(canvas?.order) ? canvas.order.filter((f) => typeof f === 'string') : [];
  const files = await listDcFiles(project);
  const names = [...new Set([...order, ...Object.keys(boards), ...files.sort()])];
  const list = names.map((file, i) => {
    const b = boards[file] ?? {};
    const page = pageName[b.page] ?? b.page ?? '';
    const base = file.split('/').pop();
    const component = /compon/i.test(page) || /^c-/.test(base);
    return { file, i, title: typeof b.title === 'string' && b.title.trim() ? b.title.trim() : '', page,
      w: Number(b.w), h: Number(b.h), component, inCanvas: file in boards || order.includes(file) };
  });
  const counts = new Map();
  for (const x of list) if (x.title) counts.set(x.title, (counts.get(x.title) ?? 0) + 1);
  for (const x of list) x.repeated = !!x.title && counts.get(x.title) > 1;
  return list.sort((a, b) => (b.component - a.component) || (a.i - b.i));
}

const titleOf = (html, file) => {
  const t = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  return t || file.split('/').pop().replace(/\.dc\.html$/, '');
};

function stableKey(r) { return JSON.stringify(r); }
const sha1 = (s) => createHash('sha1').update(s).digest('hex');
const stemOf = (file) => file.split('/').pop().replace(/\.dc\.html$/, '');

/**
 * Extrait un artifact Design copié dans `rawDir` (`project/…` et, si présent, `artifact-type/dc-runtime.js`).
 * opts : browser (partagé), timeoutMs (par planche), maxCandidates (après fusion), perBoard (par planche),
 * budgetMs (temps total ; au-delà les planches restantes sont ignorées avec une note).
 */
export async function extractDesign(rawDir, opts = {}) {
  const { browser: shared, timeoutMs = 15000, maxCandidates = 250, perBoard = 150, budgetMs = 15 * 60 * 1000 } = opts;
  const warnings = [];
  const note = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const stats = { artboards: { total: 0, rendered: 0, notMounted: 0, failed: 0, skipped: 0 } };
  const fail = (error) => ({ status: 'error', error: String(error).slice(0, 1000), warnings, styles: emptyStyles(), candidates: [], stats });
  const root = resolve(rawDir);
  const project = join(root, 'project');
  if (!existsSync(project)) return fail(`Dossier introuvable : ${project}`);

  let canvas = null;
  if (existsSync(join(project, 'canvas.json'))) {
    try { canvas = JSON.parse(await readFile(join(project, 'canvas.json'), 'utf8')); } catch (e) { note(`canvas.json illisible : ${firstLine(e.message)}`); }
  } else note('canvas.json absent : titres tirés des fichiers');

  const boards = await listArtboards(project, canvas);
  stats.artboards.total = boards.length;
  if (!boards.length) return fail('Aucune planche (.dc.html) dans project/');

  const runtimePath = join(root, RUNTIME);
  const hasRuntime = existsSync(runtimePath);
  if (!hasRuntime) note('Runtime Design absent (artifact-type/dc-runtime.js) : rendu statique, gabarits non résolus');

  let b = shared;
  let context;
  const candidates = [];
  const byKey = new Map();
  // Groupes de styles : planches au même jeu de feuilles (identiques règle pour règle).
  const sheetIds = new Map(); // clé de feuille → id
  const sheetRules = []; // id → règles
  const groupIds = new Map(); // liste d'ids de feuilles → gid
  const groups = new Map(); // gid → { sheets:[ids], fontLinks:[] }
  let dropped = 0;
  const truncatedBoards = new Set();
  const started = Date.now();
  try {
    b ??= await launch();
    context = await b.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
    // Origine locale : tout est servi depuis rawDir ; ./support.js → runtime du type.
    await context.route(`${ORIGIN}/**`, async (route) => {
      let p;
      try { p = decodeURIComponent(new URL(route.request().url()).pathname); } catch { p = '/'; }
      let file = /\/support\.js$/.test(p) ? runtimePath : resolve(root, '.' + p);
      if (!file.startsWith(root + sep)) return route.fulfill({ status: 403, body: '' });
      if (!existsSync(file) && /\/support\.js$/.test(p)) return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
      try {
        const body = await readFile(file);
        await route.fulfill({ status: 200, body, contentType: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
      } catch { await route.fulfill({ status: 404, body: '' }).catch(() => {}); }
    });
    const page = await context.newPage();

    for (const board of boards) {
      const path = join(project, board.file);
      const label = board.title || board.file.replace(/\.dc\.html$/, '');
      if (!existsSync(path)) { note(`${label} : planche introuvable (${board.file})`); stats.artboards.failed++; continue; }
      if (Date.now() - started > budgetMs) { stats.artboards.skipped++; continue; }
      const base = board.title || titleOf(await readFile(path, 'utf8').catch(() => ''), board.file);
      // Titre répété sur plusieurs planches (« States » ×41) : on ajoute le nom du fichier.
      const title = board.repeated ? `${base} (${stemOf(board.file)})` : base;
      await page.setViewportSize({ width: clamp(board.w, 360, 1920, 1280), height: clamp(board.h, 400, 1400, 900) }).catch(() => {});
      let mounted = true;
      const load = async (pg, t) => {
        await pg.goto(`${ORIGIN}/project/${board.file.split('/').map(encodeURIComponent).join('/')}`, { waitUntil: 'networkidle', timeout: t });
        if (hasRuntime) {
          await pg.waitForFunction(() => !document.querySelector('x-dc'), undefined, { timeout: Math.min(5000, t) })
            .catch(() => { mounted = false; note(`${title} : gabarit non monté par le runtime`); });
          await pg.waitForLoadState('networkidle', { timeout: Math.min(5000, t) }).catch(() => {});
        }
      };
      const r = await extractRendered(load, { page, timeoutMs, maxCandidates: perBoard, keepRules: true, ownKeys: true });
      for (const w of r.warnings) note(`${title} : ${w}`);
      if (r.status !== 'ok') { note(`${title} : rendu impossible${r.error ? ` (${r.error})` : ''}`); stats.artboards.failed++; continue; }
      if (mounted) stats.artboards.rendered++; else stats.artboards.notMounted++;
      const ids = (r.sheets ?? [r.rules ?? []]).map((list) => {
        const k = sha1(stableKey(list));
        if (!sheetIds.has(k)) { sheetIds.set(k, sheetRules.length); sheetRules.push(list); }
        return sheetIds.get(k);
      });
      const gk = ids.join(',');
      if (!groupIds.has(gk)) { const id = `g${groupIds.size + 1}`; groupIds.set(gk, id); groups.set(id, { sheets: ids, fontLinks: [] }); }
      const gid = groupIds.get(gk);
      const grp = groups.get(gid);
      for (const u of r.styles.fontLinks) if (!grp.fontLinks.includes(u)) grp.fontLinks.push(u);
      for (const c of r.candidates) {
        const { ownKey, ...rest } = c;
        const key = ownKey ?? stableKey([c.html, c.metrics.light]);
        const seen = byKey.get(key);
        if (seen) { seen.occurrences += c.occurrences || 1; continue; }
        if (candidates.length >= maxCandidates) { dropped++; truncatedBoards.add(board.file); continue; }
        const ctx = rest.context ? `${title} · ${rest.context}` : title;
        const out = { ...rest, index: candidates.length, context: cut(ctx, CONTEXT_MAX), styleGroup: gid };
        byKey.set(key, out);
        candidates.push(out);
      }
    }
    if (stats.artboards.skipped) note(`${stats.artboards.skipped} planche(s) ignorée(s) : budget de temps dépassé`);
    if (dropped) {
      stats.artboards.truncated = truncatedBoards.size;
      note(`${dropped} candidat(s) au-delà du plafond de ${maxCandidates} ignoré(s), venant de ${truncatedBoards.size} planche(s) (planches de composants prioritaires)`);
    }
    if (stats.artboards.notMounted) note(`${stats.artboards.notMounted} planche(s) non montée(s) par le runtime (gabarit brut)`);
    if (!stats.artboards.rendered && !candidates.length) return fail('Aucune planche rendue');

    // Seuls les groupes utilisés par un candidat retenu sont sérialisés. Une feuille = un morceau
    // (séparé par CSS_CHUNK_SEP) : le build dédoublonne les feuilles communes entre groupes.
    const memo = new Map();
    const chunk = (id, scheme) => {
      const k = `${id}:${scheme}`;
      if (!memo.has(k)) memo.set(k, serializeScoped(sheetRules[id], { scheme, shellReset: false }));
      return memo.get(k);
    };
    const styleGroups = {};
    for (const gid of new Set(candidates.map((c) => c.styleGroup))) {
      const g = groups.get(gid);
      const join = (scheme) => [...g.sheets.map((id) => chunk(id, scheme).css).filter(Boolean), SHELL_RESET_CSS].join(CSS_CHUNK_SEP);
      styleGroups[gid] = { css: join('auto'), cssLight: join('light'), cssDark: join('dark'),
        fontFaceCss: [...new Set(g.sheets.map((id) => chunk(id, 'auto').fontFaceCss).filter(Boolean))].join(''), fontLinks: g.fontLinks };
    }
    stats.styleGroups = Object.keys(styleGroups).length;
    return { status: 'ok', warnings, styleGroups, styles: styleGroups[candidates[0]?.styleGroup] ?? emptyStyles(), candidates, stats };
  } catch (e) {
    return fail(firstLine(e.message));
  } finally {
    if (context) await context.close().catch(() => {});
    if (b && !shared) await b.close().catch(() => {});
  }
}

async function main(argv) {
  const dir = argv[0];
  if (!dir) {
    process.stderr.write('Usage : node scripts/extract-design.mjs <rawDir>\n');
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
    const t0 = Date.now();
    const r = await extractDesign(dir, { browser });
    r.stats = { ...r.stats, durationMs: Date.now() - t0 };
    await writeRawOutputs(dir, r, browser);
  } finally { await browser.close().catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
}
