import { TYPE_SLUGS } from './taxonomy.mjs';

// Returns a list of error strings; empty = valid.
// `candidates` : tableau de candidats (un item exigé pour chaque candidat non measureOnly ;
// un item sur un measureOnly est toléré et ignoré au build) ou, rétrocompatible, un nombre
// (bornes seulement).
export function validateClassified(data, candidates) {
  const errors = [];
  const list = Array.isArray(candidates) ? candidates : null;
  const candidateCount = list ? list.length : Number(candidates) || 0;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['classified: objet attendu'];
  if (typeof data.project !== 'string' || !data.project.trim()) errors.push('project: chaîne non vide requise');
  if (!Array.isArray(data.items)) { errors.push('items: tableau requis'); return errors; }
  data.items.forEach((it, i) => {
    const p = `items[${i}]`;
    if (!it || typeof it !== 'object') { errors.push(`${p}: objet attendu`); return; }
    if (!Number.isInteger(it.index) || it.index < 0 || it.index >= candidateCount) errors.push(`${p}.index: hors bornes (0..${candidateCount - 1})`);
    if (typeof it.keep !== 'boolean') errors.push(`${p}.keep: booléen requis`);
    if (!TYPE_SLUGS.has(it.type)) errors.push(`${p}.type: type inconnu "${it.type}"`);
    if (it.keep === true && (typeof it.name !== 'string' || !it.name.trim())) errors.push(`${p}.name: nom requis quand keep=true`);
  });
  if (list) {
    const seen = new Set();
    for (const it of data.items) {
      if (!it || !Number.isInteger(it.index)) continue;
      if (seen.has(it.index)) errors.push(`items: index ${it.index} en double`);
      seen.add(it.index);
    }
    const missing = list.map((c, i) => (Number.isInteger(c?.index) ? c.index : i))
      .filter((idx, i) => !list[i]?.measureOnly && !seen.has(idx));
    if (missing.length) errors.push(`items: classification manquante pour ${missing.length} candidat(s) non measureOnly (index ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''})`);
  }
  return errors;
}
