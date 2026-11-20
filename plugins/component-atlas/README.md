# Component Atlas

Plugin Claude Code qui cartographie les composants UI de vos artifacts claude.ai : boutons, switchs, champs, cartes, etc. Claude liste vos artifacts, en extrait les composants avec un navigateur headless, les classe (type, nom, projet) puis publie une **galerie privée** : un artifact avec recherche, filtres par type et par projet, vues de comparaison (Matrice, Couleurs, Mesures) et thème clair/sombre.

Les composants issus d'un artifact de type Design System portent un badge DS. Les artifacts d'autres types (Slides, Docs, Data...) sont listés comme « non analysés ».

## Installation

```
/plugin marketplace add mainneat/braude
/plugin install component-atlas@component-atlas-marketplace
```

## Prérequis

- Node.js 18 ou plus récent
- Playwright et Chromium, trouvés dans le plugin, le répertoire courant ou en global :

```
npm i -g playwright && npx playwright install chromium
```

(`npm i -D playwright` dans votre répertoire de travail fonctionne aussi.)

## Utilisation

Dans Claude Code, lancez `/component-atlas`, ou demandez par exemple « fais la cartographie des composants de mes artifacts ». Le premier run analyse tous vos artifacts ; les suivants ne retraitent que ceux qui ont changé et republient sur la même URL.

## Confidentialité

La galerie est publiée en **privé** : vous seul la voyez. Pour la partager, utilisez le menu Share de l'artifact. Le contenu de vos artifacts est lu par des sous-agents Claude dans votre session, puis traité localement ; seuls des résumés transitent dans la conversation principale. Rien n'est publié, hormis la galerie privée.

## Où vivent les données

Tout l'état de travail est dans `.component-atlas/`, dans le répertoire où vous lancez Claude Code (à ajouter à votre `.gitignore`) :

- `inventory.json`, `plan.json`, `cache.json` (dont l'URL de la galerie)
- `raw/<id>/` : fichiers téléchargés, candidats, captures, classification
- `projects.json` : projet de chaque artifact
- `dist/` : `index.html` et `data.json` publiés

Supprimer `cache.json` force un retraitement complet.

## Corriger les projets

`.component-atlas/projects.json` associe l'id d'un artifact (dernier segment de son URL) à un nom de projet :

```json
{ "2nphJ7McYhgAN8n8UH8nuK": "Nimb" }
```

Éditez-le à la main : vos modifications sont conservées aux runs suivants. Relancez ensuite `/component-atlas` pour reconstruire et republier.

## Développement

```
cd plugins/component-atlas && npm test
```
