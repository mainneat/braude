// Réécriture CSS pour Shadow DOM : :root/html → :host, body → .ca-body.

function splitTop(str, sepTest) {
  // Découpe `str` aux caractères satisfaisant sepTest, hors (), [] et guillemets.
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += str[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    if (depth === 0 && sepTest(c)) { parts.push(cur); cur = ''; parts.push(c); continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

const IDENT_CONT = /[\w-]/;

const FUNCTIONAL = /^:(is|where|not|has)\(/;
const PSEUDO_EL = /^(::|:(before|after|first-line|first-letter)(?![\w-]))/;

// Réécrit récursivement les arguments de :is()/:where()/:not()/:has().
// Limite assumée : à l'intérieur, html/:root deviennent `:host` même si ce
// n'est pas valide dans toutes les positions (le résultat peut ne rien matcher).
function scopeFunctional(comp) {
  let out = '', depth = 0, quote = null;
  for (let i = 0; i < comp.length; i++) {
    const c = comp[i];
    if (quote) {
      out += c;
      if (c === '\\') out += comp[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '\\') { out += c + (comp[++i] ?? ''); continue; }
    if (c === '[') depth++;
    else if (c === ']') depth--;
    const m = depth === 0 && c === ':' ? FUNCTIONAL.exec(comp.slice(i)) : null;
    if (m) {
      const start = i + m[0].length;
      let d = 1, j = start, q = null;
      for (; j < comp.length && d > 0; j++) {
        const ch = comp[j];
        if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue; }
        if (ch === '"' || ch === "'") q = ch;
        else if (ch === '\\') j++;
        else if (ch === '(') d++;
        else if (ch === ')') d--;
      }
      const inner = comp.slice(start, d === 0 ? j - 1 : j);
      out += m[0] + scopeSelector(inner) + (d === 0 ? ')' : '');
      i = j - 1;
      continue;
    }
    out += c;
  }
  return out;
}

function splitPseudoElement(rest) {
  let depth = 0, quote = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ':' && depth === 0 && PSEUDO_EL.test(rest.slice(i))) return [rest.slice(0, i), rest.slice(i)];
  }
  return [rest, ''];
}

function scopeCompound(comp) {
  comp = scopeFunctional(comp);
  const m = /^(html|:root|body)(?![\w\\-])/.exec(comp);
  if (!m) return comp;
  const rest = comp.slice(m[1].length);
  if (m[1] === 'body') return '.ca-body' + rest;
  const [pre, pseudo] = splitPseudoElement(rest);
  return (pre ? `:host(${pre})` : ':host') + pseudo;
}

export function scopeSelector(sel) {
  const groups = splitTop(sel, (c) => c === ',');
  let out = '';
  for (const g of groups) {
    if (g === ',') { out += ','; continue; }
    // Dans un groupe : sépare combinateurs (espaces, >, +, ~) et composés.
    const toks = splitTop(g, (c) => /[\s>+~]/.test(c));
    out += toks.map((t) => (t.length === 1 && /[\s>+~]/.test(t) ? t : scopeLeading(t))).join('');
  }
  return out;
}

function scopeLeading(t) {
  // Conserve les espaces de tête (autour des virgules) hors du composé.
  const lead = /^\s*/.exec(t)[0];
  return lead + scopeCompound(t.slice(lead.length));
}

const PCS_TERM = /^\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)$/i;

// Force un thème dans une condition @media. Renvoie la condition réécrite,
// '' (toujours vraie : déballer le bloc) ou null (jamais vraie : supprimer le bloc).
// Gère les listes à virgules et les conjonctions `and` ; toute autre forme
// impliquant prefers-color-scheme (not, or, sans valeur) est laissée telle quelle.
export function forceSchemeCondition(cond, scheme) {
  if (!/prefers-color-scheme/i.test(cond)) return cond;
  const parts = splitTop(cond, (c) => c === ',').filter((x) => x !== ',').map((x) => x.trim());
  if (parts.length > 1) {
    const out = [];
    for (const part of parts) {
      const r = forceSchemeCondition(part, scheme);
      if (r === '') return '';
      if (r !== null) out.push(r);
    }
    return out.length ? out.join(', ') : null;
  }
  const part = parts[0];
  if (/^\s*not\b/i.test(part)) return part;
  const terms = part.split(/\s+and\s+(?![^(]*\))/i).map((t) => t.trim());
  const kept = [];
  for (const t of terms) {
    const m = PCS_TERM.exec(t);
    if (m) { if (m[1].toLowerCase() !== scheme) return null; continue; }
    if (/prefers-color-scheme/i.test(t)) return part; // forme non gérée : intacte
    kept.push(t);
  }
  return kept.join(' and ');
}

// Ancêtres de la coquille (data-ca-shell, posé par detect.js) : on neutralise la MISE EN PAGE
// (grilles d'application, positions, tailles, marges) mais on garde la PEINTURE (fond, couleur,
// police, bordure) : le composant s'affiche dans la tuile au lieu d'y rejouer toute l'app.
// La racine .ca-body et l'élément lui-même ne sont pas concernés.
export const SHELL_RESET_CSS = '[data-ca-shell]{display:block!important;position:static!important;inset:auto!important;'
  + 'float:none!important;width:auto!important;height:auto!important;min-width:0!important;min-height:0!important;'
  + 'max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;transform:none!important;'
  + 'overflow:visible!important;grid-area:auto!important}'
  // Élément positionné (absolute/fixed) par rapport à un ancêtre neutralisé : remis dans le flux.
  + '[data-ca-pos]{position:relative!important;inset:auto!important;margin:0!important}'
  + '.ca-body{position:relative}';

// Séparateur de morceaux (une feuille source par morceau) dans un CSS de groupe de styles :
// build.mjs découpe dessus pour dédoublonner les feuilles communes entre groupes.
export const CSS_CHUNK_SEP = '\n/*ca:chunk*/\n';

// RuleNode = {type:'style',selector,body} | {type:'media'|'supports'|'container',condition,children}
//          | {type:'layer',name,children} | {type:'font-face',cssText} | {type:'keyframes'|'other',cssText}
// opts.scheme : 'auto' (défaut, media intactes) | 'light' | 'dark' (prefers-color-scheme résolu).
// opts.shellReset (défaut true) : ajoute SHELL_RESET_CSS à la fin.
export function serializeScoped(rules, { scheme = 'auto', shellReset = true } = {}) {
  let css = '';
  let fontFaceCss = '';
  const walk = (list) => {
    let out = '';
    for (const r of list) {
      if (r.type === 'style') out += `${scopeSelector(r.selector)}{${r.body}}`;
      else if (r.type === 'media' && scheme !== 'auto') {
        const cond = forceSchemeCondition(r.condition, scheme);
        if (cond === null) continue;
        const inner = walk(r.children);
        if (inner) out += cond === '' ? inner : `@media ${cond}{${inner}}`;
      } else if (r.type === 'media' || r.type === 'supports' || r.type === 'container') {
        const inner = walk(r.children);
        if (inner) out += `@${r.type} ${r.condition}{${inner}}`;
      } else if (r.type === 'layer') {
        // Même vide, un bloc @layer nommé fixe l'ordre des couches : on le garde.
        const inner = walk(r.children);
        if (inner || r.name) out += `@layer${r.name ? ' ' + r.name : ''}{${inner}}`;
      } else if (r.type === 'font-face') fontFaceCss += r.cssText;
      else out += r.cssText;
    }
    return out;
  };
  css = walk(rules) + (shellReset ? SHELL_RESET_CSS : '');
  return { css, fontFaceCss };
}
