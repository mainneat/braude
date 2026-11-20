export const TAXONOMY = [
  { slug: 'button', label: 'Button' },
  { slug: 'icon-button', label: 'Icon button' },
  { slug: 'toggle', label: 'Toggle / switch' },
  { slug: 'segmented', label: 'Segmented control / tabs' },
  { slug: 'checkbox-radio', label: 'Checkbox / radio' },
  { slug: 'input', label: 'Input / search' },
  { slug: 'select', label: 'Select / dropdown' },
  { slug: 'slider', label: 'Slider' },
  { slug: 'card', label: 'Card' },
  { slug: 'chip', label: 'Chip / tag / badge' },
  { slug: 'avatar', label: 'Avatar' },
  { slug: 'icon', label: 'Icon' },
  { slug: 'navigation', label: 'Navigation' },
  { slug: 'list-item', label: 'List item / row' },
  { slug: 'overlay', label: 'Modal / sheet / popover' },
  { slug: 'toast', label: 'Toast / banner' },
  { slug: 'chart', label: 'Chart / data viz' },
  { slug: 'other', label: 'Autre' },
];
export const TYPE_SLUGS = new Set(TAXONOMY.map((t) => t.slug));

// ---------- Type automatique (candidats measureOnly, que le classifieur ne voit pas) ----------
const ROLE_TYPE = { switch: 'toggle', checkbox: 'checkbox-radio', radio: 'checkbox-radio', slider: 'slider', tab: 'segmented', tablist: 'segmented', button: 'button' };
const INPUT_TYPE = { checkbox: 'checkbox-radio', radio: 'checkbox-radio', range: 'slider', button: 'button', submit: 'button', reset: 'button' };
const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]).trim().toLowerCase() : '';
};
const stripTags = (html) => String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

// Balise ouvrante de l'élément lui-même : parmi la suite de balises ouvrantes en tête du HTML
// (coquille d'ancêtres + élément + premiers descendants), les balises du bon nom ; on préfère
// celle qui porte un rôle ou un type significatif.
function ownTag(html, tag) {
  const run = /^(?:\s*<[a-zA-Z][^>]*>)+/.exec(String(html))?.[0] ?? '';
  const tags = run.match(/<[a-zA-Z][^>]*>/g) ?? [];
  const same = tags.filter((t) => new RegExp(`^<${tag}(\\s|>|/)`, 'i').test(t));
  if (!same.length) {
    const any = new RegExp(`<${tag}(\\s[^>]*)?>`, 'i').exec(String(html));
    return any ? any[0] : '';
  }
  return same.find((t) => ROLE_TYPE[attr(t, 'role')]) ?? same[0];
}

/** Slug de taxonomie déduit de la sortie du détecteur (kind, tag, rôle, type d'input, contenu). */
export function autoType(c) {
  if (!c || typeof c !== 'object') return 'other';
  const tag = String(c.tag ?? '').toLowerCase();
  const html = String(c.html ?? '');
  switch (c.kind) {
    case 'segmented': return 'segmented';
    case 'nav': return 'navigation';
    case 'card': return 'card';
    case 'icon': return 'icon';
    case 'control': break;
    default: return tag === 'svg' ? 'icon' : 'other';
  }
  const own = tag ? ownTag(html, tag) : '';
  const role = String(c.role ?? attr(own, 'role')).toLowerCase();
  if (role === 'switch') return 'toggle';
  if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select';
  if (tag === 'textarea') return 'input';
  if (tag === 'input') {
    const type = String(c.inputType ?? attr(own, 'type') ?? '').toLowerCase() || 'text';
    return INPUT_TYPE[type] ?? 'input';
  }
  if (role && role !== 'button' && ROLE_TYPE[role]) return ROLE_TYPE[role];
  if (tag === 'svg') return 'icon';
  const text = stripTags(html);
  if (!text && /<(svg|img)\b/i.test(html)) return 'icon-button';
  return 'button';
}
