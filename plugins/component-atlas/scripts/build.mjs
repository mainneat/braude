#!/usr/bin/env node
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadJson, saveJson } from './lib/cache.mjs';
import { componentKey } from './lib/hash.mjs';
import { validateClassified } from './lib/schema.mjs';
import { TAXONOMY, autoType } from './lib/taxonomy.mjs';
import { bundleScripts } from './lib/inline.mjs';
import { CSS_CHUNK_SEP } from './lib/css.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.join(HERE, '..', 'seed', 'projects.louis.json');
const MAX_FACE = 2_000_000;
const MAX_DATA = 15 * 1024 * 1024;
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

/** Split a CSS string into individual @font-face rules (brace- and string-aware). */
export function splitFontFaces(css) {
  const out = [];
  const s = String(css || '');
  let i = 0;
  while ((i = s.indexOf('@font-face', i)) !== -1) {
    let depth = 0, j = i, quote = null, started = false;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (quote) { if (ch === '\\') j++; else if (ch === quote) quote = null; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{') { depth++; started = true; }
      else if (ch === '}' && --depth === 0 && started) { j++; break; }
    }
    out.push(s.slice(i, j).trim());
    i = j;
  }
  return out;
}

const faceFamily = (rule) => (/font-family\s*:\s*(?:"([^"]*)"|'([^']*)'|([^;}]+))/i.exec(rule) || []).slice(1).find(Boolean)?.trim() || 'inconnue';

export function assertSize(data, json) {
  const size = Buffer.byteLength(json);
  if (size <= MAX_DATA) return size;
  const per = data.artifacts.map((a) => {
    let n = 0;
    const chunks = new Set();
    for (const [sid, st] of Object.entries(data.styles)) {
      if (sid !== a.id && !sid.startsWith(`${a.id}:`)) continue;
      n += (st.cssLight || '').length + (st.cssDark || '').length;
      for (const c of [...(st.light || []), ...(st.dark || [])]) chunks.add(c);
      for (const f of st.fontIds || []) n += (data.fonts[f] || '').length;
    }
    for (const c of chunks) n += (data.css?.[c] || '').length;
    for (const c of data.components) if (c.artifactId === a.id) n += JSON.stringify(c).length;
    return { title: a.title, n };
  }).sort((x, y) => y.n - x.n).slice(0, 5);
  throw new Error(`data.json dépasse 15 Mo (${(size / 1048576).toFixed(1)} Mo). Plus gros artifacts :\n` +
    per.map((p) => `  - ${p.title} (~${(p.n / 1048576).toFixed(1)} Mo)`).join('\n'));
}

export const MAX_SHARD = 4 * 1024 * 1024;
const MAX_FILE = 16 * 1024 * 1024;

/** Mesures sombres réduites à ce qui diffère du clair ; valeurs nulles retirées (la galerie les reconstitue). */
function packMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return metrics;
  const clean = (m) => Object.fromEntries(Object.entries(m || {}).filter(([, v]) => v !== null && v !== undefined));
  const light = clean(metrics.light);
  const out = { light };
  if (metrics.dark) {
    const dark = {};
    for (const [k, v] of Object.entries(metrics.dark)) if (v !== light[k] && !(v === null && light[k] === undefined)) dark[k] = v;
    if (Object.keys(dark).length) out.dark = dark;
  }
  return out;
}

/**
 * Composant tel qu'écrit dans data.json : sans HTML, champs implicites omis (reconstitués par
 * unpackComponent de gallery/src/logic.mjs) : `sources` à une seule source, `isDS` faux, `colors`
 * (déductibles des mesures), `styleId` réduit à son groupe (`sg`) quand il appartient à l'artifact.
 */
