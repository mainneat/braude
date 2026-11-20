// Injecté dans la page source (page.evaluate) : détection des composants, coquille
// d'ancêtres, mesures et arbre CSS. Expose window.__caDetect et __caMeasure.
// Aucun attribut n'est posé sur les éléments de la page : les éléments retenus sont
// gardés en mémoire (avec un chemin CSS de repli si le JS de la page les remplace).
(() => {
  const CONTROL = 'button, input:not([type=hidden]), select, textarea, [role=button], [role=switch], '
    + '[role=tab], [role=checkbox], [role=radio], [role=slider]';
  const BUTTONISH = 'button, [role=button], [role=tab], input[type=button], input[type=submit], input[type=reset]';
  const HEADING = 'h1, h2, h3, h4, h5, h6, legend, caption, figcaption';
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'META', 'LINK', 'TITLE', 'BR', 'WBR']);
  const INTERNAL = 'data-ca-internal';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SEG_MAX = 8;          // au-delà, c'est une grille de boutons, pas un segmented
  const ICON_MAX = 48;
  const TEXT_MAX = 120;
  const CONTEXT_MAX = 80;

  let els = [];
  let paths = [];

  // ---------- couleurs et mesures ----------
  let ctx2d = null;
  function color(c) {
    if (!c) return null;
    if (c === 'transparent' || /^rgba?\(/.test(c)) return c;
    // oklch(), color(srgb …), lab() … : on laisse le moteur convertir en sRGB via un pixel.
    if (!ctx2d) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 1;
      ctx2d = cv.getContext('2d', { willReadFrequently: true });
    }
    ctx2d.clearRect(0, 0, 1, 1);
    ctx2d.fillStyle = '#000';
    ctx2d.fillStyle = c;
    ctx2d.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx2d.getImageData(0, 0, 1, 1).data;
    return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
  }
  const alpha = (c) => {
    if (!c || c === 'transparent') return 0;
    const m = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(c);
    return m ? parseFloat(m[1]) : 1;
  };
  const num = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;

  function hasBorder(s) {
    return parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && s.borderTopStyle !== 'hidden'
      && alpha(color(s.borderTopColor)) > 0;
  }

  function measure(el) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    let radius = s.borderTopLeftRadius;
    radius = radius.endsWith('%') ? (parseFloat(radius) / 100) * Math.min(r.width, r.height) : parseFloat(radius);
    return {
      bg: color(s.backgroundColor),
      fg: color(s.color),
      border: hasBorder(s) ? color(s.borderTopColor) : null,
      radius: num(radius),
      fontFamily: s.fontFamily,
      fontSize: num(s.fontSize),
      fontWeight: parseInt(s.fontWeight, 10) || 400,
      width: Math.round(r.width),
      height: Math.round(r.height),
      paddingX: num(s.paddingLeft),
      paddingY: num(s.paddingTop),
    };
  }

  // ---------- visibilité et parcours ----------
  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    return true;
  }

  function visibleElements() {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
      acceptNode(n) {
        if (SKIP.has(n.tagName)) return NodeFilter.FILTER_REJECT;
        if (n.hasAttribute(INTERNAL)) return NodeFilter.FILTER_REJECT;
        // Seule la racine <svg> compte ; son contenu n'est jamais un composant.
        const p = n.parentElement;
        if (p && p.namespaceURI === SVG_NS) return NodeFilter.FILTER_REJECT;
        if (getComputedStyle(n).display === 'none') return NodeFilter.FILTER_REJECT;
        return visible(n) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  const insideSet = (el, set) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return true;
    return false;
  };

  // ---------- règles de détection ----------
  const bgCache = new Map();
  function effectiveBg(el) {
    if (!el) return 'rgb(255, 255, 255)';
    if (bgCache.has(el)) return bgCache.get(el);
    const own = color(getComputedStyle(el).backgroundColor);
    const v = alpha(own) > 0 ? own : (el.parentElement ? effectiveBg(el.parentElement) : 'rgb(255, 255, 255)');
    bgCache.set(el, v);
    return v;
  }

  function textDescendants(el, need) {
    let n = 0;
    for (const d of el.querySelectorAll('*')) {
      for (const t of d.childNodes) {
        if (t.nodeType === 3 && t.data.trim()) { n++; break; }
      }
      if (n >= need) return n;
    }
    return n;
  }

  function isCard(el, s) {
    const r = el.getBoundingClientRect();
    if (r.width < 120 || r.width > 720 || r.height < 60 || r.height > 720) return false;
    if (!(parseFloat(s.borderTopLeftRadius) > 0)) return false;
    const bg = color(s.backgroundColor);
    const bgDiff = alpha(bg) > 0 && bg !== effectiveBg(el.parentElement);
    const shadow = s.boxShadow && s.boxShadow !== 'none';
    if (!(bgDiff || hasBorder(s) || shadow)) return false;
    return textDescendants(el, 2) >= 2;
  }

  function isSegmented(el, visibleSet) {
    if (el.matches('[role=tablist]')) return true;
    if (el.matches(CONTROL)) return false;
    // Frères dans le flux uniquement : un indicateur absolu ou un décor sans texte ne compte pas.
    const kids = [...el.children].filter((k) => {
      if (!visibleSet.has(k)) return false;
      if (k.matches(BUTTONISH)) return true;
      const pos = getComputedStyle(k).position;
      return pos !== 'absolute' && pos !== 'fixed' && !!clean(k.textContent, 1);
    });
    const btns = kids.filter((k) => k.matches(BUTTONISH)).length;
    return btns >= 2 && btns <= SEG_MAX && btns * 2 > kids.length;
  }

  function isNav(el, s) {
    if (el.matches('nav, [role=navigation]')) return true;
    if (s.position !== 'fixed' && s.position !== 'sticky') return false;
    return el.querySelectorAll('a[href], button, [role=button]').length >= 3;
  }

  // ---------- texte, contexte, coquille ----------
  const clean = (t, max) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, max);

  function textOf(el) {
    const t = el.innerText ?? '';
    return clean(t || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder')
      || el.getAttribute('title') || el.querySelector?.('title')?.textContent || '', TEXT_MAX);
  }

  const LABEL_MAX = 40;

  function labelText(e) {
    const ids = e.getAttribute('aria-labelledby');
    if (ids) {
      const t = ids.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (clean(t, 1)) return clean(t, CONTEXT_MAX);
    }
    return clean(e.getAttribute('aria-label'), CONTEXT_MAX);
  }

  // Petite étiquette : le plus proche frère précédent porteur de texte, s'il est une feuille
  // (aucun enfant élément) de ≤ 40 caractères.
  function smallLabelOf(el) {
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) {
      if (SKIP.has(s.tagName)) continue;
      const t = clean(s.textContent, 1000);
      if (!t) continue;
      return s.children.length === 0 && t.length <= LABEL_MAX ? t : '';
    }
    return '';
  }

  function contextOf(el, headings) {
    const main = mainContextOf(el, headings);
    const small = smallLabelOf(el);
    const parts = [main, small].filter((t, i, a) => t && a.indexOf(t) === i);
    return parts.join(' · ').slice(0, CONTEXT_MAX);
  }

  function mainContextOf(el, headings) {
    const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
    // Dernier titre qui commence avant l'élément (recherche dichotomique, ordre du document).
    let lo = 0, hi = headings.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (headings[mid] !== el && (headings[mid].compareDocumentPosition(el) & FOLLOWING)) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    while (idx >= 0 && headings[idx].contains(el)) idx--;
    let h = idx >= 0 ? headings[idx] : null;
    while (h && !clean(h.textContent, 1)) { idx--; h = idx >= 0 ? headings[idx] : null; }
    let labelled = el.parentElement?.closest('[aria-label], [aria-labelledby]');
    while (labelled && !labelText(labelled)) labelled = labelled.parentElement?.closest('[aria-label], [aria-labelledby]');
    if (labelled && (!h || (h.compareDocumentPosition(labelled) & FOLLOWING))) return labelText(labelled);
    return h ? clean(h.textContent, CONTEXT_MAX) : '';
  }

  const keepAttr = (n) => n === 'id' || n === 'class' || n === 'role' || n === 'style' || n.startsWith('data-') || n.startsWith('aria-');
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  function shell(el) {
    const chain = [];
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) chain.unshift(p);
    let open = '', close = '';
    for (const p of chain) {
      const attrs = [...p.attributes].filter((a) => keepAttr(a.name)).map((a) => ` ${a.name}="${esc(a.value)}"`).join('');
      open += `<${p.localName}${attrs} data-ca-shell="">`;
      close = `</${p.localName}>` + close;
    }
    const bodyCls = typeof document.body.className === 'string' ? document.body.className : '';
    return [`<div class="${esc(clean('ca-body ' + bodyCls, 10000))}">${open}`, `${close}</div>`];
  }

  // outerHTML d'un clone : état des champs reporté en attributs, scripts retirés.
  function snapshot(el, inner = false) {
    const clone = el.cloneNode(true);
    const FORM = 'input, textarea, option';
    const src = [...(el.matches(FORM) ? [el] : []), ...el.querySelectorAll(FORM)];
    const dst = [...(clone.matches(FORM) ? [clone] : []), ...clone.querySelectorAll(FORM)];
    src.forEach((s, i) => {
      const d = dst[i];
      if (!d) return;
      if (s.localName === 'option') s.selected ? d.setAttribute('selected', '') : d.removeAttribute('selected');
      else if (s.localName === 'textarea') d.textContent = s.value;
      else if (s.type === 'checkbox' || s.type === 'radio') s.checked ? d.setAttribute('checked', '') : d.removeAttribute('checked');
      else if (s.type !== 'file' && s.type !== 'password') d.setAttribute('value', s.value);
    });
    clone.querySelectorAll(inner ? 'script, style, link' : 'script').forEach((s) => s.remove());
    // Positionné par rapport à son contexte (absolute/fixed) : hors contexte, il sortirait de la
    // tuile ; marqué pour être remis dans le flux (voir SHELL_RESET_CSS).
    if (!inner && /^(absolute|fixed)$/.test(getComputedStyle(el).position)) clone.setAttribute('data-ca-pos', '');
    return inner ? clone.innerHTML : clone.outerHTML;
  }

  function cssPath(el) {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const i = [...e.parentElement.children].indexOf(e) + 1;
      parts.unshift(`${CSS.escape(e.localName)}:nth-child(${i})`);
    }
    return parts.length ? 'body > ' + parts.join(' > ') : 'body';
  }

  // ---------- CSSOM → RuleNode[] ----------
  function walkRules(list, addLink) {
    const out = [];
    for (const r of list) {
      if (r instanceof CSSStyleRule) {
        // CSS imbriqué : non scopé (repli assumé, voir rapport Task 4).
        if (r.cssRules && r.cssRules.length) out.push({ type: 'other', cssText: r.cssText });
        else out.push({ type: 'style', selector: r.selectorText, body: r.style.cssText });
      } else if (r instanceof CSSMediaRule) {
        out.push({ type: 'media', condition: r.conditionText ?? r.media.mediaText, children: walkRules(r.cssRules, addLink) });
      } else if (r instanceof CSSSupportsRule) {
        out.push({ type: 'supports', condition: r.conditionText, children: walkRules(r.cssRules, addLink) });
      } else if (window.CSSContainerRule && r instanceof CSSContainerRule) {
        out.push({ type: 'container', condition: r.conditionText, children: walkRules(r.cssRules, addLink) });
      } else if (window.CSSLayerBlockRule && r instanceof CSSLayerBlockRule) {
        out.push({ type: 'layer', name: r.name, children: walkRules(r.cssRules, addLink) });
      } else if (r instanceof CSSImportRule) {
        let sub = null;
        try { sub = r.styleSheet && r.styleSheet.cssRules; } catch { sub = null; }
        if (!sub) { addLink(r.styleSheet?.href || r.href); continue; }
        let children = walkRules(sub, addLink);
        if (r.layerName != null) children = [{ type: 'layer', name: r.layerName, children }];
        const mq = r.media && r.media.mediaText;
        out.push(...(mq && mq !== 'all' ? [{ type: 'media', condition: mq, children }] : children));
      } else if (r instanceof CSSFontFaceRule) {
        out.push({ type: 'font-face', cssText: r.cssText });
      } else if (r instanceof CSSKeyframesRule) {
        out.push({ type: 'keyframes', cssText: r.cssText });
      } else {
        out.push({ type: 'other', cssText: r.cssText });
      }
    }
    return out;
  }

  function collectRules() {
    const fontLinks = [];
    const addLink = (href) => { if (href && !fontLinks.includes(href)) fontLinks.push(href); };
    const rules = [];
    const sheetSizes = []; // nombre de nœuds de premier niveau par feuille (découpe par feuille)
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      const owner = sheet.ownerNode;
      if (owner && owner.hasAttribute && owner.hasAttribute(INTERNAL)) continue;
      if (sheet.disabled) continue;
      let list;
      try { list = sheet.cssRules; } catch { addLink(sheet.href); continue; }
      const children = walkRules(list, addLink);
      const mq = sheet.media && sheet.media.mediaText;
      const nodes = mq && mq !== 'all' ? [{ type: 'media', condition: mq, children }] : children;
      rules.push(...nodes);
      sheetSizes.push(nodes.length);
    }
    // <link> qui n'a pas chargé (réseau) : gardé en lien.
    for (const l of document.querySelectorAll('link[rel~="stylesheet"][href]')) if (!l.sheet) addLink(l.href);
    return { rules, fontLinks, sheetSizes };
  }

  // Les transitions fausseraient la mesure juste après le passage en sombre.
  function freeze() {
    if (document.querySelector(`style[${INTERNAL}]`)) return;
    const st = document.createElement('style');
    st.setAttribute(INTERNAL, '');
    st.textContent = '*, *::before, *::after { transition: none !important; }';
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------- API ----------
  window.__caDetect = (limit, opts = {}) => {
    els = [];
    paths = [];
    bgCache.clear();
    freeze();
    const { rules, fontLinks, sheetSizes } = collectRules();
    if (!document.body) return { candidates: [], rules, fontLinks, sheetSizes };

    const all = visibleElements();
    const visibleSet = new Set(all);
    const style = new Map(all.map((e) => [e, getComputedStyle(e)]));

    const navs = new Set(all.filter((e) => isNav(e, style.get(e))));
    for (const n of [...navs]) if (insideSet(n, navs)) navs.delete(n);

    const segs = new Set(all.filter((e) => !navs.has(e) && isSegmented(e, visibleSet)));
    for (const s of [...segs]) if (insideSet(s, segs)) segs.delete(s);

    const controls = new Set(all.filter((e) => !navs.has(e) && !segs.has(e) && e.matches(CONTROL)));
    for (const c of [...controls]) if (insideSet(c, segs) || insideSet(c, controls)) controls.delete(c);

    const cards = new Set(all.filter((e) => !navs.has(e) && !segs.has(e) && !controls.has(e)
      && e.namespaceURI !== SVG_NS && isCard(e, style.get(e))));
    // On garde la carte la plus interne.
    for (const c of [...cards]) for (let p = c.parentElement; p; p = p.parentElement) cards.delete(p);

    const taken = new Set([...navs, ...segs, ...controls, ...cards]);
    const icons = new Set(all.filter((e) => {
      if (e.localName !== 'svg' || taken.has(e) || insideSet(e, taken)) return false;
      const r = e.getBoundingClientRect();
      return r.width <= ICON_MAX && r.height <= ICON_MAX;
    }));

    const kindOf = (e) => (navs.has(e) ? 'nav' : segs.has(e) ? 'segmented' : controls.has(e) ? 'control'
      : cards.has(e) ? 'card' : icons.has(e) ? 'icon' : null);
    const headings = [...document.querySelectorAll(HEADING)];
    const candidates = [];
    if (opts.wholeBody) {
      // Candidat 'ds' : tout le corps de l'aperçu ; mesuré sur son premier enfant visible.
      const first = all.find((e) => e.parentElement === document.body) || document.body;
      const [open, close] = shell(document.body);
      els.push(first);
      paths.push(cssPath(first));
      candidates.push({
        kind: 'ds',
        tag: 'div',
        text: textOf(document.body),
        context: '',
        html: open + snapshot(document.body, true) + close,
        metrics: measure(first),
      });
    }
    for (const e of all) {
      const kind = kindOf(e);
      if (!kind) continue;
      if (candidates.length >= limit) break;
      const [open, close] = shell(e);
      els.push(e);
      paths.push(cssPath(e));
      candidates.push({
        kind,
        tag: e.localName,
        text: textOf(e),
        context: contextOf(e, headings),
        html: open + snapshot(e) + close,
        shellLen: [open.length, close.length],
        metrics: measure(e),
        ...(e.getAttribute('role') ? { role: e.getAttribute('role') } : {}),
        ...(e.localName === 'input' ? { inputType: e.type } : {}),
      });
    }
    return { candidates, rules, fontLinks, sheetSizes };
  };

  window.__caMeasure = () => els.map((el, i) => {
    const e = el.isConnected ? el : document.querySelector(paths[i]);
    return e ? measure(e) : null;
  });
})();

