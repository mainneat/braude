const h2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

// CSS rgb()/rgba() -> '#rrggbb' or '#rrggbbaa'; null when transparent/unparseable.
export function toHex(css) {
  if (typeof css !== 'string') return null;
  const s = css.trim().toLowerCase();
  if (!s || s === 'transparent') return null;
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let v = hex[1];
    if (v.length === 3 || v.length === 4) v = [...v].map((c) => c + c).join('');
    if (v.length === 6) return '#' + v;
    if (v.length === 8) return v.slice(6) === '00' ? null : '#' + v;
    return null;
  }
  const m = s.match(/^rgba?\(\s*([^)]+)\)$/);
  if (!m) return null;
  const parts = m[1].split(/[\s,\/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const ch = parts.slice(0, 3).map((p) => (p.endsWith('%') ? parseFloat(p) * 2.55 : parseFloat(p)));
  if (ch.some(Number.isNaN)) return null;
  let a = 1;
  if (parts[3] !== undefined) {
    a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
    if (Number.isNaN(a)) return null;
  }
  if (a <= 0) return null;
  const base = '#' + ch.map(h2).join('');
  return a >= 1 ? base : base + h2(a * 255);
}

// '#rgb'|'#rrggbb'[aa] -> {h:0-360, s:0-1, l:0-1} : implémentation partagée avec la galerie.
export { hexToHsl } from '../../gallery/src/logic.mjs';
