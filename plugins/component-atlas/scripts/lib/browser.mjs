import { createRequire } from 'node:module';

const FALLBACK_EXECUTABLE = '/opt/pw-browsers/chromium';

// Playwright est une dépendance pair (installée globalement) : chargée via createRequire.
export async function launch() {
  let chromium;
  try {
    ({ chromium } = createRequire(import.meta.url)('playwright'));
  } catch (e) {
    throw new Error(`Playwright introuvable (npm i -g playwright) : ${e.message}`);
  }
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
