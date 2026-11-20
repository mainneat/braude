# Component Atlas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un plugin Claude Code `/component-atlas` qui lit tous les artifacts du compte claude.ai du designer, extrait chaque composant UI avec son vrai CSS, et publie une galerie privée (5 vues) comme artifact.

**Architecture:** Claude orchestre (outil Artifact pour lister/lire/publier, sous-agents pour classer) en suivant `SKILL.md`. Des scripts Node font le travail déterministe : planification incrémentale, rendu Playwright + détection + snapshot, extraction Design System, fusion/déduplication. La galerie est du HTML/JS sans build, inliné en un `index.html` qui charge un `data.json` publié à côté.

**Tech Stack:** Node ≥ 18 (ESM, `node:test`, `node:crypto`), Playwright/Chromium (chargé via `createRequire(import.meta.url)('playwright')`), aucune autre dépendance. Galerie : JS vanilla, Shadow DOM, SVG à la main.

**Spec:** `docs/superpowers/specs/2026-11-20-component-atlas-design.md`

## Global Constraints

- Tout le code vit sous `plugins/component-atlas/` ; marketplace à la racine `.claude-plugin/marketplace.json`.
- État de travail du designer : `.component-atlas/` dans son répertoire courant (jamais commité ; le plugin n'ajoute rien au repo du designer).
- Le HTML des artifacts ne passe jamais dans le contexte principal de Claude : `Artifact read` avec `path`/`paths` + `out_dir`.
- Galerie : privée, interface en français, CSP artifact (aucun script externe nécessaire ; polices uniquement Google Fonts ou `@font-face` inline), ≤ 16 Mo, données dans `data.json` chargé par `fetch('data.json')`.
- Taxonomie (slug → libellé affiché), ordre fixe : `button` Button · `icon-button` Icon button · `toggle` Toggle / switch · `segmented` Segmented control / tabs · `checkbox-radio` Checkbox / radio · `input` Input / search · `select` Select / dropdown · `slider` Slider · `card` Card · `chip` Chip / tag / badge · `avatar` Avatar · `icon` Icon · `navigation` Navigation · `list-item` List item / row · `overlay` Modal / sheet / popover · `toast` Toast / banner · `chart` Chart / data viz · `other` Autre.
- Type Design System reconnu par son `type_url` `https://claude.ai/artifact/5M7UeXXcx16TP3vzVFNDzd`. Tout autre type → statut `skipped` (« non analysé »).
- Composants non interactifs : snapshot du DOM après exécution du JS, aucun script d'artifact exécuté dans la galerie.
- Tests : `cd plugins/component-atlas && node --test tests/` doit passer à chaque commit.

## Review Focus

1. **Page qui plante ou CDN injoignable** : l'artifact passe en `status:"error"` avec une note, le run continue (test : fixture `broken.html`, Task 4).
2. **CSS dépendant de `:root`/`html`/`body` et du thème sombre** : une fois scopé en Shadow DOM, le composant a la même couleur de fond qu'à l'origine, en clair comme en sombre (test de fidélité, Task 4).
3. **Page avec des centaines d'éléments répétés** (listes, grilles) : les doublons sont regroupés avant le plafond de 150 candidats, avec `occurrences` (test, Task 4).
4. **Polices data-URI énormes** (ex. Mainneat Grotesk) : dédoublonnées par hash ; une face > 2 Mo est retirée avec une note, la galerie reste < 16 Mo (test, Task 6).
5. **Artifacts supprimés/renommés entre deux runs et `projects.json` édité à la main** : les supprimés disparaissent, les éditions du designer sont conservées (tests, Tasks 3 et 6).

---

## File Structure

```
.claude-plugin/marketplace.json
plugins/component-atlas/
  .claude-plugin/plugin.json
  package.json                       # "type":"module", scripts.test
  skills/component-atlas/SKILL.md    # orchestration suivie par Claude
  seed/projects.louis.json           # { "<artifactId>": "<projet>" } issu de mindmap.html
  scripts/
    plan.mjs                         # CLI : diff inventaire/cache → plan.json
    extract-page.mjs                 # CLI + extractPage()
    extract-ds.mjs                   # CLI + extractDesignSystem()
    build.mjs                        # CLI + buildData() + inline galerie
    lib/color.mjs  lib/css.mjs  lib/hash.mjs  lib/schema.mjs
    lib/cache.mjs  lib/tokens.mjs  lib/taxonomy.mjs  lib/browser.mjs
    browser/detect.js                # injecté dans la page : détection + shell + mesures + arbre CSS
  gallery/
    index.template.html              # tokens, layout, <!--APP-->
    src/tile.mjs  src/logic.mjs  src/views.mjs  src/main.mjs
  tests/*.test.mjs
  tests/fixtures/pages/{basic,js-generated,dark-tokens,broken,repeated}.html
  tests/fixtures/ds/project/...      # mini design system
  tests/fixtures/data.sample.json    # pour les tests galerie
```

Données partagées (définies Task 2, utilisées partout) :

```ts
type Metrics = { bg:string|null, fg:string|null, border:string|null, radius:number,
  fontFamily:string, fontSize:number, fontWeight:number, width:number, height:number,
  paddingX:number, paddingY:number }
type Candidate = { index:number, kind:'control'|'segmented'|'icon'|'card'|'nav'|'ds',
  tag:string, text:string, context:string, html:string, occurrences:number,
  metrics:{light:Metrics, dark:Metrics}, colors:string[],
  presetName?:string, description?:string, measureOnly?:boolean, parentIndex?:number }
type Styles = { css:string, fontFaceCss:string, fontLinks:string[] }
type Classified = { project:string, items:{ index:number, keep:boolean, type:TypeSlug, name:string }[] }
```

`.component-atlas/` : `inventory.json` (`[{id,url,title,updated}]`), `cache.json` (`{galleryUrl:string|null, artifacts:{[id]:{updated,status}}}`), `plan.json`, `projects.json`, `raw/<id>/{meta.json,index.html|project/…,candidates.json,styles.json,contact.png,classified.json}`, `dist/{index.html,data.json}`. `meta.json` = `{id,url,title,updated,kind:'page'|'design-system'|'other-type',typeName?:string}`.

---

### Task 1: Scaffold du plugin + utilitaires purs

**Files:**
- Create: `.claude-plugin/marketplace.json`, `plugins/component-atlas/.claude-plugin/plugin.json`, `plugins/component-atlas/package.json`
- Create: `scripts/lib/taxonomy.mjs`, `scripts/lib/color.mjs`, `scripts/lib/hash.mjs`, `scripts/lib/schema.mjs`
- Test: `tests/utils.test.mjs`

**Interfaces:**
- Produces: `TAXONOMY: {slug,label}[]` (ordre et libellés des Global Constraints), `TYPE_SLUGS: Set<string>`; `toHex(css:string): string|null`; `hexToHsl(hex:string): {h:number,s:number,l:number}` (h 0–360, s/l 0–1); `componentKey(html:string, m:Metrics): string` (sha1 hex 40); `validateClassified(data:unknown, candidateCount:number): string[]` (liste d'erreurs, vide = valide).

- [ ] **Step 1: Write the failing tests**

```js
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
});
test('validateClassified', () => {
  assert.deepEqual(validateClassified({ project:'Nimb', items:[{ index:0, keep:true, type:'toggle', name:'Glass pill' }] }, 1), []);
  assert.ok(validateClassified({ project:'', items:[] }, 0).length > 0);              // projet vide
  assert.ok(validateClassified({ project:'N', items:[{ index:3, keep:true, type:'toggle', name:'x' }] }, 2).length > 0); // index hors bornes
  assert.ok(validateClassified({ project:'N', items:[{ index:0, keep:true, type:'switch', name:'x' }] }, 1).length > 0); // type inconnu
  assert.ok(validateClassified({ project:'N', items:[{ index:0, keep:true, type:'toggle', name:'' }] }, 1).length > 0);  // nom vide si keep
});
test('taxonomy order', () => { assert.equal(TAXONOMY[0].slug, 'button'); assert.equal(TAXONOMY.at(-1).slug, 'other'); assert.equal(TAXONOMY.length, 18); });
```

- [ ] **Step 2: Run** `cd plugins/component-atlas && node --test tests/` → FAIL (modules absents).
- [ ] **Step 3: Implement** les quatre modules et les manifestes. `plugin.json` : `{"name":"component-atlas","description":"Cartographie visuelle des composants dessinés dans vos artifacts claude.ai","version":"0.1.0"}`. `marketplace.json` liste ce plugin avec `"source":"./plugins/component-atlas"`. `package.json` : `"type":"module"`, `"scripts":{"test":"node --test tests/"}`, `"engines":{"node":">=18"}`, `playwright` en `peerDependencies`.
- [ ] **Step 4: Run** `node --test tests/` → PASS.
- [ ] **Step 5: Commit** `feat(atlas): scaffold plugin and pure utilities`

---

### Task 2: Scoping CSS et tokens

**Files:**
- Create: `scripts/lib/css.mjs`, `scripts/lib/tokens.mjs`
- Test: `tests/css.test.mjs`

**Interfaces:**
- Produces:
  - `type RuleNode = {type:'style',selector:string,body:string} | {type:'media'|'supports',condition:string,children:RuleNode[]} | {type:'font-face',cssText:string} | {type:'keyframes'|'other',cssText:string}`
  - `scopeSelector(sel:string): string`
  - `serializeScoped(rules:RuleNode[]): {css:string, fontFaceCss:string}` (les `@font-face` sortent dans `fontFaceCss`, même imbriquées ; `@keyframes` restent dans `css`).
  - `tokensToCss(tokens:object): string` (format `tokens.json` du type Design System).

- [ ] **Step 1: Write the failing tests**

```js
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
test('tokensToCss', () => {
  const css = tokensToCss({ color:{ themes:[{id:'light'},{id:'dark'}], tokens:[{ name:'ink', value:{ light:'#111', dark:'#eee' } }] },
    spacing:{ tokens:[{ name:'space-4', value:'16px' }] } });
  assert.match(css, /:root\{[^}]*--ink:#111/);
  assert.match(css, /--space-4:16px/);
  assert.match(css, /\[data-theme="dark"\]\{[^}]*--ink:#eee/);
  assert.match(css, /prefers-color-scheme: dark/);
});
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `scopeSelector` découpe sur les virgules hors parenthèses/crochets/guillemets, remplace les sélecteurs de type `html`/`:root` (début de composé) par `:host` et `body` par `.ca-body` uniquement quand c'est un sélecteur de type (pas une classe, pas dans un attribut) ; tout ce qui suit `:host` dans le même composé (attributs, pseudo-classes) passe entre `:host(...)`. `tokensToCss` : premier thème sur `:root`, thèmes suivants sous `[data-theme="<id>"]` et, pour `dark`, aussi sous `@media (prefers-color-scheme: dark){:root:not([data-theme="light"])}` ; familles non-couleur (`spacing`, `radius`, `shadow`…) dans `:root`. Les tokens `type` sont ignorés (les polices sont gérées à part).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(atlas): CSS scoping for shadow DOM and DS tokens`

---

### Task 3: Cache et planification incrémentale

**Files:**
- Create: `scripts/lib/cache.mjs`, `scripts/plan.mjs`
- Test: `tests/cache.test.mjs`

**Interfaces:**
- Consumes: rien.
- Produces: `loadJson(path, fallback)`, `saveJson(path, data)` (crée les dossiers) ; `planRun(inventory:{id,updated}[], cache:Cache): {toProcess:string[], removed:string[], unchanged:string[]}` ; CLI `node scripts/plan.mjs [--dir .component-atlas]` écrit `plan.json` et l'affiche sur stdout.

- [ ] **Step 1: Write the failing tests**

```js
test('planRun', () => {
  const cache = { galleryUrl:null, artifacts:{ a:{ updated:'2026-11-10', status:'ok' }, b:{ updated:'2026-11-10', status:'ok' }, c:{ updated:'2026-11-01', status:'error' } } };
  const r = planRun([{ id:'a', updated:'2026-11-10' }, { id:'b', updated:'2026-11-18' }, { id:'c', updated:'2026-11-01' }, { id:'d', updated:'2026-11-20' }], cache);
  assert.deepEqual(r.toProcess.sort(), ['b','c','d']);   // modifié, en erreur (on réessaie), nouveau
  assert.deepEqual(r.unchanged, ['a']);
  assert.deepEqual(r.removed, []);
  assert.deepEqual(planRun([{ id:'a', updated:'2026-11-10' }], cache).removed.sort(), ['b','c']);
});
test('plan CLI writes plan.json', async () => { /* tmp dir avec inventory.json, pas de cache.json → tout en toProcess */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Un artifact en `error` est toujours retraité ; un `skipped` ne l'est que si `updated` change.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(atlas): incremental run planning`

---

### Task 4: Extraction d'une page classique

**Files:**
- Create: `scripts/browser/detect.js`, `scripts/lib/browser.mjs`, `scripts/extract-page.mjs`
- Create: `tests/fixtures/pages/basic.html`, `js-generated.html`, `dark-tokens.html`, `broken.html`, `repeated.html`
- Test: `tests/extract-page.test.mjs`

**Interfaces:**
- Consumes: `serializeScoped` (Task 2), `toHex`, `componentKey` (Task 1).
- Produces:
  - `launch(): Promise<Browser>` dans `lib/browser.mjs` (Playwright via `createRequire`, chemin `/opt/pw-browsers/chromium` en repli si `chromium.launch()` échoue).
  - `extractPage(htmlPath:string, opts?:{maxCandidates?:number=150, timeoutMs?:number=20000, browser?:Browser}): Promise<{status:'ok'|'error', error?:string, styles:Styles, candidates:Candidate[]}>`
  - CLI `node scripts/extract-page.mjs <rawDir>` → `candidates.json`, `styles.json`, `contact.png` (via `renderContactSheet` de Task 7 une fois disponible ; d'ici là, capture des candidats numérotés sur la page source).
  - `detect.js` expose dans la page `window.__caDetect(maxCandidates)` → `{candidates, rules:RuleNode[], fontLinks}` et `window.__caMeasure()` → `Metrics[]` (mêmes indices, pour le second thème).

Règles de détection (choix figés ; seuils fins laissés à l'implémenteur) :
- *segmented* : élément dont ≥ 2 enfants directs sont des boutons, ou `[role=tablist]`. Ses boutons ne sont pas des candidats séparés.
- *control* : `button`, `input:not([type=hidden])`, `select`, `textarea`, `[role=button|switch|tab|checkbox|radio|slider]`.
- *icon* : `svg` rendu ≤ 48×48 px, hors d'un autre candidat.
- *card* : fond différent du parent, bordure ou ombre, `border-radius` > 0, 120–720 px de large, 60–720 px de haut, ≥ 2 descendants avec du texte ; on garde la plus interne quand des cartes s'emboîtent.
- *nav* : `nav`, `[role=navigation]`, ou barre fixe/sticky avec ≥ 3 liens ou boutons.
- On ignore les éléments invisibles. On dédoublonne dans la page par `componentKey` **avant** d'appliquer le plafond, en comptant `occurrences`. `context` = titre (h1–h6, légende, `aria-label`) le plus proche qui précède, ≤ 80 caractères.
- `html` = coquille d'ancêtres (de l'enfant de `body` au parent : tag + `class`, `role`, `style`, `data-*`, `aria-*`, sans frères ni texte) dans `<div class="ca-body …classes du body">`, puis le `outerHTML` de l'élément. Les attributs internes de marquage ne doivent pas y apparaître.
- Thème : la page est chargée en `colorScheme:'light'`, détectée et mesurée, puis on passe en `'dark'` via `emulateMedia` et on remesure.

- [ ] **Step 1: Write the fixtures and failing tests**

Fixtures : `basic.html` (2 boutons, une carte, un `[role=switch]`, 3 petits SVG, une `nav`) ; `js-generated.html` (segmented control injecté par `innerHTML` au chargement, styles `.seg .ind` dépendant de l'ancêtre, comme « Nimb switches ») ; `dark-tokens.html` (`--bg` sur `:root` + bloc `prefers-color-scheme: dark`, bouton `background:var(--bg)`) ; `broken.html` (script qui lève une exception + `<script src="https://cdn.invalid/x.js">`) ; `repeated.html` (300 boutons identiques + 1 différent).

```js
test('basic page yields typed candidates', async () => {
  const r = await extractPage(fx('basic.html'));
  assert.equal(r.status, 'ok');
  const kinds = r.candidates.map(c => c.kind);
  for (const k of ['control','card','icon','nav']) assert.ok(kinds.includes(k), k);
});
test('JS-generated segmented control is captured with ancestor shell', async () => {
  const r = await extractPage(fx('js-generated.html'));
  const seg = r.candidates.find(c => c.kind === 'segmented');
  assert.ok(seg);
  assert.match(seg.html, /class="ca-body/);
  assert.equal(r.candidates.filter(c => c.kind === 'control').length, 0); // la fixture n'a que les boutons du segmented : ils sont repliés
});
test('dark metrics differ and scoped CSS reproduces original colors', async () => {
  const r = await extractPage(fx('dark-tokens.html'));
  const b = r.candidates.find(c => c.tag === 'button');
  assert.notEqual(b.metrics.light.bg, b.metrics.dark.bg);
  // fidélité : rendre b.html dans un shadow root avec r.styles.css (page vide, Playwright), thème forcé light puis dark,
  // la couleur de fond calculée du bouton == b.metrics.light.bg / b.metrics.dark.bg
});
test('broken page does not throw', async () => {
  const r = await extractPage(fx('broken.html'), { timeoutMs:5000 });
  assert.ok(['ok','error'].includes(r.status));
});
test('repeated elements are deduped before the cap', async () => {
  const r = await extractPage(fx('repeated.html'), { maxCandidates:5 });
  const buttons = r.candidates.filter(c => c.tag === 'button');
  assert.equal(buttons.length, 2);
  assert.equal(Math.max(...buttons.map(b => b.occurrences)), 300);
});
test('font-face rules go to fontFaceCss', async () => { /* fixture basic.html contient un @font-face data-URI */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `detect.js`, `browser.mjs`, `extract-page.mjs`. Chargement : `page.setContent(html, {waitUntil:'networkidle', timeout})`, une erreur de navigation ou un timeout donnent `status:'error'` avec le message, mais si le DOM existe on extrait quand même. Les feuilles de style cross-origin illisibles via CSSOM (Google Fonts) sont gardées en `fontLinks`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(atlas): render and extract components from artifact pages`

---

### Task 5: Extraction d'un Design System

**Files:**
- Create: `scripts/extract-ds.mjs`, `tests/fixtures/ds/project/{design-system.json,tokens.json,components/bundle.css,components/Button/README.md,components/Button/preview.html,components/Toggle/README.md,components/Toggle/preview.html,components/Cover/preview.html}`
- Test: `tests/extract-ds.test.mjs`

**Interfaces:**
- Consumes: `tokensToCss` (Task 2), internes de `extract-page.mjs` (rendu, mesure, `serializeScoped`). Factoriser dans `extract-page.mjs` une fonction exportée `extractFromHtmlString(html:string, opts & {wholeBody?:boolean})` utilisée par les deux.
- Produces: `extractDesignSystem(rawDir:string, opts?): Promise<{status, error?, styles:Styles, candidates:Candidate[]}>` ; CLI `node scripts/extract-ds.mjs <rawDir>` → mêmes fichiers que Task 4.

Comportement : pour chaque `components/<Comp>/preview.html` sauf `Cover`, composer un document = `tokens.css` s'il existe sinon `tokensToCss(tokens.json)` + `bundle.css` + polices de `tokens.json` (`type.fonts[].file` → `@font-face` en data URI depuis `project/fonts/`, familles Google en lien) + `bundle.js` et bibliothèques de `design-system.json.libraries` (jsDelivr, versions exactes) + le preview. Un candidat `kind:'ds'` par composant (`html` = corps entier du preview dans `.ca-body`, `presetName` = `<Comp>`, `description` = 1re phrase du README, `context` = groupe de `@dsCard group="…"`) ; les contrôles internes détectés deviennent des candidats `measureOnly:true` avec `parentIndex`.

- [ ] **Step 1: Write the failing tests**

```js
test('one ds tile per component, Cover skipped, metadata from source', async () => {
  const r = await extractDesignSystem(fx('ds'));
  const tiles = r.candidates.filter(c => c.kind === 'ds');
  assert.deepEqual(tiles.map(t => t.presetName).sort(), ['Button','Toggle']);
  assert.equal(tiles.find(t => t.presetName === 'Button').context, 'Actions');
  assert.match(tiles.find(t => t.presetName === 'Button').description, /^[^.]+\.$/);
});
test('inner controls are measureOnly and linked to their tile', async () => {
  const r = await extractDesignSystem(fx('ds'));
  const inner = r.candidates.filter(c => c.measureOnly);
  assert.ok(inner.length >= 1);
  assert.ok(inner.every(c => r.candidates[c.parentIndex].kind === 'ds'));
});
test('tokens reach the render (button bg equals token value)', async () => { /* --brand:#2f6bff dans tokens.json → metrics.light.bg === '#2f6bff' */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS (y compris les tests de Task 4 après factorisation).
- [ ] **Step 5: Commit** `feat(atlas): extract components from Design System artifacts`

---

### Task 6: Fusion, déduplication, projets → `data.json`

**Files:**
- Create: `scripts/build.mjs`, `seed/projects.louis.json`
- Test: `tests/build.test.mjs`

**Interfaces:**
- Consumes: `componentKey`, `validateClassified`, `TAXONOMY`, `loadJson/saveJson`.
- Produces: `buildData({dir:string, now:string}): Data` et CLI `node scripts/build.mjs [--dir .component-atlas]` qui écrit `dist/data.json`, `dist/index.html` (Task 7 fournit l'inlining ; ici `index.html` peut être absent), met à jour `cache.json` (`updated`/`status` de chaque artifact traité, suppression des `removed`) et `projects.json`.

```ts
type Data = {
  generatedAt:string,
  taxonomy:{slug,label}[],
  artifacts:{ id, url, title, updated, project, kind, status:'ok'|'error'|'skipped', note?:string, componentCount:number }[],
  styles:{ [artifactId]: { css:string, fontLinks:string[], fontIds:string[] } },
  fonts:{ [fontId:string]: string },            // fontId = sha1(fontFaceCss d'une règle)
  components:{ key, type, name, project, isDS:boolean, description?:string,
               sources:{ artifactId, occurrences }[], occurrences:number,
               artifactId:string, html:string, metrics:{light:Metrics,dark:Metrics}, colors:string[],
               measureOnly?:boolean }[],
  notes:string[]
}
```

Règles : on ne garde que les `items` `keep:true` d'un `classified.json` valide (sinon l'artifact passe en `error` avec les messages de `validateClassified`) ; un candidat `ds` garde `presetName` comme `name` ; les `measureOnly` sont gardés (pour Nuancier/Mesures) avec le `type` du classifieur ou `other`. Fusion inter-artifacts par `componentKey(html, metrics.light)` : la première occurrence (artifact le plus récent) porte `html`/`artifactId`, `sources` liste tout le monde, `occurrences` = somme. `project` : `projects.json[id]`, sinon `classified.project` (puis écrit dans `projects.json`) ; une valeur existante dans `projects.json` n'est jamais écrasée. Au premier run, si `projects.json` est absent, il est initialisé avec les entrées de `seed/projects.louis.json` dont l'id figure dans l'inventaire. Polices : chaque règle `@font-face` isolée, hashée, stockée une fois dans `fonts` ; une règle > 2 000 000 caractères est retirée et une note ajoutée dans `notes` (« Police <famille> retirée (trop lourde) — <titre de l'artifact> »). Le build refuse d'écrire si `data.json` dépasse 15 Mo et liste les plus gros artifacts.

`seed/projects.louis.json` : les 94 couples id → projet de `mindmap.html` (tableau `P`), générés une fois par un petit script Node jetable, non commité.

- [ ] **Step 1: Write the failing tests** (dossier `.component-atlas` temporaire construit dans le test, 3 artifacts : une page, un DS, un `other-type`)

```js
test('merges identical components across artifacts', () => { /* même html+metrics dans a et b → 1 composant, sources.length 2, occurrences = somme */ });
test('keeps only keep:true items and uses DS preset names', () => { /* ... */ });
test('invalid classified.json marks artifact error, others survive', () => { /* ... */ });
test('other-type artifact is listed as skipped with 0 components', () => { /* ... */ });
test('projects.json manual edits are preserved', () => { /* projects.json {a:"Perso"} + classified.project "Nimb" → "Perso" */ });
test('seed only applies to inventory ids when projects.json is missing', () => { /* ... */ });
test('removed artifacts disappear from data and cache', () => { /* plan.removed = ['z'] → absent de data.artifacts et de cache.json */ });
test('fonts deduped by hash and oversized faces dropped with a note', () => { /* deux artifacts même @font-face → 1 entrée ; une face de 2,1 M caractères → absente + note */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(atlas): merge, dedupe and project grouping into data.json`

---

### Task 7: Galerie — rendu des tuiles, vue Par type, fiche, filtres

**Files:**
- Create: `gallery/index.template.html`, `gallery/src/tile.mjs`, `gallery/src/logic.mjs`, `gallery/src/views.mjs`, `gallery/src/main.mjs`, `tests/fixtures/data.sample.json`
- Modify: `scripts/build.mjs` (fonction `inlineGallery(): string` → `dist/index.html`), `scripts/extract-page.mjs` (`renderContactSheet`)
- Test: `tests/gallery-logic.test.mjs`, `tests/gallery-smoke.test.mjs`

**Interfaces:**
- Consumes: forme `Data` (Task 6).
- Produces:
  - `mountSnippet(host:HTMLElement, {html:string, css:string, theme:'auto'|'light'|'dark'}): void` : `attachShadow`, `CSSStyleSheet` construit une fois par `artifactId` et partagé via `adoptedStyleSheets`, `data-theme` posé sur l'hôte si forcé. Les `fontLinks` et `fonts` sont injectés une seule fois dans le `<head>` du document.
  - `filterComponents(components, {types?:Set, projects?:Set, q?:string, since?:string, includeMeasureOnly?:boolean=false})` ; `groupByTypeThenProject(components, taxonomy): {type, label, projects:{project, items}[]}[]` (ordre de la taxonomie, projets triés par nombre décroissant, types vides omis).
  - `renderContactSheet(candidates, styles, outPath, browser)` : planche des snippets numérotés (via `mountSnippet`), capture PNG.
  - Routage par hash : `#types` (défaut), `#matrice`, `#couleurs`, `#mesures`, `#c-<key8>` (fiche).

Contenu : en-tête (nom « Component Atlas », nombre de composants, d'artifacts et de projets, date de génération), barre de filtres (projet, type, recherche, période), onglets des 4 vues. Vue Par type : une section par type, sous-sections par projet, tuiles = rendu vivant + nom + projet + « ×N » si N > 1 + badge « DS ». Fiche : grand rendu, bascule Auto/Clair/Sombre, lien vers l'artifact source (et autres sources), mesures clair/sombre, HTML et CSS copiables (deux boutons Copier : le snippet, et le CSS scopé de l'artifact source ; `navigator.clipboard.writeText` avec repli sur sélection). Section repliable « Non analysés » listant les artifacts `skipped`/`error` avec leur note. Design : les règles de page de l'artifact-design (tokens sur `:root` + deux blocs sombres, gouttière `max(16px, env(safe-area-inset-*))`, mobile 400 px sans scroll horizontal) ; la galerie reste visuellement neutre pour ne pas concurrencer les composants.

- [ ] **Step 1: Write the failing tests**

```js
// gallery-logic.test.mjs
test('filterComponents', () => { /* par type, projet, q insensible à la casse et aux accents sur name+project, measureOnly exclus par défaut */ });
test('groupByTypeThenProject follows taxonomy order and omits empty types', () => { /* ... */ });
// gallery-smoke.test.mjs (Playwright, dist construit depuis data.sample.json servi en http local)
test('gallery renders tiles with no console errors, at desktop and 400px', async () => {
  // chaque .tile a un shadowRoot dont le premier enfant mesure > 0×0 ; aucun message console 'error' ;
  // document.documentElement.scrollWidth <= innerWidth à 400 px
});
test('forcing dark on a tile changes the component background', async () => { /* ... */ });
test('#c-<key8> opens the detail view', async () => { /* ... */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `inlineGallery` concatène `tile`, `logic`, `views`, `main` (lignes `import` supprimées, mot-clé `export` retiré) dans un `<script>` à la place de `<!--APP-->`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(atlas): gallery shell, live tiles, by-type and detail views`

---

### Task 8: Galerie — Matrice, Nuancier, Mesures

**Files:**
- Modify: `gallery/src/logic.mjs`, `gallery/src/views.mjs`, `gallery/src/main.mjs`
- Test: `tests/gallery-logic.test.mjs`, `tests/gallery-smoke.test.mjs`

**Interfaces:**
- Produces:
  - `matrixCounts(components, taxonomy, projects): {rows:type[], cols:project[], cells:number[][], max:number}` (compte les composants non `measureOnly`, pondérés par 1, pas par occurrences).
  - `colorPoints(components, theme:'light'|'dark'): {hex, h, s, l, keys:string[]}[]` (couleurs `bg`/`fg`/`border` uniques ; tous composants, `measureOnly` inclus).
  - `metricSeries(components, type, metric:'height'|'radius'|'fontSize'|'paddingX'|'paddingY'): {value:number, keys:string[]}[]` (valeurs arrondies au px, triées).

Vues : **Matrice** (heatmap SVG type × projet, intensité séquentielle sur `max`, compte écrit dans chaque case non vide, clic → `#types` filtré sur ce type et ce projet). **Nuancier** (nuage SVG teinte en x × luminosité en y, pastilles à la vraie couleur avec un contour pour les couleurs proches du fond, bascule clair/sombre ; survol/focus → liste des composants qui l'utilisent sous le nuage). **Mesures** (sélecteur de type, défaut `button` ; pour chaque métrique un strip plot SVG où chaque valeur distincte est un point dont la taille suit le nombre de composants ; survol → aperçus des composants ; libellé « N valeurs différentes »). Charger la skill `dataviz` avant d'écrire ces vues et en suivre la méthode (échelles, couleurs de texte depuis les tokens, deux thèmes).

- [ ] **Step 1: Write the failing tests**

```js
test('matrixCounts', () => { /* 2 types × 2 projets, cellule vide = 0, max correct, measureOnly ignorés */ });
test('colorPoints dedupes and maps keys', () => { /* même #fff sur 2 composants → 1 point, keys.length 2 ; null ignoré */ });
test('metricSeries groups rounded values', () => { /* heights 36, 36.4, 46 → [{36,[a,b]},{46,[c]}] */ });
test('matrix cell click filters the by-type view', async () => { /* smoke Playwright */ });
```

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(atlas): matrix, swatches and metrics views`

---

### Task 9: Skill d'orchestration + premier run réel

**Files:**
- Create: `skills/component-atlas/SKILL.md`, `plugins/component-atlas/README.md`
- Test: run réel sur le compte de Louis (pas de test automatisé : l'outil Artifact n'existe que dans Claude Code)

**Interfaces:**
- Consumes: tous les CLI (`plan.mjs`, `extract-page.mjs`, `extract-ds.mjs`, `build.mjs`) et les formats de fichiers ci-dessus.

`SKILL.md` (frontmatter `name: component-atlas`, description déclenchée par « cartographie / atlas / inventaire des composants de mes artifacts ») décrit, dans l'ordre :
1. Prérequis : vérifier `node --version` ≥ 18 et que Playwright se charge (sinon expliquer `npm i -D playwright && npx playwright install chromium`, puis s'arrêter).
2. Inventaire : `Artifact list` scope `mine`, `limit` 200, toutes les pages (`page_token`) → écrire `inventory.json`. Puis `node <plugin>/scripts/plan.mjs`.
3. Pour chaque id de `toProcess` (en parallèle par lots de 8 via sous-agents qui ne renvoient qu'un statut court) : `Artifact read` sans `path` uniquement pour connaître la nature (le texte d'en-tête dit « Created from the Artifact type <url> » ou « raw HTML follows ») ; écrire `meta.json`. Page : `read` avec `path:"index.html"`, `out_dir: raw/<id>`, puis `extract-page.mjs`. Design System : `list` scope `files`, puis `read` avec `paths` = fichiers sous `project/` sauf `project/assets/`, puis `extract-ds.mjs`. Autre type : `kind:'other-type'`, rien d'autre. Le HTML ne doit jamais être affiché dans la conversation : le sous-agent lit l'en-tête, pas le corps.
4. Classification : sous-agents par lots de 8 artifacts. Chacun lit `contact.png` et une version compacte de `candidates.json` (index, kind, tag, text, context, presetName, occurrences ; jamais `html`) et écrit `classified.json` : projet (en réutilisant les noms déjà présents dans `projects.json`), puis pour chaque candidat `keep`, `type` de la taxonomie (avec sa liste exacte) et un `name` court tiré du contexte (preset conservé pour les DS). Règle : rejeter les doublons visuels, les éléments de mise en page et les contrôles de démo de la page elle-même (sélecteur de thème, etc.). Valider avec `validateClassified` (une seule reprise en cas d'erreur).
5. `node <plugin>/scripts/build.mjs`.
6. Publication : `Artifact publish` `file_path` = `dist/index.html`, `files` = `{"data.json": "dist/data.json"}`, `url` = `cache.galleryUrl` s'il existe, sinon premier publish avec `icon: "grid"` et `description`, puis enregistrer l'URL dans `cache.json`.
7. Compte rendu au designer : lien, chiffres (composants, artifacts analysés/non analysés/en erreur), trois constats tirés de la vue Mesures, et rappel que la galerie est privée (partage par le menu Share).

- [ ] **Step 1:** Écrire `SKILL.md` et `README.md` (installation : `/plugin marketplace add mainneat/braude` puis `/plugin install component-atlas`).
- [ ] **Step 2:** Run d'essai sur 3 artifacts (« Nimb switches » `2nphJ7McYhgAN8n8UH8nuK`, « Hyperbeat DS 2.0 » `A4S58UgDUdvGZz7FfijDJz`, « Hyperbeat Prototype » `VeZvzc6PDjR83HMnMmGoi2`) avec un `inventory.json` réduit. Attendu : les 6 styles de switch de Nimb apparaissent sous Segmented control / tabs avec des noms proches de « Glass pill », « Hairline pill »… ; les composants du DS portent le badge DS ; aucune erreur console sur la galerie (une vérification visuelle).
- [ ] **Step 3:** Corriger ce que le run d'essai révèle (avec un test de non-régression dans la task concernée pour chaque bug de code).
- [ ] **Step 4:** Run complet sur les 94 artifacts, publication de la galerie, puis un second run immédiat qui doit annoncer 0 artifact à retraiter et republier sur la même URL.
- [ ] **Step 5: Commit** `feat(atlas): orchestration skill and first full run` puis push sur `claude/ecstatic-volta-ccyt0d`.

---

### Task 10: Artifacts de type Design + typage automatique des measureOnly

(Ajoutée après l'essai réel ; voir l'amendement de la spec.)

**Files:**
- Create: `scripts/extract-design.mjs`, `tests/extract-design.test.mjs`, `tests/fixtures/design/project/...`
- Modify: `scripts/lib/schema.mjs` (validateClassified n'exige que les index non-measureOnly), `scripts/build.mjs` (type automatique des measureOnly), `skills/component-atlas/SKILL.md` (kind `design`, lecture des fichiers, projection sans measureOnly)

**Interfaces:**
- Produces: `extractDesign(rawDir, opts?): Promise<{status,error?,warnings,styles,candidates}>` + CLI `node scripts/extract-design.mjs <rawDir>` (mêmes fichiers de sortie que les autres extracteurs) ; `autoType(candidate): TypeSlug` ; `validateClassified(data, candidates)` accepte désormais le tableau de candidats (ou un compte) et n'exige un item que pour les candidats non `measureOnly`.

Comportement : le format `.dc.html` et `canvas.json` sont décrits dans `artifact-type/reference/format.md` de l'artifact Design (à lire via l'outil Artifact). Chaque planche est rendue dans Chromium avec ce dont elle dépend (CSS du projet, tokens du DS embarqué sous `project/ds/…`, polices), sans le runtime de l'éditeur si possible ; détection standard (pas `wholeBody`) ; `context` préfixé par le titre de la planche (depuis `canvas.json`, à défaut le nom de fichier) ; candidats de toutes les planches fusionnés, dédoublonnés par `componentKey`, index recalculés ; une seule feuille `styles` pour l'artifact. `meta.json.kind = 'design'`. Une planche qui échoue → warning, les autres continuent.

- [ ] Tests : fixture Design minimale (2 planches + canvas.json + css partagé) → candidats des deux planches, contexte préfixé, dédoublonnage inter-planches, planche cassée → warning ; `autoType` (button→button, input text→input, role switch→toggle, segmented→segmented, svg→icon, card→card, nav→navigation, sinon other) ; validateClassified sans items measureOnly ; build type les measureOnly via autoType.
- [ ] Implémentation, `npm test` vert, sanity check sur la copie réelle de « Hyperbeat Prototype ».
- [ ] Commit `feat(atlas): extract Design canvas artifacts; auto-type measure-only candidates`
