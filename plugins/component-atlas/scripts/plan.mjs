#!/usr/bin/env node
import path from 'node:path';
import { loadJson, saveJson, planRun } from './lib/cache.mjs';

const i = process.argv.indexOf('--dir');
const dir = i > -1 && process.argv[i + 1] ? process.argv[i + 1] : '.component-atlas';

const inventory = await loadJson(path.join(dir, 'inventory.json'), null);
if (!Array.isArray(inventory)) {
  console.error(`Erreur : ${path.join(dir, 'inventory.json')} introuvable ou invalide. Lancez d'abord l'inventaire des artifacts.`);
  process.exit(1);
}
const cache = await loadJson(path.join(dir, 'cache.json'), { galleryUrl: null, artifacts: {} });
const plan = planRun(inventory, cache);
await saveJson(path.join(dir, 'plan.json'), plan);
console.log(JSON.stringify(plan, null, 2));
