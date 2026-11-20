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
> 1. `Artifact list` avec `scope:"files"` et `url` → lis le résultat : une ligne d'en-tête `... an Artifact of type "<Nom du type>" ...` indique un artifact typé ; pour une page simple, le résultat est `none — single page with no separately published files`. Nature : typé + `"Design System"` → `design-system` ; en-tête `an Artifact of type "Design"` → `design` (canevas d'artboards `project/*.dc.html` + `project/canvas.json`) ; typé avec un autre nom (ex. "Slides", "Docs") → `other-type` avec `typeName` = ce nom ; `none — single page` → `page`. Si le résultat est inexploitable, repli : `Artifact read` avec `url` seul, dont l'en-tête dit "Created from the Artifact type <url>" (typé) ou "raw HTML follows" (page) ; le type Design System est `https://claude.ai/artifact/5M7UeXXcx16TP3vzVFNDzd`.
> 2. Crée `D/raw/<id>/` et écris `D/raw/<id>/meta.json` = `{"id","url","title","updated","kind","typeName"?}` avec `kind` = `"page"`, `"design-system"`, `"design"` (mets `typeName:"Design"`) ou `"other-type"` (autre type d'artifact : Slides, Docs, Data, Whiteboard, Sheets ; mets `typeName`). Pour `other-type`, rien d'autre.
> 3. Page : `Artifact read` avec `url`, `path:"index.html"`, `out_dir:"D/raw/<id>"` (chemin absolu), puis `node "<base>/../../scripts/extract-page.mjs" D/raw/<id>`.
> 4. Design System : `Artifact read` avec `url` et `paths` = tous les fichiers listés sous `project/` sauf `project/assets/` (256 max par appel, découpe sinon), `out_dir:"D/raw/<id>"`, puis `node "<base>/../../scripts/extract-ds.mjs" D/raw/<id>`.
> 5. Design : `Artifact read` avec `url`, `out_dir:"D/raw/<id>"` et `paths` = tous les fichiers listés sous `project/` **sauf** les images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, `.mp4`) et les dossiers qui n'en contiennent que (ex. `project/audit/`), **plus** `artifact-type/dc-runtime.js` (indispensable : c'est le runtime qui résout gabarits, `{{…}}`, `<sc-for>`/`<sc-if>` et `<dc-import>` ; ne prends aucun autre fichier de `artifact-type/`). 256 chemins max par appel : découpe en plusieurs appels sinon. Puis `node "<base>/../../scripts/extract-design.mjs" D/raw/<id>` (une à trois minutes pour une centaine de planches).
> 6. Si une étape échoue (lecture, extraction), consigne `erreur` avec la raison en une ligne et passe au suivant : un artifact en échec ne doit jamais bloquer le lot.

