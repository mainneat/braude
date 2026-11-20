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

function scopeCompound(comp) {
  const m = /^(html|:root|body)(?![\w-])/.exec(comp);
  if (!m) return comp;
  const rest = comp.slice(m[1].length);
  if (m[1] === 'body') return '.ca-body' + rest;
  return rest ? `:host(${rest})` : ':host';
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

export function serializeScoped(rules) {
  let css = '';
  let fontFaceCss = '';
  const walk = (list) => {
    let out = '';
    for (const r of list) {
      if (r.type === 'style') out += `${scopeSelector(r.selector)}{${r.body}}`;
      else if (r.type === 'media' || r.type === 'supports') {
        const inner = walk(r.children);
        if (inner) out += `@${r.type} ${r.condition}{${inner}}`;
      } else if (r.type === 'font-face') fontFaceCss += r.cssText;
      else out += r.cssText;
    }
    return out;
  };
  css = walk(rules);
  return { css, fontFaceCss };
}
