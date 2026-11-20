#!/usr/bin/env node
// Usage : node validate-classified.mjs <rawDir> : affiche les erreurs (exit 1) ou "ok".
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateClassified } from './lib/schema.mjs';

const dir = process.argv[2];
if (!dir) { console.error('Usage : node scripts/validate-classified.mjs <rawDir>'); process.exit(2); }
try {
  const c = JSON.parse(readFileSync(path.join(dir, 'classified.json'), 'utf8'));
  const cands = JSON.parse(readFileSync(path.join(dir, 'candidates.json'), 'utf8'));
  const errs = validateClassified(c, cands);
  if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
  console.log('ok');
} catch (e) {
  console.error(`Erreur : ${e.message}`);
  process.exit(1);
}