Les scripts écrivent `candidates.json`, `styles.json`, `contact.png` (et `contact-2.png`, `contact-3.png`…, une planche par ~2200 px), `contact.json` (pour chaque planche : `file`, `from`, `to` = plage d'index des tuiles) et `extract.json` dans `raw/<id>/`. Les artifacts `other-type` ou en erreur n'ont pas de classification.

## 4. Classification (sous-agents)
Seuls les artifacts `ok` qui ont un `candidates.json` non vide (sans candidat, ne classe rien : le build les accepte vides). Lots de 8, un sous-agent par lot, en parallèle. **Exception : chaque artifact `design` a son propre sous-agent** (jusqu'à 250 candidats). Compte ses candidats à classer :
`node -e "console.log(require('./D/raw/<id>/candidates.json').filter(x=>!x.measureOnly).length)"`
S'il y en a **plus de 150**, découpe les index en plages d'environ 100 (ex. 0–99, 100–199, 200–249) et lance un sous-agent par plage, en parallèle : chacun ne traite que sa plage et ne lit que les planches dont `[from, to]` (dans `D/raw/<id>/contact.json`) recoupe sa plage. Ajoute au prompt type, en tête et en clair : **« Mode plage A–B : écris `D/raw/<id>/classified.part<k>.json` (pas classified.json), même format, un item pour chaque index de A à B ; ne lance pas la validation. »** (k = 1, 2, 3…, même règle de projet). Ensuite, dans la conversation principale : `node "<base>/../../scripts/merge-classified.mjs" D/raw/<id>` (fusionne les parties en `classified.json` et valide ; s'il affiche des erreurs, relance un sous-agent pour les index manquants dans une nouvelle partie, puis refusionne une fois).

Prompt type :

> Pour chaque artifact `<id>` du lot :
> 1. **Obligatoire** : regarde avec l'outil Read les planches-contact listées dans `D/raw/<id>/contact.json` (`contact.png`, `contact-2.png`…, tuiles numérotées par index) : toutes, ou pour une plage d'index, celles dont `[from, to]` la recoupe. Le texte seul ne suffit pas : c'est l'image qui révèle les tuiles vides, cassées ou qui ne sont que de la mise en page, à rejeter.
> 2. Lis une version compacte des candidats à classer, jamais le HTML ; les candidats `measureOnly` (mesures internes, typés automatiquement) sont exclus (pour une plage, ajoute `&&x.index>=A&&x.index<=B` au filtre) :
>    `node -e "const c=require('./D/raw/<id>/candidates.json');const t=(s)=>s&&String(s).slice(0,80);console.log(JSON.stringify(c.filter(x=>!x.measureOnly).map(({index,kind,tag,role,text,context,presetName,occurrences})=>({index,kind,tag,role,text:t(text),context:t(context),presetName,occurrences}))))"`
>    (`text` et `context` sont tronqués à 80 caractères.)
> 3. Lis les noms de projets existants : valeurs de `D/projects.json` s'il existe, sinon de `<base>/../../seed/projects.louis.json`.
> 4. Écris `D/raw/<id>/classified.json` = `{"project":"…","items":[{"index":0,"keep":true,"type":"button","name":"…"}]}` avec **un item pour chaque index affiché à l'étape 2** (chaque candidat non `measureOnly`). Pour un artifact Design, `context` commence par le titre de la planche (artboard).
>
> Règles :
> - `project` : réutilise un nom existant quand l'artifact en relève ; sinon un nom court nouveau.
> - `type` : exactement un de ces slugs (libellé entre parenthèses) :
>   `button` (Button), `icon-button` (Icon button), `toggle` (Toggle / switch), `segmented` (Segmented control / tabs), `checkbox-radio` (Checkbox / radio), `input` (Input / search), `select` (Select / dropdown), `slider` (Slider), `card` (Card), `chip` (Chip / tag / badge), `avatar` (Avatar), `icon` (Icon), `navigation` (Navigation), `list-item` (List item / row), `overlay` (Modal / sheet / popover), `toast` (Toast / banner), `chart` (Chart / data viz), `other` (Autre).
> - `keep:false` pour : wrappers de mise en page, chrome de page (en-têtes, pieds, titres), contrôles de démo de la page elle-même (sélecteur de thème du showcase, etc.), tuiles vides ou cassées sur la planche. Mets quand même un `type` valide (`other`).
> - Doublons : des tuiles identiques (même rendu, même libellé), y compris dans toute ta plage d'index (ex. le même bouton Close / Dismiss répété sur chaque modale) → garde **un** représentatif (`keep:true`), `keep:false` pour les autres. Des variantes réellement différentes (taille, état, couleur) se gardent toutes.
> - Cartes conteneurs : une carte qui regroupe plusieurs composants déjà gardables (boutons, champs, puces…) n'est gardée que si elle est elle-même un composant dessiné (ex. une carte produit, une carte de transfert) ; un simple panneau ou une section qui les range → `keep:false`.
> - Fondations de Design System : les aperçus de palette, grille, échelle typographique, espacements, couleurs, rayons, ombres, iconographie en planche (Palette, Grid, TypeScale, Spacing, Colors…) ne sont pas des composants → `keep:false`.
> - `name` : court (2-4 mots), tiré du contexte, dans la langue de l'artifact. Pour un composant de Design System, garde `presetName` tel quel.
> - Valide : `node "<base>/../../scripts/validate-classified.mjs" D/raw/<id>`. S'il affiche des erreurs (exit 1), corrige et revalide **une seule fois**.
> Renvoie une ligne par artifact : `id | projet | N gardés / M | ok ou erreur`.

## 5. Build
`node "<base>/../../scripts/build.mjs" --dir .component-atlas`
Produit `D/dist/index.html`, `D/dist/data.json` (filtres, matrice, couleurs, mesures, légendes : ni HTML ni CSS), une part par artifact `D/dist/a/<artifactId>.json` (HTML de ses composants et son CSS, chargés à la demande par la galerie ; découpée en `a/<id>-2.json`… au-delà de 4 Mo) et met à jour `cache.json` et `projects.json`. `dist/a/` est vidé à chaque build : il ne contient que les parts courantes. Si le build échoue (ex. data.json > 15 Mo), explique le message à l'utilisateur et arrête-toi.

## 6. Publication
1. Plan des appels : `node "<base>/../../scripts/publish-plan.mjs" --dir .component-atlas`. Il affiche une liste JSON de lots `[{"file_path": "<abs>/dist/index.html", "files": {"data.json": "<abs>", "a/<id>.json": "<abs>", "a/<ancien>.json": null, …}}, …]` : au plus 250 fichiers et 60 Mo par lot (limites d'un publish : 255 fichiers, 64 Mo). Le premier lot porte `data.json`, les premières parts et les retraits (`null` = part publiée auparavant, d'un artifact supprimé ou redécoupé, à retirer) ; les suivants ajoutent les parts restantes. S'il échoue (galerie > 511 fichiers ou 256 Mo), relaie le message et arrête-toi.
2. Lis `D/cache.json` pour `galleryUrl`. Pour chaque lot, **dans l'ordre**, appelle `Artifact` (publish) avec exactement son `file_path` et son `files` (tel quel, `null` compris), et :
   - premier lot : `url` = `galleryUrl` s'il est non nul (mise à jour sur place) ; sinon premier publish : sans `url`, avec `icon:"grid"` et `description` (une phrase, ex. "Atlas visuel des composants de mes artifacts claude.ai") ;
   - lots suivants : `url` = l'URL renvoyée par le premier lot (les fichiers omis sont conservés, ceux du lot sont ajoutés).
   Si un lot échoue, réessaie-le une fois ; s'il échoue encore, arrête-toi et signale-le (la galerie s'affiche, les tuiles des parts manquantes montrent « Rendu indisponible »).
3. Une fois **tous** les lots publiés, enregistre l'URL et les parts en ligne (sert aux retraits du prochain run) :
   `node "<base>/../../scripts/publish-plan.mjs" --dir .component-atlas --done "<URL>"`

## 7. Compte rendu au designer
Calcule les chiffres depuis `D/dist/data.json` avec `node -e` (ne l'affiche jamais en entier) : `components.length`, et `artifacts` par `status` (ok = analysés, skipped = non analysés, error = en erreur). Pour les erreurs, cite titre + note.
Donne :
1. Le lien de la galerie.
2. Les chiffres : composants, artifacts analysés / non analysés / en erreur.
3. Trois constats tirés des mesures (vue Mesures), calculés sur `components[].metrics.light` : par exemple le nombre de hauteurs de bouton distinctes, de rayons ou de familles de police distincts, et la dispersion des paddings. Formule-les en clair ("12 hauteurs de bouton différentes entre 28 et 56 px").
4. Rappel : la galerie est **privée** ; pour la partager, utiliser le menu Share de l'artifact. Les projets se corrigent dans `.component-atlas/projects.json` (voir le README du plugin), puis relancer le skill.

Un second run sans changement doit annoncer 0 artifact à retraiter et republier sur la même URL.
