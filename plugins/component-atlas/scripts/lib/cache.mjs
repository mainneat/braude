import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}

export async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
}

/** Diff inventory against cache. error => always retried; ok/skipped => only if `updated` changed. */
export function planRun(inventory, cache) {
  const known = (cache && cache.artifacts) || {};
  const toProcess = [], unchanged = [];
  const seen = new Set();
  for (const { id, updated } of inventory) {
    seen.add(id);
    const c = known[id];
    if (!c || c.status === 'error' || c.updated !== updated) toProcess.push(id);
    else unchanged.push(id);
  }
  const removed = Object.keys(known).filter((id) => !seen.has(id));
  return { toProcess: toProcess.sort(), removed: removed.sort(), unchanged: unchanged.sort() };
}
