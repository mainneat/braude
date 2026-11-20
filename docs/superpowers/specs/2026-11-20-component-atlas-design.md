# Component Atlas — conception

Date : 2026-11-20 · Statut : brouillon à valider

## Intention

Les designers produisent beaucoup d'interfaces dans Claude Code sous forme d'artifacts claude.ai (Louis en a 94). Les composants dessinés (boutons, cards, toggles, icônes, inputs…) sont éparpillés dans ces pages et personne n'en a de vue d'ensemble.

Component Atlas donne à un designer, connecté avec son propre compte Claude, une **cartographie visuelle de tous les composants qu'il a dessinés** : chaque composant affiché tel qu'il est réellement dessiné (pas une capture approximative), rangé par type et par projet, avec des vues de data visualization pour comparer et repérer les incohérences.

Public : des designers. Ce qu'ils doivent pouvoir faire, c'est **voir le design des composants**.

## Objectifs

1. Une seule commande dans Claude Code (`/component-atlas`) parcourt tous les artifacts du compte connecté, sans export manuel.
2. Chaque composant extrait se rend fidèlement (mêmes CSS, polices, tokens, thèmes clair et sombre).
3. Les composants sont classés par type (taxonomie ci-dessous), nommés, rattachés à leur artifact et à leur projet.
4. Le résultat est publié comme un artifact privé dans le compte du designer : une galerie navigable avec des vues de comparaison.
5. Relancer la commande ne retraite que les artifacts nouveaux ou modifiés et met à jour la même galerie (même URL).

## Non-objectifs (v1)

- Interactivité des composants : on montre l'état rendu au chargement (un toggle s'affiche mais ne bascule pas). Les états hover et focus ne sont pas capturés.
- Édition des composants, export Figma, génération de code réutilisable.
- Galerie partagée par équipe ou consolidation de plusieurs designers (c'est la v2, l'approche « C »).
- Sources autres que les artifacts claude.ai (repos, Figma).
- Artifacts créés à partir d'autres types (Slides, Design canvas, Docs, Data) : listés dans la galerie comme « non analysés », sans extraction.

## Anti-objectifs (échec même si ça « marche »)

- Des composants re-stylés ou approximés : un designer verrait tout de suite que ce n'est pas son dessin.
- Une galerie noyée sous des faux positifs (chaque `div` traité comme une card). Mieux vaut moins de composants mais justes.
- Exposer les designs : la galerie reste privée par défaut ; le partage se fait par le menu Share, au choix du designer.
- Exiger que le designer exporte ou colle ses artifacts à la main.

## Contraintes constatées

- **Pas d'API externe** pour lire les artifacts d'un compte. L'accès passe par l'outil Artifact de Claude Code (`list` scope `mine` paginé, `read`), avec la session claude.ai du designer. C'est ce qui fait office de « connexion avec son compte Claude ».
- **Deux familles d'artifacts** :
  - *Pages HTML classiques* : les composants sont souvent générés par JS au chargement (ex. « Nimb switches » construit ses switches via `innerHTML`). Une analyse statique du HTML ne suffit pas : **il faut rendre la page dans un navigateur headless**. Les pages chargent polices et scripts depuis des CDN (Google Fonts, cdnjs, jsDelivr), il faut donc un accès réseau.
  - *Artifacts de type Design System* : le contenu vit dans `project/` : `design-system.json` (index), `tokens.json`, `components/<Comp>/README.md` et `components/<Comp>/preview.html`, `components/bundle.css` et `bundle.js`. Ici les composants sont déjà nommés et documentés : **on reprend leur nom, leur groupe et leur description tels quels**, sans heuristique de détection.
- **Contexte de Claude** : lire 94 pages HTML en entier dans la conversation est impraticable. Les contenus doivent être enregistrés sur disque (`read` avec `path`) et traités par script et/ou par sous-agents, pas collés dans le contexte principal.
- **Galerie publiée** : CSP des artifacts (scripts uniquement depuis les CDN autorisés, styles depuis Google Fonts uniquement, le reste inline ou en fichiers publiés à côté), 16 Mo par page, données volumineuses en fichiers `.json` publiés à côté et chargés par `fetch` relatif.
- **Prérequis côté designer** : Claude Code connecté à claude.ai (outil Artifact disponible), Node 18+, Chromium via Playwright.

