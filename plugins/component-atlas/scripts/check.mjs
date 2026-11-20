#!/usr/bin/env node
// Vérifie Node >= 18 et que Playwright + Chromium se lancent.
import { launch } from './lib/browser.mjs';

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('Erreur : Node 18 ou plus récent est requis.');
  process.exit(1);
}
try {
  const b = await launch();
  await b.close();
  console.log('ok');
} catch (e) {
  console.error(`Erreur : Playwright ou Chromium indisponible (${String(e.message).split('\n')[0]}).\nCorrection : npm i -g playwright && npx playwright install chromium`);
  process.exit(1);
}
