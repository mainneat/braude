import test from 'node:test';
import assert from 'node:assert/strict';
import { scopeSelector, serializeScoped } from '../scripts/lib/css.mjs';
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