## Approches envisagées

| | Approche | Pour | Contre |
|---|---|---|---|
| **A (retenue)** | Commande Claude Code qui lit tous les artifacts du compte, extrait, puis publie une galerie artifact privée | Seule option qui récupère tout sans effort ; le compte Claude sert vraiment ; distribuable comme plugin | Nécessite Claude Code |
| B | Artifact web autonome où le designer dépose ses fichiers HTML ; extraction par la capacité `sample` | Un simple lien, zéro installation | La page ne peut ni lister ni récupérer les artifacts : export manuel fichier par fichier |
| C | A + galerie partagée multi-designers (capacité `db`) | Le plus complet, vue équipe | Environ deux fois plus de travail ; prévu en v2 |

Louis a choisi **A**.

## Conception

### Forme

Un plugin Claude Code dans ce repo (`plugins/component-atlas/`) contenant :
- une **skill** `component-atlas` (le mode opératoire que Claude suit) ;
- des **scripts Node** (rendu et extraction via Playwright) ;
- le **gabarit de la galerie** (HTML + JS, sans build).

### Pipeline

1. **Inventaire** : `Artifact list` (scope `mine`, toutes les pages). Pour chaque artifact : id, titre, date, version. On compare avec le cache local, et seuls les artifacts nouveaux ou modifiés passent aux étapes suivantes.
2. **Récupération** : `Artifact read` avec `path` (`index.html` pour une page classique ; fichiers `project/…` pour un Design System) pour écrire le contenu sur disque, hors contexte.
3. **Extraction**
   - *Design System* : un composant par `components/<Comp>/`. Rendu = `preview.html` avec `tokens.css` (généré par la page du type ; à défaut, dérivé de `tokens.json`), `bundle.css`, `bundle.js`, polices et bibliothèques déclarées. Nom, groupe (`@dsCard group=…`) et description (1re phrase du README) viennent de la source. *(Décision de Claude)* Ce `preview.html` est rendu dans Chromium et **figé exactement comme un snippet de page classique** : même format, même rendu en Shadow DOM, aucun `bundle.js` exécuté dans la galerie, donc pas de collision entre systèmes. **Une tuile par composant** (le preview tel que dessiné, variantes comprises) ; les éléments mesurables qu'il contient (boutons, toggles…) alimentent quand même les vues Nuancier et Mesures. Les composants de DS portent un badge « DS » et passent par la déduplication, pour que la galerie compare le système aux pages construites dessus.
   - *Page classique* : rendu dans Chromium (desktop, thème clair puis sombre). Un script repère les candidats : éléments natifs et rôles ARIA (`button`, `input`, `select`, `[role=switch|tab|checkbox|radio|slider]`), petits SVG (icônes), groupes segmentés, et conteneurs « carte » (fond ou bordure, radius, padding, contenu riche, répétés). Chaque candidat devient un **snippet autonome** :
     - le CSS de la page (stylesheets inline et liens de polices), stocké **une fois par artifact** et partagé par ses snippets ;
     - une **coquille d'ancêtres** (la chaîne de parents réduite à tag + classes + attributs utiles, sans contenu frère), pour que les sélecteurs du type `.v1 .ind` ou `.side[data-side="no"]` et les variables CSS héritées continuent de s'appliquer ;
     - le `outerHTML` de l'élément, figé après exécution du JS ;
     - ses mesures calculées (largeur, hauteur, radius, couleurs de fond, texte et bordure, police, taille, graisse) dans les deux thèmes.
   - *Tri et nommage par Claude* : pour chaque artifact, une planche-contact (capture des candidats numérotés) et le contexte proche (titres, légendes) sont soumis à Claude, en sous-agents par lots. Claude garde, rejette ou regroupe les candidats, attribue un type de la taxonomie, un nom tiré du contexte de la page (ex. « Glass pill », « Order ticket · Yes/No ») et le nom du projet.
4. **Déduplication** : composants identiques (HTML normalisé + empreinte des styles calculés) fusionnés en une entrée avec un compteur d'occurrences et la liste des artifacts sources.
5. **Publication** : `components.json` (entrées), `styles/<artifactId>.css` (CSS partagé) et la galerie, publiés avec l'outil Artifact. Première exécution : nouvel artifact privé, dont l'URL est enregistrée dans le cache. Exécutions suivantes : republication sur cette URL.

