import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import path from 'node:path';

const FALLBACK_EXECUTABLE = '/opt/pw-browsers/chromium';

// Playwright : d'abord relatif au plugin, puis au répertoire courant (npm i -D), puis global.
export function loadPlaywright() {
  const tries = [
    () => createRequire(import.meta.url)('playwright'),
    () => createRequire(path.join(process.cwd(), 'noop.js'))('playwright'),
    () => createRequire(path.join(execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 'noop.js'))('playwright'),
  ];
  let last;
  for (const t of tries) {
    try { return t(); } catch (e) { last = e; }
  }
  throw new Error(`Playwright introuvable (npm i -g playwright && npx playwright install chromium) : ${last?.message}`);
}

export async function launch() {
  const { chromium } = loadPlaywright();
  try {
    return await chromium.launch();
  } catch (first) {
    try {
      return await chromium.launch({ executablePath: FALLBACK_EXECUTABLE });
    } catch {
      throw first;
    }
  }
}
