// tokens.json (type Design System) → CSS custom properties.

const resolve = (v) => {
  const m = /^\{([^{}]+)\}$/.exec(String(v).trim());
  return m ? `var(--${m[1]})` : String(v);
};
const decl = (name, v) => `--${name}:${resolve(v)}`;
const block = (sel, decls) => (decls.length ? `${sel}{${decls.join(';')}}` : '');

export function tokensToCss(tokens) {
  const root = [];
  const themed = []; // [{id, decls}] pour les thèmes suivants
  const color = tokens?.color;
  const themes = (color?.themes ?? []).map((t) => t.id);
  const first = themes[0];

  for (const t of color?.tokens ?? []) {
    const v = t.value;
    if (v && typeof v === 'object') {
      const base = first in v ? v[first] : Object.values(v)[0];
      if (base !== undefined) root.push(decl(t.name, base));
    } else if (v !== undefined) root.push(decl(t.name, v));
  }
  for (const id of themes.slice(1)) {
    const decls = [];
    for (const t of color.tokens ?? []) {
      if (t.value && typeof t.value === 'object' && id in t.value) decls.push(decl(t.name, t.value[id]));
    }
    themed.push({ id, decls });
  }

  for (const [family, def] of Object.entries(tokens ?? {})) {
    if (family === 'color' || family === 'type') continue;
    for (const t of def?.tokens ?? []) {
      const v = t.value && typeof t.value === 'object' ? Object.values(t.value)[0] : t.value;
      if (v !== undefined) root.push(decl(t.name, v));
    }
  }

  let css = block(':root', root);
  for (const { id, decls } of themed) {
    css += block(`[data-theme="${id}"]`, decls);
    if (id === 'dark' && decls.length) {
      css += `@media (prefers-color-scheme: dark){${block(':root:not([data-theme="light"])', decls)}}`;
    }
  }
  return css;
}
