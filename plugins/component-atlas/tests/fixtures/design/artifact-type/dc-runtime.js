/* Runtime synthétique pour les tests (remplace dc-runtime.js du type Design, servi comme ./support.js).
   Sous-ensemble du format .dc.html : <x-dc>, <helmet>, {{trous}}, <sc-for>, <sc-if>, <dc-import>,
   class Component extends DCLogic { renderVals() }, data-props (valeurs par défaut). */
(() => {
  const hide = document.createElement('style');
  hide.textContent = 'x-dc{display:none!important}';
  document.head.appendChild(hide);
  class DCLogic { constructor(props) { this.props = props || {}; this.state = {}; } setState(s) { Object.assign(this.state, s); } }
  window.DCLogic = DCLogic;
  const get = (scope, path) => String(path).trim().split('.').reduce((o, k) => (o == null ? undefined : o[k]), scope);
  const fill = (s, scope) => s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, p) => { const v = get(scope, p); return v == null ? '' : String(v); });
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  function parse(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tpl = doc.querySelector('x-dc');
    const sc = doc.querySelector('script[data-dc-script]');
    let props = {};
    try { props = JSON.parse(sc?.getAttribute('data-props') || '{}'); } catch {}
    const defaults = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v && v.default]));
    let Comp = null;
    if (sc) Comp = new Function('DCLogic', sc.textContent + '\nreturn Component;')(DCLogic);
    return { tpl, Comp, defaults };
  }

  async function renderInto(host, parsed, props) {
    const { tpl, Comp, defaults } = parsed;
    const vals = Comp ? new Comp({ ...defaults, ...props }).renderVals() : { ...defaults, ...props };
    const frag = tpl.cloneNode(true);
    for (const h of frag.querySelectorAll('helmet')) { for (const s of h.children) document.head.appendChild(s.cloneNode(true)); h.remove(); }
    await walk(frag, vals);
    host.append(...frag.childNodes);
  }

  async function walk(node, scope) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) { child.data = fill(child.data, scope); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.localName;
      if (tag === 'sc-for') {
        const list = get(scope, child.getAttribute('list').replace(/[{}\s]/g, '')) || [];
        const as = child.getAttribute('as') || 'item';
        const out = [];
        for (let i = 0; i < list.length; i++) {
          const c = child.cloneNode(true);
          await walk(c, { ...scope, [as]: list[i], $index: i });
          out.push(...c.childNodes);
        }
        child.replaceWith(...out);
      } else if (tag === 'sc-if') {
        const v = get(scope, child.getAttribute('value').replace(/[{}\s]/g, ''));
        if (v) { await walk(child, scope); child.replaceWith(...child.childNodes); } else child.remove();
      } else if (tag === 'dc-import') {
        const name = child.getAttribute('name');
        const props = {};
        for (const a of child.attributes) if (a.name !== 'name' && !a.name.startsWith('hint-')) props[camel(a.name)] = fill(a.value, scope);
        const res = await fetch('./' + encodeURIComponent(name) + '.dc.html');
        const box = document.createElement('div');
        box.style.display = 'contents';
        if (res.ok) await renderInto(box, parse(await res.text()), props);
        child.replaceWith(box);
      } else {
        for (const a of [...child.attributes]) if (a.value.includes('{{')) child.setAttribute(a.name, fill(a.value, scope));
        await walk(child, scope);
      }
    }
  }

  async function boot() {
    const x = document.querySelector('x-dc');
    if (!x) return;
    const parsed = parse(document.documentElement.outerHTML);
    const root = document.createElement('div');
    root.id = 'dc-root';
    await renderInto(root, parsed, {});
    x.replaceWith(root);
  }
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
