---
name: component-atlas
description: Cartographie les composants UI (boutons, switchs, cartes, champs...) dessinés dans les artifacts claude.ai du designer et publie une galerie privée. Utiliser quand l'utilisateur demande une "cartographie", un "atlas", un "inventaire des composants de mes artifacts", ou en anglais a component inventory / atlas of the components in my artifacts.
---

# Component Atlas

Tu produis une galerie privée (un artifact) qui recense les composants de tous les artifacts de l'utilisateur. Réponds à l'utilisateur dans sa langue (français par défaut).

**Conventions**
- `<base>` = le "Base directory for this skill" indiqué au chargement de ce skill. Les scripts sont dans `<base>/../../scripts/`. Substitue la vraie valeur dans chaque commande.
- `D` = `.component-atlas` dans le répertoire courant (état de travail, jamais commité). Utilise son chemin absolu pour `out_dir` et `file_path`.
- **Règle de contexte critique** : `Artifact read` renvoie le texte du fichier dans le contexte de l'appelant, même avec `path` + `out_dir`. Toute lecture de contenu d'artifact (HTML, fichiers de DS, `candidates.json`) se fait donc **uniquement dans des sous-agents** (outil Agent, type general-purpose), qui ne renvoient qu'une ligne de statut par artifact. La conversation principale ne gère que : inventaire, plan, build, publication, compte rendu. Ne jamais afficher de HTML.

## 1. Prérequis
```
node "<base>/../../scripts/check.mjs"
```
Affiche `ok` si Node >= 18 et si Playwright + Chromium se lancent (résolution : plugin, répertoire courant, global). Sinon le script affiche l'erreur et la correction (`npm i -g playwright && npx playwright install chromium`) : relaie-la à l'utilisateur, puis **arrête-toi**.

## 2. Inventaire et plan
1. `Artifact list` avec `scope:"mine"`, `limit:200`. Tant que la réponse donne un `next_page_token`, rappelle avec `page_token`. Ne lis rien d'autre.
2. Écris `D/inventory.json` : `[{"id","url","title","updated"}]`. `id` = dernier segment de l'URL, `updated` = la date listée telle quelle.
3. `node "<base>/../../scripts/plan.mjs" --dir .component-atlas`. Sortie : `{toProcess, removed, unchanged}` (ids). Si `toProcess` est vide, passe directement à l'étape 5 (build + republication).

## 3. Récupération et extraction (sous-agents)
Découpe `toProcess` en lots de 8 et lance un sous-agent par lot, **en parallèle** (plusieurs appels Agent dans le même message ; au plus ~6 à la fois). Prompt type, à adapter avec les ids/urls/titres/dates du lot :

