import { TYPE_SLUGS } from './taxonomy.mjs';

// Returns a list of error strings; empty = valid.
export function validateClassified(data, candidateCount) {
  const errors = [];
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
  return errors;
}
