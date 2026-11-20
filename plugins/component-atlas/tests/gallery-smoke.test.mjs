import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, copyFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../scripts/lib/browser.mjs';
import { writeGallery, inlineGallery } from '../scripts/build.mjs';

const SAMPLE = fileURLToPath(new URL('./fixtures/data.sample.json', import.meta.url));
const data = JSON.parse(readFileSync(SAMPLE, 'utf8'));
// Même squelette que celui ajouté par l'outil de publication des artifacts.
const wrap = (content) => '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>'
  + content + '</body></html>';

let dist, server, base, browser;

before(async () => {
  dist = mkdtempSync(join(tmpdir(), 'atlas-gallery-'));
  copyFileSync(SAMPLE, join(dist, 'data.json'));
  assert.equal(await writeGallery(dist), true);
  const page = readFileSync(join(dist, 'index.html'), 'utf8');
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // /nodata/ : même page, sans data.json à côté (état d'erreur).
    const p = url.pathname.replace(/^\/nodata/, '');
    if (p === '/' || p === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(wrap(page));
    } else if (p === '/data.json' && !url.pathname.startsWith('/nodata')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(readFileSync(join(dist, 'data.json')));
    } else { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r));
  rmSync(dist, { recursive: true, force: true });
});

async function open(path, { width = 1280, height = 900, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme });
  // Hermétique : Google Fonts servi vide.
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + path);
  return { page, errors, close: () => context.close() };
}

const visibleCount = data.components.filter((c) => !c.measureOnly).length;

