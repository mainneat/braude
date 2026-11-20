#!/usr/bin/env node
// Plan de publication de la galerie : lots d'appels Artifact (publish) pour dist/index.html,
// dist/data.json et les parts dist/a/*.json, dans les limites d'un publish (255 fichiers, 64 Mo).
//   node publish-plan.mjs --dir .component-atlas            → JSON [{file_path, files}, …] sur stdout
//   node publish-plan.mjs --dir .component-atlas --done URL → enregistre galleryUrl et les parts publiées
import { statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadJson, saveJson } from './lib/cache.mjs';

export const MAX_FILES = 250; // par publish (limite 255)
export const MAX_BYTES = 60 * 1024 * 1024; // par publish (limite 64 Mo)
const VERSION_FILES = 511;
const VERSION_BYTES = 256 * 1024 * 1024;

/** Parts courantes, d'après dist/data.json (artifacts[].shards). */
async function currentShards(dist) {
  const data = await loadJson(path.join(dist, 'data.json'), null);
  if (!data) throw new Error(`${path.join(dist, 'data.json')} introuvable : lance d'abord build.mjs.`);
  const list = [];
  for (const a of data.artifacts || []) for (const s of a.shards || []) if (!list.includes(s)) list.push(s);
  for (const s of list) if (!existsSync(path.join(dist, s))) throw new Error(`${s} référencé par data.json mais absent de dist/.`);
  return list;
}

/**
 * Lots de publication. Le premier porte data.json, les premières parts et le retrait (null) des parts
 * publiées auparavant qui n'existent plus ; les suivants ajoutent le reste des parts à la même url.
 */
export async function publishPlan({ dir, maxFiles = MAX_FILES, maxBytes = MAX_BYTES }) {
  const root = path.resolve(dir);
  const dist = path.join(root, 'dist');
  const page = path.join(dist, 'index.html');
  if (!existsSync(page)) throw new Error(`${page} introuvable : lance d'abord build.mjs.`);
  const shards = await currentShards(dist);
  const cache = await loadJson(path.join(root, 'cache.json'), {});
  const stale = (cache.publishedShards || []).filter((s) => !shards.includes(s));

  const size = (rel) => statSync(path.join(dist, rel)).size;
  const total = [page, path.join(dist, 'data.json')].reduce((n, f) => n + statSync(f).size, 0) + shards.reduce((n, s) => n + size(s), 0);
  if (shards.length + 2 > VERSION_FILES || total > VERSION_BYTES) {
    throw new Error(`Galerie trop lourde pour une version d'artifact : ${shards.length + 2} fichiers, ${(total / 1048576).toFixed(1)} Mo (max ${VERSION_FILES} fichiers, 256 Mo).`);
  }

  const batches = [];
  let cur = null;
  const open = () => {
    cur = { file_path: page, files: {}, n: 0, bytes: statSync(page).size };
    batches.push(cur);
  };
  open();
  cur.files['data.json'] = path.join(dist, 'data.json');
  cur.n++;
  cur.bytes += size('data.json');
  for (const s of stale) { cur.files[s] = null; cur.n++; }
  for (const s of shards) {
    const b = size(s);
    if (cur.n + 1 > maxFiles || (cur.bytes + b > maxBytes && cur.n > 0)) open();
    cur.files[s] = path.join(dist, s);
    cur.n++;
    cur.bytes += b;
  }
  return batches.map(({ file_path, files }) => ({ file_path, files }));
}

/** Après la publication de tous les lots : url de la galerie et liste des parts désormais en ligne. */
export async function recordPublished({ dir, url }) {
  const root = path.resolve(dir);
  const shards = await currentShards(path.join(root, 'dist'));
  const file = path.join(root, 'cache.json');
  const cache = await loadJson(file, { galleryUrl: null, artifacts: {} });
  await saveJson(file, { ...cache, galleryUrl: url, publishedShards: shards });
  return shards;
}

async function main() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };
  const dir = arg('--dir') || '.component-atlas';
  const done = arg('--done');
  if (process.argv.includes('--done')) {
    if (!done) throw new Error('--done attend l’url de la galerie.');
    const shards = await recordPublished({ dir, url: done });
    console.log(`ok : galleryUrl enregistrée, ${shards.length} parts publiées`);
    return;
  }
  console.log(JSON.stringify(await publishPlan({ dir }), null, 1));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
