import test from 'node:test';
import assert from 'node:assert/strict';
import { toHex, hexToHsl } from '../scripts/lib/color.mjs';
import { componentKey } from '../scripts/lib/hash.mjs';
import { validateClassified } from '../scripts/lib/schema.mjs';
import { TAXONOMY, TYPE_SLUGS } from '../scripts/lib/taxonomy.mjs';

test('toHex', () => {
  assert.equal(toHex('rgb(61, 127, 230)'), '#3d7fe6');
  assert.equal(toHex('rgba(17, 18, 20, 0.5)'), '#11121480');
  assert.equal(toHex('rgba(0, 0, 0, 0)'), null);
  assert.equal(toHex('transparent'), null);
});
test('hexToHsl', () => { const c = hexToHsl('#ff0000'); assert.equal(c.h, 0); assert.equal(c.s, 1); assert.equal(c.l, 0.5); });
test('componentKey ignores whitespace and ids', () => {
  const m = { bg:'#fff', radius:8 };
  assert.equal(componentKey('<b id="x">A</b>\n  ', m), componentKey('<b>A</b>', m));
  assert.notEqual(componentKey('<b>A</b>', m), componentKey('<b>A</b>', { ...m, radius:9 }));
  assert.match(componentKey('<b>A</b>', m), /^[0-9a-f]{40}$/);
  assert.equal(componentKey('<b>A</b>', { radius:8, bg:'#fff' }), componentKey('<b>A</b>', m));
});
test('validateClassified', () => {
  assert.deepEqual(validateClassified({ project:'Nimb', items:[{ index:0, keep:true, type:'toggle', name:'Glass pill' }] }, 1), []);
  assert.ok(validateClassified({ project:'', items:[] }, 0).length > 0);
  assert.ok(validateClassified({ project:'N', items:[{ index:3, keep:true, type:'toggle', name:'x' }] }, 2).length > 0);
  assert.ok(validateClassified({ project:'N', items:[{ index:0, keep:true, type:'switch', name:'x' }] }, 1).length > 0);
  assert.ok(validateClassified({ project:'N', items:[{ index:0, keep:true, type:'toggle', name:'' }] }, 1).length > 0);
  assert.ok(validateClassified(null, 1).length > 0);
});
test('taxonomy order', () => {
  assert.equal(TAXONOMY[0].slug, 'button');
  assert.equal(TAXONOMY.at(-1).slug, 'other');
  assert.equal(TAXONOMY.length, 18);
  assert.equal(TYPE_SLUGS.size, 18);
});
