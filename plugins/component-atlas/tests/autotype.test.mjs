import test from 'node:test';
import assert from 'node:assert/strict';
import { autoType } from '../scripts/lib/taxonomy.mjs';
import { validateClassified } from '../scripts/lib/schema.mjs';

const shell = (inner) => `<div class="ca-body"><div id="dc-root"><div class="cmp">${inner}</div></div></div>`;
const C = (kind, tag, inner, extra = {}) => ({ kind, tag, html: shell(inner), text: '', ...extra });

test('autoType maps detector output to taxonomy slugs', () => {
  assert.equal(autoType(C('control', 'button', '<button class="btn">Go</button>')), 'button');
  assert.equal(autoType(C('control', 'input', '<input type="text" value="x">')), 'input');
  assert.equal(autoType(C('control', 'input', '<input value="x">')), 'input');
  assert.equal(autoType(C('control', 'input', '<input type="search">')), 'input');
  assert.equal(autoType(C('control', 'textarea', '<textarea>a</textarea>')), 'input');
  assert.equal(autoType(C('control', 'button', '<button role="switch" aria-checked="true"><i></i></button>')), 'toggle');
  assert.equal(autoType(C('control', 'div', '<div role="switch"><div class="k"></div></div>')), 'toggle');
  assert.equal(autoType(C('control', 'input', '<input type="checkbox" role="switch">')), 'toggle');
  assert.equal(autoType(C('control', 'input', '<input type="checkbox">')), 'checkbox-radio');
  assert.equal(autoType(C('control', 'input', '<input type="radio">')), 'checkbox-radio');
  assert.equal(autoType(C('control', 'input', '<input type="range">')), 'slider');
  assert.equal(autoType(C('control', 'select', '<select><option>a</option></select>')), 'select');
  assert.equal(autoType(C('segmented', 'div', '<div role="tablist"><button>A</button><button>B</button></div>')), 'segmented');
  assert.equal(autoType(C('icon', 'svg', '<svg viewBox="0 0 24 24"><path d="M0"></path></svg>')), 'icon');
  assert.equal(autoType(C('card', 'div', '<div class="card"><b>A</b><p>B</p></div>')), 'card');
  assert.equal(autoType(C('nav', 'nav', '<nav><a href="#">A</a></nav>')), 'navigation');
  assert.equal(autoType(C('control', 'button', '<button aria-label="Fermer"><svg viewBox="0 0 24 24"><path d="M0"></path></svg></button>')), 'icon-button');
  assert.equal(autoType(C('ds', 'div', '<div>whatever</div>')), 'other');
  assert.equal(autoType({}), 'other');
  assert.equal(autoType(null), 'other');
});

test('autoType does not take an ancestor role for the element', () => {
  const c = { kind: 'control', tag: 'button', html: '<div class="ca-body"><div role="switch"><button class="b">Go</button></div></div>', text: 'Go' };
  assert.equal(autoType(c), 'button');
});

const cands = [{ index: 0 }, { index: 1, measureOnly: true }, { index: 2 }];
const item = (index, extra = {}) => ({ index, keep: true, type: 'button', name: 'B', ...extra });

test('validateClassified with candidates requires items only for non-measureOnly candidates', () => {
  assert.deepEqual(validateClassified({ project: 'P', items: [item(0), item(2)] }, cands), []);
  const errs = validateClassified({ project: 'P', items: [item(0)] }, cands);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /2/);
  // Un item sur un measureOnly est toléré (ignoré au build).
  assert.deepEqual(validateClassified({ project: 'P', items: [item(0), item(1), item(2)] }, cands), []);
  assert.ok(validateClassified({ project: 'P', items: [item(0), item(2), item(3)] }, cands).some((e) => /hors bornes/.test(e)));
  assert.ok(validateClassified({ project: 'P', items: [item(0), item(2), item(2)] }, cands).some((e) => /double/.test(e)));
});

test('validateClassified keeps accepting a numeric count (bounds only)', () => {
  assert.deepEqual(validateClassified({ project: 'P', items: [item(0)] }, 3), []);
  assert.ok(validateClassified({ project: 'P', items: [item(5)] }, 3).length > 0);
});
