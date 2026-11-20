#!/usr/bin/env node
// Fusionne les classifications partielles d'un artifact (classified.part*.json, écrites par plusieurs
// sous-agents sur des plages d'index) en classified.json, puis valide contre candidates.json.
// Usage : node scripts/merge-classified.mjs <rawDir> → "ok" ou erreurs (exit 1).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateClassified } from './lib/schema.mjs';

const partNo = (f) => Number(/^classified\.part(\d+)\.json$/.exec(f)?.[1]);

/** Lit les parties de `dir` ; renvoie { data, parts, errors } sans rien écrire. */
export function mergeClassified(dir) {
  const files = readdirSync(dir).filter((f) => Number.isFinite(partNo(f))).sort((a, b) => partNo(a) - partNo(b));
  if (!files.length) return { data: null, parts: 0, errors: [`aucun fichier classified.part<N>.json dans ${dir}`] };
  const votes = new Map();
  const items = new Map();
  const errors = [];
  for (const f of files) {
    let part;
    try { part = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch (e) { errors.push(`${f} : illisible (${e.message})`); continue; }
    const p = typeof part?.project === 'string' ? part.project.trim() : '';
    if (p) votes.set(p, (votes.get(p) ?? 0) + 1);
    for (const it of Array.isArray(part?.items) ? part.items : []) {
      if (it && Number.isInteger(it.index) && !items.has(it.index)) items.set(it.index, it);
    }
  }
  // Projet majoritaire (à égalité : celui de la première partie).
  let project = '';
  for (const [p, n] of votes) if (!project || n > votes.get(project)) project = p;
  const data = { project, items: [...items.values()].sort((a, b) => a.index - b.index) };
  const cands = JSON.parse(readFileSync(path.join(dir, 'candidates.json'), 'utf8'));
  return { data, parts: files.length, errors: [...errors, ...validateClassified(data, cands)] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.error('Usage : node scripts/merge-classified.mjs <rawDir>'); process.exit(2); }
  try {
    const { data, parts, errors } = mergeClassified(dir);
    if (data) writeFileSync(path.join(dir, 'classified.json'), JSON.stringify(data, null, 1));
    if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
    console.log(`ok (${parts} parties, ${data.items.length} items)`);
  } catch (e) {
    console.error(`Erreur : ${e.message}`);
    process.exit(1);
  }
}
