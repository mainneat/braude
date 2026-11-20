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

// RuleNode = {type:'style',selector,body} | {type:'media'|'supports'|'container',condition,children}
//          | {type:'layer',name,children} | {type:'font-face',cssText} | {type:'keyframes'|'other',cssText}
export function serializeScoped(rules) {
  let css = '';
  let fontFaceCss = '';
  const walk = (list) => {
    let out = '';
    for (const r of list) {
      if (r.type === 'style') out += `${scopeSelector(r.selector)}{${r.body}}`;
      else if (r.type === 'media' || r.type === 'supports' || r.type === 'container') {
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
  css = walk(rules);
  return { css, fontFaceCss };
}
