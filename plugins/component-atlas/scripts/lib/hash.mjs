import { createHash } from 'node:crypto';

function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])]));
  }
  return v;
}

// Deterministic key: html normalized (id attributes dropped, whitespace collapsed) + sorted-key metrics.
export function componentKey(html, metrics) {
  const norm = String(html).replace(/\s+id=("[^"]*"|'[^']*')/g, '').replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(norm + '\u0000' + JSON.stringify(stable(metrics ?? {}))).digest('hex');
}
