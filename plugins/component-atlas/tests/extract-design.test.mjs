import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, cpSync, existsSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from '../scripts/lib/browser.mjs';
import { extractDesign } from '../scripts/extract-design.mjs';
import { renderContactSheet } from '../scripts/extract-page.mjs';

const FX = fileURLToPath(new URL('./fixtures/design', import.meta.url));
let browser;
let res;
before(async () => { browser = await launch(); res = await extractDesign(FX, { browser }); });
after(async () => { await browser?.close(); });
const copy = () => { const d = mkdtempSync(join(tmpdir(), 'atlas-design-')); cpSync(FX, d, { recursive: true }); return d; };

test('renders every artboard through the runtime and merges candidates', () => {
  assert.equal(res.status, 'ok', res.error);
  res.candidates.forEach((c, i) => assert.equal(c.index, i));
  const pills = res.candidates.filter((c) => c.tag === 'button' && /pill/.test(c.html));
  assert.equal(pills.length, 1, 'pill deduped across artboards (c-pill + dc-import in p-home)');
  assert.equal(pills[0].text, 'Continuer', 'template holes resolved');
  assert.ok(pills[0].occurrences >= 2);
  const sw = res.candidates.filter((c) => c.role === 'switch');
  assert.equal(sw.length, 1, 'repeated switches grouped');
  assert.equal(sw[0].occurrences, 3);
  assert.ok(res.candidates.some((c) => c.kind === 'icon'));
  assert.ok(res.candidates.some((c) => c.kind === 'card'));
  assert.ok(!res.candidates.some((c) => /\{\{/.test(c.html) || /<x-dc|<sc-for|<dc-import/.test(c.html)));
});

test('context is prefixed by the artboard title from canvas.json', () => {
  const pill = res.candidates.find((c) => /pill/.test(c.html) && c.tag === 'button');
  assert.match(pill.context, /^Pill button\b/, 'components artboards come first');
  const sw = res.candidates.find((c) => c.role === 'switch');
  assert.match(sw.context, /^Accueil · /);
  assert.ok(res.candidates.every((c) => c.context.length <= 80));
});

test('shared CSS and embedded DS tokens reach the render', () => {
  const pill = res.candidates.find((c) => /pill/.test(c.html) && c.tag === 'button');
  assert.equal(pill.metrics.light.bg, '#2f6bff');
  assert.equal(pill.metrics.light.radius > 10, true);
  const card = res.candidates.find((c) => c.kind === 'card');
  assert.equal(card.metrics.light.bg, '#ffffff');
  assert.equal(card.metrics.dark.bg, '#1c1c1e');
  assert.match(res.styles.css, /\.pill/);
  assert.match(res.styles.css, /\.switch/);
  assert.match(res.styles.cssDark, /#1c1c1e/);
});

test('broken or missing artboards become warnings, others continue', () => {
  assert.ok(res.warnings.some((w) => /^Broken board : /.test(w)), res.warnings.join('\n'));
  assert.ok(res.warnings.some((w) => /Ghost/.test(w) && /introuvable/.test(w)), res.warnings.join('\n'));
});

test('candidate cap keeps component artboards first and warns', async () => {
  const r = await extractDesign(FX, { browser, maxCandidates: 1 });
  assert.equal(r.candidates.length, 1);
  assert.match(r.candidates[0].context, /^Pill button/);
  assert.ok(r.warnings.some((w) => /plafond/.test(w)));
});

test('without the runtime: static render with a warning', async () => {
  const d = copy();
  try {
    rmSync(join(d, 'artifact-type'), { recursive: true });
    const r = await extractDesign(d, { browser });
    assert.equal(r.status, 'ok', r.error);
    assert.ok(r.warnings.some((w) => /runtime/i.test(w)));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('no artboard at all is an error', async () => {
  const d = mkdtempSync(join(tmpdir(), 'atlas-design-'));
  try {
    const r = await extractDesign(d, { browser });
    assert.equal(r.status, 'error');
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('contact sheet splits into several images when too tall', async () => {
  const d = mkdtempSync(join(tmpdir(), 'atlas-sheet-'));
  try {
    const cands = Array.from({ length: 100 }, (_, i) => ({ index: i, tag: 'div', text: `t${i}`,
      html: `<div class="ca-body"><div style="height:300px;background:#${(i * 5 + 100).toString(16).padStart(3, '0')}">${i}</div></div>` }));
    const { files, sheets, blank } = await renderContactSheet(cands, { cssLight: '' }, join(d, 'contact.png'), browser);
    assert.ok(files.length >= 2, `files: ${files}`);
    assert.deepEqual(blank, []);
    assert.equal(sheets[0].from, 0);
    assert.equal(sheets.at(-1).to, 99);
    for (let i = 1; i < sheets.length; i++) assert.equal(sheets[i].from, sheets[i - 1].to + 1);
    assert.equal(files[0], join(d, 'contact.png'));
    assert.equal(files[1], join(d, 'contact-2.png'));
    for (const f of files) assert.ok(existsSync(f));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('CLI writes the same files as the other extractors', () => {
  const d = copy();
  try {
    writeFileSync(join(d, 'contact-9.png'), 'stale');
    const out = execFileSync('node', [fileURLToPath(new URL('../scripts/extract-design.mjs', import.meta.url)), d], { encoding: 'utf8' });
    const summary = JSON.parse(out);
    assert.equal(summary.status, 'ok');
    assert.ok(summary.artboards, 'artboard stats in summary');
    for (const f of ['candidates.json', 'styles.json', 'extract.json', 'contact.png']) assert.ok(existsSync(join(d, f)), f);
    assert.ok(!readdirSync(d).includes('contact-9.png'), 'stale contact sheets removed');
    assert.ok(JSON.parse(readFileSync(join(d, 'candidates.json'), 'utf8')).length >= 4);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