function packComponent(c) {
  const { html, colors, ...out } = c;
  out.metrics = packMetrics(c.metrics);
  if (typeof c.styleId === 'string' && c.styleId.startsWith(`${c.artifactId}:`)) {
    delete out.styleId;
    out.sg = c.styleId.slice(c.artifactId.length + 1);
  }
  const s = c.sources || [];
  if (s.length === 1 && s[0].artifactId === c.artifactId && s[0].occurrences === c.occurrences) delete out.sources;
  if (!out.isDS) delete out.isDS;
  return out;
}

/**
 * Sépare les données de la galerie : `data` (data.json : filtres, matrice, nuancier, mesures, légendes —
 * sans HTML ni texte CSS ni @font-face) et `shards` (dist/a/<artifactId>.json = {html, css, fonts} :
 * HTML des composants dont l'artifact principal est celui-ci, morceaux CSS et polices de ses groupes de styles).
 * Un artifact qui dépasse `maxShardBytes` est découpé en a/<id>.json, a/<id>-2.json… ; la liste va dans
 * `artifacts[].shards` (la galerie charge toutes les parts d'un artifact avant d'en rendre un composant).
 */
export function shardData(full, { maxShardBytes = MAX_SHARD } = {}) {
  const per = new Map(); // artifactId → [[section, id, texte]…]
  const add = (aid, section, id, text) => {
    if (!per.has(aid)) per.set(aid, { seen: new Set(), items: [] });
    const p = per.get(aid);
    const k = `${section}:${id}`;
    if (p.seen.has(k) || typeof text !== 'string') return;
    p.seen.add(k);
    p.items.push([section, id, text]);
  };
  const ownerOf = (sid) => String(sid).split(':')[0];
  const styles = {};
  for (const [sid, st] of Object.entries(full.styles || {})) {
    const aid = ownerOf(sid);
    for (const c of [...(st.light || []), ...(st.dark || [])]) add(aid, 'css', c, full.css?.[c]);
    for (const f of st.fontIds || []) add(aid, 'fonts', f, full.fonts?.[f]);
    styles[sid] = st;
  }
  for (const c of full.components) if (!c.measureOnly && typeof c.html === 'string') add(c.artifactId, 'html', c.key, c.html);

  const shards = [];
  const shardLists = new Map();
  for (const [aid, { items }] of per) {
    const parts = [];
    let cur = null;
    for (const [section, id, text] of items) {
      const n = Buffer.byteLength(JSON.stringify(id)) + Buffer.byteLength(JSON.stringify(text)) + 2;
      if (!cur || (cur.bytes + n > maxShardBytes && cur.bytes > 40)) {
        cur = { body: { html: {}, css: {}, fonts: {} }, bytes: 40 };
        parts.push(cur);
      }
      cur.body[section][id] = text;
      cur.bytes += n;
    }
    const names = parts.map((_, k) => (k === 0 ? `a/${aid}.json` : `a/${aid}-${k + 1}.json`));
    parts.forEach((p, k) => {
      const json = JSON.stringify(p.body);
      if (Buffer.byteLength(json) > MAX_FILE) throw new Error(`${names[k]} dépasse 16 Mo : un composant de « ${aid} » est trop lourd.`);
      shards.push({ name: names[k], artifactId: aid, json });
    });
    shardLists.set(aid, names);
  }

  const data = {
    ...full,
    artifacts: full.artifacts.map((a) => ({ ...a, shards: shardLists.get(a.id) || [] })),
    styles,
    components: full.components.map(packComponent),
  };
  delete data.css;
  delete data.fonts;
  return { data, shards };
}