### Taxonomie (v1)

Button · Icon button · Toggle / switch · Segmented control / tabs · Checkbox / radio · Input / search · Select / dropdown · Slider · Card · Chip / tag / badge · Avatar · Icon · Navigation (bar, dock, sidebar) · List item / row · Modal / sheet / popover · Toast / banner · Chart / data viz · Autre.

### La galerie

Objectif : voir le dessin et comparer. Vues :

1. **Par type** (vue d'accueil) : une section par type, composants rendus en vrai dans une grille, sous-groupés par projet. Chaque tuile : rendu vivant, nom, projet, ×N occurrences.
2. **Matrice type × projet** : carte de chaleur des comptes. Un clic sur une case filtre la vue 1.
3. **Nuancier** : toutes les couleurs utilisées par les composants, placées par teinte et luminosité ; survoler une couleur surligne les composants qui l'utilisent.
4. **Mesures** : pour un type choisi (ex. Button), répartition des hauteurs, radius, tailles de police et paddings, chaque point étant un composant. C'est ce qui révèle les incohérences (douze hauteurs de bouton différentes, par exemple).
5. **Fiche composant** : grand rendu, bascule clair/sombre, artifact source (lien), projet, mesures, HTML et CSS copiables.

Filtres globaux : projet, type, recherche texte, période. Rendu des snippets dans un Shadow DOM, avec le CSS de l'artifact source partagé via `adoptedStyleSheets` pour rester léger malgré des centaines de tuiles. Thème de la galerie : clair et sombre selon le viewer ; chaque tuile peut forcer le thème de son composant.

### Cache et relances

Un dossier `.component-atlas/` (dans le répertoire courant du designer) conserve, pour chaque artifact, la version traitée et ses snippets, ainsi que l'URL de la galerie. Une relance ne retraite que ce qui a changé, retire les composants des artifacts supprimés et republie.

### Regroupement par projet

Proposé par Claude à partir des titres. Pour le compte de Louis, `projects.json` est **pré-rempli avec le regroupement de l'Atlas des artifacts** déjà publié (`mindmap.html` dans ce repo : 11 projets, 94 artifacts) ; Claude ne classe que les nouveaux. Pour un autre designer, Claude part de zéro. Seul le regroupement est repris de l'Atlas, pas son code. Il est enregistré dans `.component-atlas/projects.json`, modifiable par le designer, et respecté aux relances.

## Décisions prises par Claude (à vérifier)

- Composants de Design System figés comme les autres, une tuile par composant, inclus dans les métriques (voir Extraction).
- Regroupement par projet amorcé depuis l'Atlas des artifacts.
- Interface de la galerie en français.
- Galerie privée, publiée dans le compte du designer qui lance la commande.

## Laissé au constructeur

- Heuristiques exactes de détection des candidats et seuils (taille d'icône, critères de « carte »).
- Liste précise des propriétés CSS mesurées et format interne de `components.json`.
- Taille des lots de sous-agents et format de la planche-contact.
- Bibliothèque de visualisation de la galerie (SVG à la main ou bibliothèque UMD autorisée par la CSP).
- Gestion des polices embarquées en data URI volumineuses (plafond, dédoublonnage).
- Comportement si Playwright est absent en local (installation guidée ou message clair).

## Amendement du 2026-11-20 — artifacts de type Design

L'essai sur 3 artifacts a montré que les artifacts de type **Design** (canvas) contiennent l'essentiel du travail récent : « Hyperbeat Prototype » compte plus de 100 planches `project/*.dc.html`, dont des composants isolés (`c-trade-ticket`, `c-sidebar`…). Louis a choisi de les analyser aussi (ce n'est plus un non-objectif).

- Chaque planche d'un artifact Design est rendue et passée au même détecteur qu'une page classique, avec les feuilles de style du projet. Le contexte d'un candidat commence par le titre de la planche.
- Les candidats `measureOnly` (éléments mesurés à l'intérieur d'une tuile de Design System) reçoivent leur type par une règle automatique (balise, rôle, kind) et ne passent plus par la classification de Claude : un DS réel en produit des centaines.
- Les autres types (Slides, Docs, Data, Whiteboard, Sheets) restent « non analysés ».