test('inlineGallery follows the artifact page contract', () => {
  const html = inlineGallery();
  assert.doesNotMatch(html, /<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i);
  assert.match(html, /^<title>Component Atlas<\/title>/);
  assert.match(html, /<meta name="claude:viewport-fit-sides" content="cover">/);
  assert.doesNotMatch(html, /<!--APP-->/);
  assert.doesNotMatch(html, /^\s*(import|export)\s/m, 'module syntax stripped');
  assert.doesNotMatch(html, /<script[^>]+src=/i, 'no external script');
  assert.doesNotMatch(html, /\balert\(|\bconfirm\(|\bprompt\(|window\.print/);
  assert.ok(existsSync(join(dist, 'index.html')));
});

for (const vp of [{ width: 1280, height: 900 }, { width: 400, height: 800 }]) {
  test(`gallery renders tiles with no console errors at ${vp.width}px`, async () => {
    const { page, errors, close } = await open('/', vp);
    try {
      await page.waitForSelector('.tile');
      const tiles = await page.$$eval('.tile', (els) => els.map((el) => {
        const first = el.shadowRoot && el.shadowRoot.firstElementChild;
        const r = first ? first.getBoundingClientRect() : { width: 0, height: 0 };
        return { w: r.width, h: r.height, sheets: el.shadowRoot ? el.shadowRoot.adoptedStyleSheets.length : 0 };
      }));
      assert.equal(tiles.length, visibleCount);
      for (const t of tiles) {
        assert.ok(t.w > 0 && t.h > 0, JSON.stringify(t));
        assert.equal(t.sheets, 1);
      }
      const text = await page.textContent('body');
      assert.match(text, /Component Atlas/);
      assert.match(text, new RegExp(`${visibleCount}\\s*composants`));
      assert.match(text, /Non analysés/);
      const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      assert.ok(sw <= iw, `scrollWidth ${sw} > innerWidth ${iw}`);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test('one stylesheet per artifact and scheme is shared across tiles, fonts injected once', async () => {
  const { page, close } = await open('/');
  try {
    await page.waitForSelector('.tile');
    const r = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.tile')];
      const sheets = new Set(tiles.map((t) => t.shadowRoot.adoptedStyleSheets[0]));
      const faces = [...document.head.querySelectorAll('style')].filter((s) => s.textContent.includes('AtlasTest')).length;
      return { sheets: sheets.size, faces };
    });
    const arts = new Set(data.components.filter((c) => !c.measureOnly).map((c) => c.artifactId));
    assert.equal(r.sheets, arts.size);
    assert.equal(r.faces, 1);
  } finally { await close(); }
});

const KEY_DARK = data.components.find((c) => c.artifactId === 'nimbTokens02').key.slice(0, 8);
const bgOf = (page, sel) => page.$eval(sel, (el) => getComputedStyle(el.shadowRoot.firstElementChild).backgroundColor);

test('forcing dark on a tile changes the component background', async () => {
  const { page, errors, close } = await open('/');
  try {
    const sel = `.tile[data-key="${KEY_DARK}"]`;
    await page.waitForSelector(sel);
    assert.equal(await bgOf(page, sel), 'rgb(255, 255, 255)');
    await page.click('#f-theme [data-value="dark"]');
    assert.equal(await bgOf(page, sel), 'rgb(18, 18, 18)');
    assert.equal(await page.$eval(sel, (el) => el.getAttribute('data-theme')), 'dark');
    await page.click('#f-theme [data-value="auto"]');
    assert.equal(await bgOf(page, sel), 'rgb(255, 255, 255)');
    assert.equal(await page.$eval(sel, (el) => el.hasAttribute('data-theme')), false);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('auto theme follows the system scheme', async () => {
  const { page, close } = await open('/', { colorScheme: 'dark' });
  try {
    const sel = `.tile[data-key="${KEY_DARK}"]`;
    await page.waitForSelector(sel);
    assert.equal(await bgOf(page, sel), 'rgb(18, 18, 18)');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction((s) => getComputedStyle(document.querySelector(s).shadowRoot.firstElementChild).backgroundColor === 'rgb(255, 255, 255)', sel);
  } finally { await close(); }
});

test('#c-<key8> opens the detail view', async () => {
  const comp = data.components.find((c) => c.name === 'Bouton principal');
  const { page, errors, close } = await open(`/#c-${comp.key.slice(0, 8)}`);
  try {
    await page.waitForSelector('.detail');
    assert.equal((await page.textContent('h1')).trim(), 'Bouton principal');
    const stage = await page.$eval('.tile-large', (el) => {
      const r = el.shadowRoot.firstElementChild.getBoundingClientRect();
      return { w: r.width, h: r.height, text: el.shadowRoot.textContent };
    });
    assert.ok(stage.w > 0 && stage.h > 0);
    assert.match(stage.text, /Enregistrer/);
    const hrefs = await page.$$eval('.detail a[target="_blank"]', (as) => as.map((a) => a.href));
    assert.ok(hrefs.includes('https://claude.ai/artifact/nimbBasic01'));
    assert.match(await page.textContent('.detail'), /Mesures/);
    assert.match(await page.textContent('.detail'), /#2f6bff/);
    // Bascule Sombre de la fiche : data-theme forcé sur l'hôte.
    await page.click('#detail-theme [data-value="dark"]');
    assert.equal(await page.$eval('.tile-large', (el) => el.getAttribute('data-theme')), 'dark');
    // Copier : presse-papiers refusé → repli sur sélection, sans erreur.
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('refusé')); });
    await page.click('text=Copier le HTML');
    await page.waitForFunction(() => getSelection().toString().includes('Enregistrer'));
    // Retour et clic sur une tuile.
    await page.click('a.back');
    await page.waitForSelector('.tile');
    await page.click(`a.specimen[href="#c-${KEY_DARK}"]`);
    await page.waitForSelector('.detail');
    assert.equal((await page.textContent('h1')).trim(), 'Valider');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('filters narrow the tiles', async () => {
  const { page, close } = await open('/');
  try {
    await page.waitForSelector('.tile');
    await page.selectOption('#f-project', 'Lumen');
    assert.equal(await page.$$eval('.tile', (t) => t.length), data.components.filter((c) => c.project === 'Lumen' && !c.measureOnly).length);
    await page.selectOption('#f-project', '');
    await page.fill('#f-q', 'etiquette');
    await page.waitForFunction(() => document.querySelectorAll('.tile').length === 1);
    await page.fill('#f-q', 'zzzz');
    await page.waitForSelector('text=Aucun composant ne correspond');
    await page.click('text=Effacer les filtres');
    assert.equal(await page.$$eval('.tile', (t) => t.length), visibleCount);
  } finally { await close(); }
});

const KEY_WIDE = data.components.find((c) => c.name === 'Barre supérieure').key.slice(0, 8);

for (const vp of [{ width: 1280, height: 900 }, { width: 400, height: 800 }]) {
  test(`a wide component is scaled down to fit its tile, never cropped (${vp.width}px)`, async () => {
    const { page, errors, close } = await open('/', vp);
    try {
      const card = `a.specimen[href="#c-${KEY_WIDE}"]`;
      await page.waitForSelector(`${card} .scaled:not([hidden])`);
      const r = await page.$eval(card, (a) => {
        const frame = a.querySelector('.preview').getBoundingClientRect();
        const comp = a.querySelector('.tile').shadowRoot.firstElementChild.getBoundingClientRect();
        return { frame: { l: frame.left, r: frame.right, t: frame.top, b: frame.bottom },
          comp: { l: comp.left, r: comp.right, t: comp.top, b: comp.bottom },
          mark: a.querySelector('.scaled').textContent, project: a.querySelector('.specimen-project').textContent };
      });
      assert.ok(r.comp.r <= r.frame.r + 1 && r.comp.l >= r.frame.l - 1, JSON.stringify(r));
      assert.ok(r.comp.b <= r.frame.b + 1, JSON.stringify(r));
      assert.match(r.mark, /^réduit à \d+ %$/);
      assert.equal(r.project, 'Orbit');
      // Un petit composant n'est pas réduit.
      assert.equal(await page.$eval(`a.specimen[href="#c-${KEY_DARK}"] .scaled`, (el) => el.hidden), true);
      if (vp.width === 400) {
        const cols = await page.$eval('.grid', (g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
        assert.equal(cols, 1);
      }
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test('the detail stage scrolls horizontally for wide components', async () => {
  const { page, errors, close } = await open(`/#c-${KEY_WIDE}`);
  try {
    await page.waitForSelector('.stage-scroll .tile-large');
    const r = await page.$eval('.stage-scroll', (el) => {
      el.scrollLeft = 300;
      return { left: el.scrollLeft, inert: el.inert, tabindex: el.getAttribute('tabindex'), hostInert: el.querySelector('.tile-large').inert };
    });
    assert.ok(r.left > 0, JSON.stringify(r));
    assert.equal(r.inert, false);
    assert.equal(r.tabindex, '0');
    assert.equal(r.hostInert, true);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('gallery tokens are prefixed so they do not leak into components', async () => {
  const { page, close } = await open('/');
  try {
    await page.waitForSelector('.tile');
    const r = await page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { bg: cs.getPropertyValue('--bg'), ink: cs.getPropertyValue('--ink'), caBg: cs.getPropertyValue('--ca-bg') };
    });
    assert.equal(r.bg, '');
    assert.equal(r.ink, '');
    assert.notEqual(r.caBg.trim(), '');
  } finally { await close(); }
});

test('shows an error state when data.json is missing', async () => {
  const { page, close } = await open('/nodata/');
  try {
    await page.waitForSelector('[role="alert"]');
    assert.match(await page.textContent('[role="alert"]'), /404/);
  } finally { await close(); }
});

const KEY_PRIMARY = data.components.find((c) => c.name === 'Bouton principal').key.slice(0, 8);

test('tabs link the four views', async () => {
  const { page, close } = await open('/');
  try {
    await page.waitForSelector('.tile');
    const tabs = await page.$$eval('#tabs .tab', (as) => as.map((a) => [a.getAttribute('href'), a.textContent]));
    assert.deepEqual(tabs, [['#types', 'Par type'], ['#matrice', 'Matrice'], ['#couleurs', 'Couleurs'], ['#mesures', 'Mesures']]);
  } finally { await close(); }
});

test('matrix cell click filters the by-type view', async () => {
  const { page, errors, close } = await open('/#matrice');
  try {
    const cell = '.mx-cell[data-type="button"][data-project="Nimbus"]';
    await page.waitForSelector(cell);
    const nimbusButtons = data.components.filter((c) => c.type === 'button' && c.project === 'Nimbus' && !c.measureOnly).length;
    assert.equal((await page.textContent(`${cell} .mx-count`)).trim(), String(nimbusButtons), 'count written in the cell');
    // Le Save d'Atelier est measureOnly : la case button × Atelier ne compte que « Button ».
    assert.equal((await page.textContent('.mx-cell[data-type="button"][data-project="Atelier"] .mx-count')).trim(), '1');
    assert.equal(await page.$('.mx-cell[data-type="chip"][data-project="Nimbus"] text'), null, 'empty cell has no count');
    assert.equal(await page.$eval(cell, (el) => el.getAttribute('tabindex')), '0');
    await page.click(cell);
    await page.waitForFunction(() => location.hash === '#types');
    await page.waitForSelector('.tile');
    assert.equal(await page.$eval('#f-type', (s) => s.value), 'button');
    assert.equal(await page.$eval('#f-project', (s) => s.value), 'Nimbus');
    assert.equal(await page.$$eval('.tile', (t) => t.length), nimbusButtons);
    // Clavier : Entrée sur une case.
    // Retour à la matrice : les filtres globaux s'y appliquent aussi.
    await page.click('#tabs >> text=Matrice');
    await page.waitForSelector('.mx-cell');
    assert.deepEqual(await page.$$eval('.mx-cell', (cs) => cs.map((c) => `${c.dataset.type}/${c.dataset.project}`)), ['button/Nimbus']);
    await page.selectOption('#f-type', '');
    await page.selectOption('#f-project', '');
    await page.focus('.mx-cell[data-type="chip"][data-project="Lumen"]');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => location.hash === '#types');
    assert.equal(await page.$eval('#f-type', (s) => s.value), 'chip');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('swatches: one per distinct color, focus lists the components using it', async () => {
  const { page, errors, close } = await open('/#couleurs');
  try {
    await page.waitForSelector('.sw-dot');
    const distinct = new Set();
    for (const c of data.components) for (const k of ['bg', 'fg', 'border']) if (c.metrics.light[k]) distinct.add(c.metrics.light[k].toLowerCase());
    assert.equal(await page.$$eval('.sw-dot', (d) => d.length), distinct.size);
    const blue = '.sw-dot[data-hex="#2f6bff"]';
    assert.equal(await page.$eval(blue, (el) => el.getAttribute('tabindex')), '0');
    await page.focus(blue);
    await page.waitForSelector(`.viz-detail a.specimen[href="#c-${KEY_PRIMARY}"] .tile`);
    const users = data.components.filter((c) => ['bg', 'fg', 'border'].some((k) => c.metrics.light[k] === '#2f6bff')).length;
    assert.equal(await page.$$eval('.viz-detail .tile', (t) => t.length), users, 'measureOnly users included');
    assert.match(await page.textContent('.viz-detail'), /#2f6bff/);
    // Nuancier sombre : les couleurs sombres de nimbTokens02 apparaissent.
    await page.click('#sw-theme [data-value="dark"]');
    await page.waitForSelector('.sw-dot[data-hex="#8ab4ff"]');
    // Un blanc sur fond clair porte un contour.
    await page.click('#sw-theme [data-value="light"]');
    assert.match(await page.$eval('.sw-dot[data-hex="#ffffff"] circle.sw-mark', (c) => c.getAttribute('class')), /near-l/);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('metrics: strip plots for the selected type, hover shows previews', async () => {
  const { page, errors, close } = await open('/#mesures');
  try {
    await page.waitForSelector('.strip');
    assert.equal(await page.$eval('#m-type', (s) => s.value), 'button');
    const heights = new Set(data.components.filter((c) => c.type === 'button').map((c) => Math.round(c.metrics.light.height)));
    const strip = page.locator('.strip[data-metric="height"]');
    assert.match(await strip.textContent(), new RegExp(`${heights.size} valeurs différentes`));
    assert.equal(await strip.locator('.st-dot').count(), heights.size);
    await strip.locator('.st-dot[data-value="32"]').hover();
    await page.waitForSelector(`.viz-detail a.specimen[href="#c-${KEY_PRIMARY}"] .tile`);
    assert.equal(await page.$$eval('.viz-detail .tile', (t) => t.length),
      data.components.filter((c) => c.type === 'button' && Math.round(c.metrics.light.height) === 32).length);
    await page.selectOption('#m-type', 'toggle');
    await page.waitForSelector('.strip[data-metric="height"]');
    assert.match(await page.textContent('.strip[data-metric="height"]'), /valeurs? différentes?/);
    assert.equal(await page.$eval('#m-type', (s) => s.value), 'toggle');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

for (const view of ['matrice', 'couleurs', 'mesures']) {
  test(`#${view} has no horizontal page scroll at 400px`, async () => {
    const { page, errors, close } = await open(`/#${view}`, { width: 400, height: 800 });
    try {
      await page.waitForSelector('.viz svg');
      const { sw, iw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
      assert.ok(sw <= iw, `scrollWidth ${sw} > innerWidth ${iw}`);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}
