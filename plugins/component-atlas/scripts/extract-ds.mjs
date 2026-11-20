#!/usr/bin/env node
// Extraction d'un artifact « Design System » : un candidat 'ds' par composant (aperçu entier)
// + ses contrôles internes (measureOnly). CLI : node scripts/extract-ds.mjs <rawDir>
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from './lib/browser.mjs';
import { tokensToCss } from './lib/tokens.mjs';
import { serializeScoped } from './lib/css.mjs';
import { extractFromHtml, writeRawOutputs } from './extract-page.mjs';

const emptyStyles = () => ({ css: '', cssLight: '', cssDark: '', fontFaceCss: '', fontLinks: [] });
const REACT_VERSION = '18.3.1';
const CDN = 'https://cdn.jsdelivr.net/npm';
const MIME = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const FONT_FORMAT = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };

const readText = (p) => readFile(p, 'utf8');
const readJson = async (p) => JSON.parse(await readText(p));
const maybe = async (p) => (existsSync(p) ? readText(p) : null);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const dataUri = async (p) => `data:${MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'};base64,${(await readFile(p)).toString('base64')}`;
const safeScript = (js) => js.replace(/<\/(script)/gi, '<\\/$1');

// 1re phrase du README (hors titres, citations, blocs de code).
export function firstSentence(md) {
  const para = String(md ?? '').split(/\n\s*\n/).map((p) => p.trim())
    .find((p) => p && !/^(#|>|```|[-*]\s|\||<)/.test(p));
  if (!para) return '';
  const text = para.replace(/\s+/g, ' ').replace(/[*_`]|\[([^\]]*)\]\([^)]*\)/g, '$1');
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  return m ? m[1] : text;
}

function dsCard(html) {
  const m = /<!--\s*@dsCard\b([^>]*?)-->/.exec(html);
  const group = m ? /\bgroup\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(m[1]) : null;
  return { group: group ? (group[1] ?? group[2] ?? group[3]) : '' };
}

async function fontCss(project, tokens, warnings) {
  let faces = '';
  const links = [];
  const type = tokens?.type ?? {};
  const fileFamilies = new Set();
  for (const f of type.fonts ?? []) {
    if (!f?.file) continue;
    const file = join(project, f.file);
    if (!existsSync(file)) { warnings.push(`Police introuvable : ${f.file}`); continue; }
    const fam = f.family ?? f.name;
    if (fam) fileFamilies.add(fam);
    const ext = extname(file).toLowerCase();
    faces += `@font-face{font-family:"${esc(fam ?? basename(file, ext))}";src:url(${await dataUri(file)}) format("${FONT_FORMAT[ext] ?? 'woff2'}");`
      + `${f.weight ? `font-weight:${f.weight};` : ''}${f.style ? `font-style:${f.style};` : ''}font-display:block}`;
  }
  const google = (type.families ?? []).map((x) => (typeof x === 'string' ? x : x?.name ?? x?.family))
    .filter((n) => n && !fileFamilies.has(n) && !/^(system-ui|sans-serif|serif|monospace|ui-\w+)$/i.test(n));
  if (google.length) {
    const q = google.map((n) => `family=${encodeURIComponent(n).replace(/%20/g, '+')}:wght@400;500;600;700`).join('&');
    links.push(`https://fonts.googleapis.com/css2?${q}&display=swap`);
  }
  return { faces, links };
}

async function libraryTags(project, libs, warnings) {
  const libDir = join(project, 'components', 'lib');
  const files = existsSync(libDir) ? (await readdir(libDir)).filter((f) => f.endsWith('.js')).sort() : [];
  const used = new Set();
  const tags = [];
  const wanted = (libs ?? []).map((l) => ({ name: String(l.name ?? l), version: String(l.version ?? '') }));
  for (const { name, version } of wanted) {
    const key = name.toLowerCase();
    const hit = files.filter((f) => f.toLowerCase().includes(key) && !used.has(f));
    // react-dom ne doit pas être pris pour react.
    const own = key === 'react' ? hit.filter((f) => !/react-?dom/i.test(f)) : hit;
    if (own.length) {
      for (const f of own) { used.add(f); tags.push(`<script>${safeScript(await readText(join(libDir, f)))}</script>`); }
    } else if (key === 'react' || key === 'react-dom') {
      const v = /^\d+\.\d+\.\d+$/.test(version) && version.startsWith('18.') ? version : REACT_VERSION;
      tags.push(`<script src="${CDN}/${key}@${v}/umd/${key}.production.min.js"></script>`);
    } else {
      warnings.push(`Bibliothèque absente de components/lib : ${name}${version ? `@${version}` : ''}`);
    }
  }
  for (const f of files) {
    if (used.has(f)) continue;
    tags.push(`<script>${safeScript(await readText(join(libDir, f)))}</script>`);
  }
  return tags;
}

// Les aperçus référencent ../../<chemin> (relatif à components/<Comp>/) et /_blob/<id>.
async function inlinePreview(project, compDir, html, note) {
  const skipped = /(^|\/)(bundle\.(css|js)|tokens\.css)$/;
  const refs = [...html.matchAll(/\b(?:src|href)\s*=\s*["']((?:\.\.\/\.\.\/|\/_blob\/)[^"']*)["']/g)].map((m) => m[1]);
  let out = html;
  for (const ref of new Set(refs)) {
    if (ref.startsWith('/_blob/')) {
      note(`Fichier téléversé indisponible hors ligne : ${ref}`);
      out = out.split(ref).join('data:,');
      continue;
    }
    const rel = ref.slice(6).split(/[?#]/)[0];
    const file = resolve(project, rel);
    if (!file.startsWith(project) || !existsSync(file)) { note(`Ressource introuvable : ${ref}`); continue; }
    const q = esc(ref).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (skipped.test(rel)) {
      out = out.replace(new RegExp(`<link\\b[^>]*["']${q}["'][^>]*>`, 'gi'), '')
        .replace(new RegExp(`<script\\b[^>]*["']${q}["'][^>]*>\\s*</script>`, 'gi'), '');
    } else if (/\.css$/i.test(rel)) {
      const css = await readText(file);
      out = out.replace(new RegExp(`<link\\b[^>]*["']${q}["'][^>]*>`, 'gi'), () => `<style>${css}</style>`);
    } else if (/\.js$/i.test(rel)) {
      const js = safeScript(await readText(file));
      out = out.replace(new RegExp(`<script\\b[^>]*["']${q}["'][^>]*>\\s*</script>`, 'gi'), () => `<script>${js}</script>`);
    } else {
      out = out.split(ref).join(await dataUri(file));
    }
  }
  return out;
}

function stableKey(r) { return JSON.stringify(r); }

export async function extractDesignSystem(rawDir, opts = {}) {
  const { browser: shared, timeoutMs, maxCandidates } = opts;
  const warnings = [];
  const note = (m) => { if (!warnings.includes(m)) warnings.push(m); };
  const fail = (error) => ({ status: 'error', error: String(error).slice(0, 1000), warnings, styles: emptyStyles(), candidates: [] });
  const project = resolve(rawDir, 'project');
  const compRoot = join(project, 'components');
  if (!existsSync(compRoot)) return fail(`Dossier introuvable : ${compRoot}`);

  let tokens = {};
  try { tokens = await readJson(join(project, 'tokens.json')); } catch (e) { note(`tokens.json illisible : ${e.message}`); }
  let ds = {};
  try { ds = await readJson(join(project, 'design-system.json')); } catch (e) { note(`design-system.json illisible : ${e.message}`); }

  const tokensCss = (await maybe(join(project, 'tokens.css'))) ?? tokensToCss(tokens);
  const bundleCss = (await maybe(join(compRoot, 'bundle.css'))) ?? '';
  const bundleJs = await maybe(join(compRoot, 'bundle.js'));
  const { faces, links } = await fontCss(project, tokens, warnings);
  const libs = await libraryTags(project, ds.libraries, warnings);
  const head = `<meta charset="utf-8">${links.map((u) => `<link rel="stylesheet" href="${esc(u)}">`).join('')}`
    + `<style>${faces}</style><style>${tokensCss}</style><style>${bundleCss}</style>${libs.join('')}`
    + (bundleJs ? `<script>${safeScript(bundleJs)}</script>` : '');

  const names = (await readdir(compRoot, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'lib' && d.name !== 'Cover')
    .map((d) => d.name).sort();
  const jobs = names.filter((n) => existsSync(join(compRoot, n, 'preview.html')));
  if (!jobs.length) return fail('Aucun aperçu de composant (components/<Comp>/preview.html)');

  let b = shared;
  const candidates = [];
  const rules = [];
  const seenRules = new Set();
  const fontLinks = [];
  try {
    b ??= await launch();
    for (const name of jobs) {
      const dir = join(compRoot, name);
      const raw = await readText(join(dir, 'preview.html'));
      const { group } = dsCard(raw);
      const body = await inlinePreview(project, dir, raw.replace(/<!--\s*@dsCard\b[^>]*?-->/, ""), note);
      const doc = `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
      const r = await extractFromHtml(doc, { browser: b, timeoutMs, maxCandidates, wholeBody: true, keepRules: true });
      for (const w of r.warnings) note(`${name} : ${w}`);
      if (r.status !== 'ok' || !r.candidates.length) { note(`${name} : rendu impossible${r.error ? ` (${r.error})` : ''}`); continue; }
      for (const rule of r.rules ?? []) {
        const k = stableKey(rule);
        if (!seenRules.has(k)) { seenRules.add(k); rules.push(rule); }
      }
      for (const u of r.styles.fontLinks) if (!fontLinks.includes(u)) fontLinks.push(u);
      const offset = candidates.length;
      const desc = firstSentence(await maybe(join(dir, 'README.md')));
      r.candidates.forEach((c, i) => {
        const out = { ...c, index: offset + i };
        if (i === 0) Object.assign(out, { presetName: name, description: desc, context: group });
        else { out.parentIndex = offset; if (!out.context) out.context = group; }
        candidates.push(out);
      });
    }
    if (!candidates.length) return fail('Aucun composant rendu');

    const { css, fontFaceCss } = serializeScoped(rules);
    const cssLight = serializeScoped(rules, { scheme: 'light' }).css;
    const cssDark = serializeScoped(rules, { scheme: 'dark' }).css;
    return { status: 'ok', warnings, styles: { css, cssLight, cssDark, fontFaceCss, fontLinks }, candidates };
  } catch (e) {
    return fail(String(e.message).split('\n')[0]);
  } finally {
    if (b && !shared) await b.close().catch(() => {});
  }
}

async function main(argv) {
  const dir = argv[0];
  if (!dir) {
    process.stderr.write('Usage : node scripts/extract-ds.mjs <rawDir>\n');
    process.exit(2);
  }
  const browser = await launch();
  try {
    const r = await extractDesignSystem(dir, { browser });
    await writeRawOutputs(dir, r, browser);
  } finally { await browser.close().catch(() => {}); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { process.stderr.write(`${e.stack || e}\n`); process.exit(1); });
}