export async function buildData({ dir, now }) {
  const inventory = await loadJson(path.join(dir, 'inventory.json'), []);
  const plan = await loadJson(path.join(dir, 'plan.json'), { toProcess: [], removed: [], unchanged: [] });
  const cache = await loadJson(path.join(dir, 'cache.json'), { galleryUrl: null, artifacts: {} });
  const removed = new Set(plan.removed || []);
  const invIds = new Set(inventory.map((a) => a.id));

  const projFile = path.join(dir, 'projects.json');
  let projects = await loadJson(projFile, null);
  if (projects === null) {
    const seed = await loadJson(SEED, {});
    projects = Object.fromEntries(Object.entries(seed).filter(([id]) => invIds.has(id)));
  }

  const ordered = inventory.filter((a) => !removed.has(a.id))
    .sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0));

  // styles : { '<artifactId>:<groupe>': { light:[idCss…], dark:[idCss…], fontIds, fontLinks } } ;
  // css : { idCss: texte } — une feuille source par morceau, partagée entre groupes et artifacts.
  const data = { generatedAt: now, taxonomy: TAXONOMY, artifacts: [], styles: {}, css: {}, fonts: {}, components: [], notes: [] };
  const byKey = new Map();

  for (const inv of ordered) {
    const raw = path.join(dir, 'raw', inv.id);
    const meta = await loadJson(path.join(raw, 'meta.json'), null);
    if (!meta) continue;
    const entry = { id: inv.id, url: meta.url ?? inv.url, title: meta.title ?? inv.title, updated: inv.updated, project: projects[inv.id] || 'Sans projet', kind: meta.kind, status: 'ok', componentCount: 0, warnings: [] };
    data.artifacts.push(entry);
    const fail = (note) => { entry.status = 'error'; entry.note = note; };

    if (meta.kind === 'other-type') { entry.status = 'skipped'; entry.note = `Type ${meta.typeName ?? 'inconnu'} non analysé`; continue; }
    const extract = await loadJson(path.join(raw, 'extract.json'), null);
    entry.warnings = extract?.warnings ?? [];
    if (!extract) { fail('Extraction manquante'); continue; }
    if (extract.status === 'error') { fail(extract.error || 'Extraction en erreur'); continue; }
    const cands = await loadJson(path.join(raw, 'candidates.json'), []);
    const classified = await loadJson(path.join(raw, 'classified.json'), null).catch(() => undefined);
    if ((classified === null || classified === undefined) && cands.length === 0) continue; // page sans composant : ok, vide
    if (classified === null || classified === undefined) { fail('Classification manquante'); continue; }
    const errs = validateClassified(classified, cands);
    if (errs.length) { fail(errs.join(' ; ')); continue; }

    if (!projects[inv.id]) { projects[inv.id] = classified.project; entry.project = classified.project; }

    const stored = await loadJson(path.join(raw, 'styles.json'), {});
    const groups = stored && stored.groups && typeof stored.groups === 'object' ? stored.groups : { main: stored || {} };
    const firstGroup = Object.keys(groups)[0] ?? 'main';
    const chunkIds = (css) => String(css ?? '').split(CSS_CHUNK_SEP).filter(Boolean).map((t) => {
      const id = sha1(t).slice(0, 16);
      data.css[id] = t;
      return id;
    });
    for (const [gid, st] of Object.entries(groups)) {
      const fontIds = [];
      for (const rule of splitFontFaces(st.fontFaceCss)) {
        if (rule.length > MAX_FACE) {
          const note = `Police ${faceFamily(rule)} retirée (trop lourde) — ${entry.title}`;
          if (!data.notes.includes(note)) data.notes.push(note);
          continue;
        }
        const id = sha1(rule);
        data.fonts[id] = rule;
        if (!fontIds.includes(id)) fontIds.push(id);
      }
      data.styles[`${inv.id}:${gid}`] = { light: chunkIds(st.cssLight), dark: chunkIds(st.cssDark), fontLinks: st.fontLinks ?? [], fontIds };
    }

    const items = new Map(classified.items.map((it) => [it.index, it]));
    for (const c of cands) {
      const it = items.get(c.index);
      const measure = !!c.measureOnly;
      if (!measure && !(it && it.keep)) continue;
      const name = (c.kind === 'ds' && c.presetName) || (it && it.name) || c.presetName || c.text || 'Mesure';
      // measureOnly : jamais vu par le classifieur, type déduit du détecteur.
      const type = measure ? autoType(c) : ((it && it.type) || 'other');
      const key = componentKey(c.html, c.metrics.light);
      const occ = c.occurrences || 1;
      entry.componentCount++;
      let comp = byKey.get(key);
      if (!comp) {
        const styleId = `${inv.id}:${groups[c.styleGroup] ? c.styleGroup : firstGroup}`;
        comp = { key, type, name, project: entry.project, isDS: c.kind === 'ds', sources: [], occurrences: 0, artifactId: inv.id, styleId, metrics: c.metrics, colors: c.colors || [] };
        if (c.description) comp.description = c.description;
        // measureOnly : jamais rendu dans la galerie, donc sans HTML.
        if (measure) comp.measureOnly = true; else comp.html = c.html;
        byKey.set(key, comp);
        data.components.push(comp);
      } else {
        if (c.kind === 'ds') comp.isDS = true;
        if (!comp.description && c.description) comp.description = c.description;
        if (!measure && comp.measureOnly) { delete comp.measureOnly; comp.html = c.html; }
      }
      comp.occurrences += occ;
      const src = comp.sources.find((s) => s.artifactId === inv.id);
      if (src) src.occurrences += occ; else comp.sources.push({ artifactId: inv.id, occurrences: occ });
    }
  }

  await saveJson(projFile, projects);
  const artifacts = {};
  for (const a of data.artifacts) artifacts[a.id] = { updated: a.updated, status: a.status };
  await saveJson(path.join(dir, 'cache.json'), { ...cache, artifacts });
  return data;
}

