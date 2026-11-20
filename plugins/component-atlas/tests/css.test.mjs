import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeSelector, serializeScoped, SHELL_RESET_CSS } from '../scripts/lib/css.mjs';
import { tokensToCss } from '../scripts/lib/tokens.mjs';

test('scopeSelector', () => {
  assert.equal(scopeSelector(':root'), ':host');
  assert.equal(scopeSelector('html'), ':host');
  assert.equal(scopeSelector('body'), '.ca-body');
  assert.equal(scopeSelector('body > .wrap, .x'), '.ca-body > .wrap, .x');
  assert.equal(scopeSelector(':root[data-theme="dark"]'), ':host([data-theme="dark"])');
  assert.equal(scopeSelector(':root:not([data-theme="light"])'), ':host(:not([data-theme="light"]))');
  assert.equal(scopeSelector('html body .x'), ':host .ca-body .x');
  assert.equal(scopeSelector('.body-text, a[href*="body"]'), '.body-text, a[href*="body"]');
  assert.equal(scopeSelector('*'), '*');
});
test('serializeScoped separates font-face and keeps media', () => {
  const out = serializeScoped([
    { type:'font-face', cssText:'@font-face{font-family:X;src:url(data:font/woff2;base64,AA)}' },
    { type:'media', condition:'(prefers-color-scheme: dark)', children:[{ type:'style', selector:':root:not([data-theme="light"])', body:'--bg:#000' }] },
  ]);
  assert.match(out.fontFaceCss, /font-family:X/);
  assert.match(out.css, /@media \(prefers-color-scheme: dark\)\{:host\(:not\(\[data-theme="light"\]\)\)\{--bg:#000\}\}/);
  assert.doesNotMatch(out.css, /font-face/);
});
test('serializeScoped nested font-face and keyframes', () => {
  const out = serializeScoped([
    { type:'supports', condition:'(display:grid)', children:[{ type:'font-face', cssText:'@font-face{font-family:Y}' }, { type:'keyframes', cssText:'@keyframes k{from{opacity:0}}' }] },
  ]);
  assert.match(out.fontFaceCss, /font-family:Y/);
  assert.match(out.css, /@keyframes k/);
  assert.doesNotMatch(out.css, /font-face/);
});
test('tokensToCss', () => {
  const css = tokensToCss({ color:{ themes:[{id:'light'},{id:'dark'}], tokens:[{ name:'ink', value:{ light:'#111', dark:'#eee' } }] },
    spacing:{ tokens:[{ name:'space-4', value:'16px' }] } });
  assert.match(css, /:root\{[^}]*--ink:#111/);
  assert.match(css, /--space-4:16px/);
  assert.match(css, /\[data-theme="dark"\]\{[^}]*--ink:#eee/);
  assert.match(css, /prefers-color-scheme: dark/);
});
test('tokensToCss aliases, plain strings, ignored type', () => {
  const css = tokensToCss({ type:{ tokens:[{ name:'font-x', value:'Foo' }] },
    color:{ themes:[{id:'light'},{id:'dark'}], tokens:[
      { name:'a', value:'#fff' }, { name:'b', value:{ light:'{a}', dark:'#000' } }, { name:'c', value:{ light:'#abc' } } ] } });
  assert.doesNotMatch(css, /font-x/);
  assert.match(css, /--b:var\(--a\)/);
  assert.match(css, /--c:#abc/);
  const dark = css.match(/\[data-theme="dark"\]\{([^}]*)\}/)[1];
  assert.match(dark, /--b:#000/);
  assert.doesNotMatch(dark, /--c:/);
});
test('scopeSelector pseudo-elements', () => {
  assert.equal(scopeSelector(':root::before'), ':host::before');
  assert.equal(scopeSelector('html.dark::after'), ':host(.dark)::after');
  assert.equal(scopeSelector(':root:before'), ':host:before');
  assert.equal(scopeSelector('body::before'), '.ca-body::before');
  assert.equal(scopeSelector(':root[data-x="::a"]'), ':host([data-x="::a"])');
});
test('scopeSelector functional pseudo-classes', () => {
  assert.equal(scopeSelector(':is(html) .x'), ':is(:host) .x');
  assert.equal(scopeSelector(':where(body) .x'), ':where(.ca-body) .x');
  assert.equal(scopeSelector('div:not(body)'), 'div:not(.ca-body)');
  assert.equal(scopeSelector('a:is(:root, body)'), 'a:is(:host, .ca-body)');
  assert.equal(scopeSelector('.x:has(> body)'), '.x:has(> .ca-body)');
  assert.equal(scopeSelector(':root:not([data-theme="light"])'), ':host(:not([data-theme="light"]))');
  assert.equal(scopeSelector('body\\:x'), 'body\\:x');
});
test('serializeScoped walks @layer and @container', () => {
  const out = serializeScoped([
    { type:'layer', name:'base', children:[{ type:'style', selector:'body', body:'margin:0' }] },
    { type:'layer', name:'', children:[{ type:'style', selector:':root', body:'--a:1' }] },
    { type:'container', condition:'card (min-width: 300px)', children:[{ type:'style', selector:'html .x', body:'color:red' }] },
  ]);
  assert.equal(out.css, '@layer base{.ca-body{margin:0}}@layer{:host{--a:1}}@container card (min-width: 300px){:host .x{color:red}}' + SHELL_RESET_CSS);
  assert.ok(!serializeScoped([], { shellReset: false }).css.includes('data-ca-shell'));
});
test('forceSchemeCondition', async () => {
  const { forceSchemeCondition: f } = await import('../scripts/lib/css.mjs');
  assert.equal(f('(prefers-color-scheme: dark)', 'dark'), '');
  assert.equal(f('(prefers-color-scheme: dark)', 'light'), null);
  assert.equal(f('(min-width:600px) and (prefers-color-scheme: dark)', 'dark'), '(min-width:600px)');
  assert.equal(f('screen and (prefers-color-scheme: light)', 'dark'), null);
  assert.equal(f('(prefers-color-scheme: dark), print', 'light'), 'print');
  assert.equal(f('(prefers-color-scheme: dark), print', 'dark'), '');
  assert.equal(f('not all and (prefers-color-scheme: dark)', 'dark'), 'not all and (prefers-color-scheme: dark)');
  assert.equal(f('(prefers-color-scheme: dark) or (min-width: 1px)', 'light'), '(prefers-color-scheme: dark) or (min-width: 1px)');
  assert.equal(f('(min-width: 600px)', 'dark'), '(min-width: 600px)');
});
test('serializeScoped scheme forcing', () => {
  const rules = [
    { type:'style', selector:':root', body:'--bg:#fff' },
    { type:'media', condition:'(prefers-color-scheme: dark)', children:[{ type:'style', selector:':root', body:'--bg:#000' }] },
    { type:'media', condition:'(prefers-color-scheme: light) and (min-width: 600px)', children:[{ type:'style', selector:'.x', body:'color:red' }] },
    { type:'media', condition:'(min-width: 900px)', children:[{ type:'style', selector:'.y', body:'color:blue' }] },
  ];
  assert.equal(serializeScoped(rules, { scheme:'dark' }).css, ':host{--bg:#fff}:host{--bg:#000}@media (min-width: 900px){.y{color:blue}}' + SHELL_RESET_CSS);
  assert.equal(serializeScoped(rules, { scheme:'light' }).css, ':host{--bg:#fff}@media (min-width: 600px){.x{color:red}}@media (min-width: 900px){.y{color:blue}}' + SHELL_RESET_CSS);
  assert.ok(serializeScoped(rules).css.endsWith(SHELL_RESET_CSS), 'shell reset appended to every variant');
  assert.match(serializeScoped(rules).css, /@media \(prefers-color-scheme: dark\)/);
});
