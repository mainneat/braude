import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { launch } from '../scripts/lib/browser.mjs';
import { extractPage, renderContactSheet } from '../scripts/extract-page.mjs';
import { toHex } from '../scripts/lib/color.mjs';

const fx = (name) => fileURLToPath(new URL(`./fixtures/pages/${name}`, import.meta.url));
let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });
const run = (name, opts = {}) => extractPage(fx(name), { browser, ...opts });

// Rend le html d'un candidat dans un shadow root (CSS scopé adopté) sur une page vierge,
// thème forcé, et renvoie la couleur de fond calculée du premier élément `sel`.
// css : feuille adoptée ; media : thème émulé de la page ; theme : data-theme de l'hôte (null = aucun).
async function renderedBg({ css, fontFaceCss }, html, media, sel, theme = media) {
  const page = await browser.newPage();
  try {
    await page.emulateMedia({ colorScheme: media });
    await page.setContent('<!doctype html><html><head></head><body><div id="host"></div></body></html>');
    return await page.evaluate(({ css, fontFaceCss, html, theme, sel }) => {
      const st = document.createElement('style');
      st.textContent = fontFaceCss;
      document.head.appendChild(st);
      const host = document.getElementById('host');
      if (theme) host.setAttribute('data-theme', theme);
      const root = host.attachShadow({ mode: 'open' });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
      root.innerHTML = html;
      return getComputedStyle(root.querySelector(sel)).backgroundColor;
    }, { css, fontFaceCss, html, theme, sel });
  } finally { await page.close(); }
}

test('basic page yields typed candidates', async () => {
  const r = await run('basic.html');
  assert.equal(r.status, 'ok', r.error);
  assert.deepEqual(r.warnings, []);
  assert.equal(typeof r.styles.cssLight, 'string');
  assert.equal(typeof r.styles.cssDark, 'string');
  const kinds = r.candidates.map((c) => c.kind);
  for (const k of ['control', 'card', 'icon', 'nav']) assert.ok(kinds.includes(k), k);
  assert.equal(r.candidates.filter((c) => c.kind === 'icon').length, 3);
  assert.ok(r.candidates.some((c) => c.kind === 'control' && c.html.includes('role="switch"')));
  assert.equal(r.candidates.filter((c) => c.tag === 'button').length, 2, 'hidden button ignored');
  r.candidates.forEach((c, i) => assert.equal(c.index, i));
  for (const c of r.candidates) assert.doesNotMatch(c.html, /data-ca-internal/);
  const save = r.candidates.find((c) => c.text === 'Enregistrer');
  assert.equal(save.context, 'Actions');
  assert.equal(save.occurrences, 1);
  assert.equal(save.metrics.light.bg, '#2f6bff');
  assert.equal(save.metrics.light.radius, 8);
  assert.ok(save.colors.includes('#2f6bff'));
  assert.match(save.html, /^<div class="ca-body page"><main data-ca-shell=""><div class="actions" data-ca-shell=""><button class="btn">Enregistrer<\/button><\/div><\/main><\/div>$/);
  const card = r.candidates.find((c) => c.kind === 'card');
  assert.match(card.html, /Titre de carte/);
});