const GALLERY = path.join(HERE, '..', 'gallery');
const GALLERY_MODULES = ['tile', 'logic', 'views', 'main'];

/** Galerie autonome : le gabarit avec les modules de gallery/src inlinés à la place de <!--APP-->. */
export function inlineGallery() {
  const tpl = readFileSync(path.join(GALLERY, 'index.template.html'), 'utf8');
  if (!tpl.includes('<!--APP-->')) throw new Error('index.template.html : marqueur <!--APP--> absent');
  const js = bundleScripts(GALLERY_MODULES.map((m) => readFileSync(path.join(GALLERY, 'src', `${m}.mjs`), 'utf8')));
  return tpl.replace('<!--APP-->', () => `<script>\n${js}\n</script>`);
}

/** Écrit dist/index.html (la galerie à publier avec dist/data.json). */
export async function writeGallery(distDir) {
  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(path.join(distDir, 'index.html'), inlineGallery());
  return true;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const dir = arg('--dir', '.component-atlas');
  const maxShardBytes = Number(arg('--max-shard', MAX_SHARD));
  const full = await buildData({ dir, now: new Date().toISOString() });
  const { data, shards } = shardData(full, { maxShardBytes });
  const json = JSON.stringify(data);
  assertSize(data, json);
  const dist = path.join(dir, 'dist');
  // dist/a reflète exactement le build courant : les parts obsolètes disparaissent (publish-plan les retire).
  await fs.rm(path.join(dist, 'a'), { recursive: true, force: true });
  await fs.mkdir(path.join(dist, 'a'), { recursive: true });
  await fs.writeFile(path.join(dist, 'data.json'), json);
  for (const s of shards) await fs.writeFile(path.join(dist, s.name), s.json);
  await writeGallery(dist);
  const mb = (n) => (n / 1048576).toFixed(2);
  const sizes = shards.map((s) => Buffer.byteLength(s.json));
  console.log(`data.json : ${data.artifacts.length} artifacts, ${data.components.length} composants, ${mb(Buffer.byteLength(json))} Mo`);
  console.log(`a/*.json : ${shards.length} fichiers, ${mb(sizes.reduce((x, y) => x + y, 0))} Mo au total, le plus gros ${mb(Math.max(0, ...sizes))} Mo`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