> Pour chaque artifact ci-dessous, fais ceci. Ne renvoie jamais de HTML ni de contenu de fichier : uniquement une ligne par artifact `id | kind | ok/erreur | note courte`.
> 1. `Artifact list` avec `scope:"files"` et `url` → la liste des fichiers publiés. Un Design System contient `project/design-system.json` ; une page simple ne contient que `index.html` (ou similaire). Si la liste est inexploitable, `Artifact read` avec `url` seul : l'en-tête dit "Created from the Artifact type <url>" (typé) ou "raw HTML follows" (page). Le type Design System est `https://claude.ai/artifact/5M7UeXXcx16TP3vzVFNDzd`.
> 2. Crée `D/raw/<id>/` et écris `D/raw/<id>/meta.json` = `{"id","url","title","updated","kind","typeName"?}` avec `kind` = `"page"`, `"design-system"` ou `"other-type"` (autre type d'artifact : Slides, Docs, Data, Design, Whiteboard, Sheets ; mets `typeName`). Pour `other-type`, rien d'autre.
> 3. Page : `Artifact read` avec `url`, `path:"index.html"`, `out_dir:"D/raw/<id>"` (chemin absolu), puis `node "<base>/../../scripts/extract-page.mjs" D/raw/<id>`.
> 4. Design System : `Artifact read` avec `url` et `paths` = tous les fichiers listés sous `project/` sauf `project/assets/` (256 max par appel, découpe sinon), `out_dir:"D/raw/<id>"`, puis `node "<base>/../../scripts/extract-ds.mjs" D/raw/<id>`.
> 5. Si une étape échoue (lecture, extraction), consigne `erreur` avec la raison en une ligne et passe au suivant : un artifact en échec ne doit jamais bloquer le lot.

Les scripts écrivent `candidates.json`, `styles.json`, `contact.png` et `extract.json` dans `raw/<id>/`. Les artifacts `other-type` ou en erreur n'ont pas de classification.

## 4. Classification (sous-agents)
Seuls les artifacts `ok` qui ont un `candidates.json` non vide (sans candidat, ne classe rien : le build les accepte vides). Lots de 8, un sous-agent par lot, en parallèle. Prompt type :

> Pour chaque artifact `<id>` du lot :
> 1. Lis `D/raw/<id>/contact.png` avec l'outil Read (capture de la page).
> 2. Lis une version compacte des candidats, jamais le HTML :
>    `node -e "const c=require('./D/raw/<id>/candidates.json');console.log(JSON.stringify(c.map(({index,kind,tag,text,context,presetName,occurrences})=>({index,kind,tag,text,context,presetName,occurrences}))))"`
> 3. Lis les noms de projets existants : valeurs de `D/projects.json` s'il existe, sinon de `<base>/../../seed/projects.louis.json`.
> 4. Écris `D/raw/<id>/classified.json` = `{"project":"…","items":[{"index":0,"keep":true,"type":"button","name":"…"}]}` avec **un item pour chaque index** de candidates.json.
>
> Règles :
> - `project` : réutilise un nom existant quand l'artifact en relève ; sinon un nom court nouveau.
> - `type` : exactement un de ces slugs (libellé entre parenthèses) :
>   `button` (Button), `icon-button` (Icon button), `toggle` (Toggle / switch), `segmented` (Segmented control / tabs), `checkbox-radio` (Checkbox / radio), `input` (Input / search), `select` (Select / dropdown), `slider` (Slider), `card` (Card), `chip` (Chip / tag / badge), `avatar` (Avatar), `icon` (Icon), `navigation` (Navigation), `list-item` (List item / row), `overlay` (Modal / sheet / popover), `toast` (Toast / banner), `chart` (Chart / data viz), `other` (Autre).
> - `keep:false` pour : wrappers de mise en page, chrome de page (en-têtes, pieds, titres), contrôles de démo de la page elle-même (sélecteur de thème du showcase, etc.), doublons visuels (garde le plus représentatif). Mets quand même un `type` valide (`other`).
> - `name` : court (2-4 mots), tiré du contexte, dans la langue de l'artifact. Pour un composant de Design System, garde `presetName` tel quel.
> - Valide : `node "<base>/../../scripts/validate-classified.mjs" D/raw/<id>`. S'il affiche des erreurs (exit 1), corrige et revalide **une seule fois**.
> Renvoie une ligne par artifact : `id | projet | N gardés / M | ok ou erreur`.

## 5. Build
`node "<base>/../../scripts/build.mjs" --dir .component-atlas`
Produit `D/dist/index.html`, `D/dist/data.json` et met à jour `cache.json` et `projects.json`. Si le build échoue (ex. données > 15 Mo), explique le message à l'utilisateur et arrête-toi.

## 6. Publication
Lis `D/cache.json` pour `galleryUrl`. Appelle `Artifact` (publish) avec :
- `file_path` = chemin absolu de `D/dist/index.html`
- `files` = `{"data.json": "<chemin absolu de D/dist/data.json>"}`
- `url` = `galleryUrl` s'il est non nul (mise à jour sur place). Sinon premier publish : ajoute `icon:"grid"` et `description` (une phrase, ex. "Atlas visuel des composants de mes artifacts claude.ai").

Puis enregistre l'URL renvoyée :
`node -e "const f='.component-atlas/cache.json',fs=require('fs'),c=JSON.parse(fs.readFileSync(f));c.galleryUrl='<URL>';fs.writeFileSync(f,JSON.stringify(c,null,2))"`

## 7. Compte rendu au designer
Calcule les chiffres depuis `D/dist/data.json` avec `node -e` (ne l'affiche jamais en entier) : `components.length`, et `artifacts` par `status` (ok = analysés, skipped = non analysés, error = en erreur). Pour les erreurs, cite titre + note.
Donne :
1. Le lien de la galerie.
2. Les chiffres : composants, artifacts analysés / non analysés / en erreur.
3. Trois constats tirés des mesures (vue Mesures), calculés sur `components[].metrics.light` : par exemple le nombre de hauteurs de bouton distinctes, de rayons ou de familles de police distincts, et la dispersion des paddings. Formule-les en clair ("12 hauteurs de bouton différentes entre 28 et 56 px").
4. Rappel : la galerie est **privée** ; pour la partager, utiliser le menu Share de l'artifact. Les projets se corrigent dans `.component-atlas/projects.json` (voir le README du plugin), puis relancer le skill.

Un second run sans changement doit annoncer 0 artifact à retraiter et republier sur la même URL.