test('font-face rules go to fontFaceCss', async () => {
  const r = await run('basic.html');
  assert.match(r.styles.fontFaceCss, /AtlasTest/);
  assert.doesNotMatch(r.styles.css, /@font-face/);
  assert.match(r.styles.css, /:host\{[^}]*--accent/);
  assert.match(r.styles.css, /\.ca-body\{/);
  assert.ok(Array.isArray(r.styles.fontLinks));
});

test('JS-generated segmented control is captured with ancestor shell', async () => {
  const r = await run('js-generated.html');
  const seg = r.candidates.find((c) => c.kind === 'segmented');
  assert.ok(seg);
  assert.match(seg.html, /class="ca-body/);
  assert.match(seg.html, /^<div class="ca-body"><section aria-labelledby="v1" data-ca-shell=""><div class="demo" id="root" data-ca-shell=""><div class="seg">/);
  assert.equal(seg.context, 'Glass pill · Order ticket · binary market');
  // décor absolu ou sans texte ignoré dans la règle de majorité
  const pill = r.candidates.find((c) => c.kind === 'segmented' && c.text === 'A B');
  assert.ok(pill, 'pill with decorative spans is segmented');
  assert.match(pill.html, /<section id="app" data-ca-shell=""><div class="pill" id="pill">/);
  assert.equal(r.candidates.filter((c) => c.kind === 'control').length, 0);
  // l'indicateur dépend de l'ancêtre .demo : il doit garder son fond blanc une fois scopé
  assert.equal(toHex(await renderedBg(r.styles, seg.html, 'light', '.ind')), '#ffffff');
});

test('dark metrics differ and scoped CSS reproduces original colors', async () => {
  const r = await run('dark-tokens.html');
  const b = r.candidates.find((c) => c.tag === 'button');
  assert.equal(b.metrics.light.bg, '#2f6bff');
  assert.equal(b.metrics.dark.bg, '#8ab4ff');
  assert.notEqual(b.metrics.light.fg, b.metrics.dark.fg);
  for (const theme of ['light', 'dark']) {
    const bg = await renderedBg(r.styles, b.html, theme, 'button');
    assert.equal(toHex(bg), b.metrics[theme].bg, theme);
  }
  assert.ok(b.colors.includes('#2f6bff') && b.colors.includes('#8ab4ff'));
  await assertForcedThemes(r, b);
});

// Mécanisme de la galerie : thème forcé par la feuille (cssLight/cssDark), quel que soit le media émulé.
async function assertForcedThemes(r, b) {
  assert.equal(toHex(await renderedBg({ css: r.styles.cssDark, fontFaceCss: r.styles.fontFaceCss }, b.html, 'light', 'button', null)), b.metrics.dark.bg);
  assert.equal(toHex(await renderedBg({ css: r.styles.cssLight, fontFaceCss: r.styles.fontFaceCss }, b.html, 'dark', 'button', null)), b.metrics.light.bg);
}

test('prefers-color-scheme-only page: forced theme sheets reproduce both themes', async () => {
  const r = await run('dark-media-only.html');
  assert.equal(r.status, 'ok');
  const b = r.candidates.find((c) => c.tag === 'button');
  assert.equal(b.metrics.light.bg, '#2f6bff');
  assert.equal(b.metrics.dark.bg, '#8ab4ff');
  assert.equal(b.metrics.dark.border, '#ff0000');
  assert.doesNotMatch(r.styles.cssDark, /prefers-color-scheme/);
  assert.doesNotMatch(r.styles.cssLight, /prefers-color-scheme/);
  await assertForcedThemes(r, b);
});

test('broken page does not throw', async () => {
  const t0 = Date.now();
  const r = await run('broken.html', { timeoutMs: 5000 });
  assert.equal(r.status, 'ok');
  assert.equal(r.error, undefined);
  assert.ok(r.warnings.some((w) => /Erreur JS.*boom/.test(w)), 'JS error warned');
  assert.ok(r.warnings.some((w) => /cdn\.invalid\/x\.js/.test(w)), 'failed script warned');
  assert.ok(r.warnings.some((w) => /cdn\.invalid\/theme\.css/.test(w)), 'non-Google stylesheet warned');
  assert.deepEqual(r.styles.fontLinks, ['https://fonts.googleapis.com/css2?family=Inter:wght@400&display=swap']);
  assert.ok(r.candidates.some((c) => c.text === 'Toujours là'), 'DOM still extracted');
  assert.ok(Date.now() - t0 < 10000);
});

test('missing file yields error status', async () => {
  const r = await run('nope.html');
  assert.equal(r.status, 'error');
  assert.ok(r.error);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.candidates, []);
});

test('repeated elements are deduped before the cap', async () => {
  const r = await run('repeated.html', { maxCandidates: 5 });
  const buttons = r.candidates.filter((c) => c.tag === 'button');
  assert.equal(buttons.length, 2);
  assert.equal(Math.max(...buttons.map((b) => b.occurrences)), 300);
  assert.ok(r.candidates.length <= 5);
});

test('cap applies after dedup', async () => {
  const r = await run('basic.html', { maxCandidates: 2 });
  assert.equal(r.candidates.length, 2);
  r.candidates.forEach((c, i) => assert.equal(c.index, i));
});

test('CLI writes candidates, styles, status and contact sheet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-raw-'));
  try {
    copyFileSync(fx('basic.html'), join(dir, 'index.html'));
    const cli = fileURLToPath(new URL('../scripts/extract-page.mjs', import.meta.url));
    const out = JSON.parse(execFileSync(process.execPath, [cli, dir], { encoding: 'utf8' }));
    assert.equal(out.status, 'ok');
    const cands = JSON.parse(readFileSync(join(dir, 'candidates.json'), 'utf8'));
    assert.equal(out.candidates, cands.length);
    assert.ok(cands.length > 0);
    const styles = JSON.parse(readFileSync(join(dir, 'styles.json'), 'utf8'));
    assert.equal(typeof styles.groups.main.css, 'string');
    assert.ok(cands.every((c) => c.styleGroup === 'main'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'extract.json'), 'utf8')), { status: 'ok', warnings: [], candidates: cands.length });
    const png = readFileSync(join(dir, 'contact.png'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('element gone in dark theme: light metrics reused with a warning', async () => {
  const r = await run('dark-rerender.html');
  assert.equal(r.status, 'ok');
  const b = r.candidates.find((c) => c.tag === 'button');
  assert.deepEqual(b.metrics.dark, b.metrics.light);
  assert.ok(r.warnings.some((w) => /sombre/i.test(w) && /1/.test(w)), JSON.stringify(r.warnings));
});

test('renderContactSheet renders numbered gallery tiles to a PNG', async () => {
  const r = await run('basic.html');
  const dir = mkdtempSync(join(tmpdir(), 'ca-sheet-'));
  try {
    const out = join(dir, 'contact.png');
    await renderContactSheet(r.candidates, r.styles, out, browser);
    const png = readFileSync(out);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 1280, 'width');
    // Une rangée de tuiles au moins : hauteur > bandeau + tuile.
    assert.ok(png.readUInt32BE(20) > 100, `height ${png.readUInt32BE(20)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('app-shell layout: tile shows the component (shell ancestors neutralised), off-tile elements reported', async () => {
  const r = await run('app-shell.html');
  assert.equal(r.status, 'ok', r.error);
  const st = r.candidates.find((c) => c.text === 'Statements');
  const lost = r.candidates.find((c) => c.text === 'Lost');
  assert.ok(st && lost);
  assert.match(st.html, /data-ca-shell/);
  assert.doesNotMatch(st.html, /class="ca-body[^"]*"[^>]*data-ca-shell/, 'ca-body root not marked');
  assert.match(r.styles.cssLight, /\[data-ca-shell\]\{display:block!important/);
  const dir = mkdtempSync(join(tmpdir(), 'ca-sheet-'));
  try {
    const sheet = await renderContactSheet(r.candidates, r.styles, join(dir, 'contact.png'), browser);
    assert.ok(!sheet.blank.includes(st.index), `Statements tile blank: ${JSON.stringify(sheet.blank)}`);
    assert.ok(sheet.blank.includes(lost.index), 'element pushed out by its own layout is reported');
    assert.deepEqual(sheet.sheets.map((s) => [s.from, s.to]), [[0, r.candidates.length - 1]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
