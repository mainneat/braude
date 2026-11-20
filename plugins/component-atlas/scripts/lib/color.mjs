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

// '#rgb'|'#rrggbb'[aa] -> {h:0-360, s:0-1, l:0-1}
export function hexToHsl(hex) {
  let v = String(hex).replace('#', '');
  if (v.length === 3 || v.length === 4) v = [...v].map((c) => c + c).join('');
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}
