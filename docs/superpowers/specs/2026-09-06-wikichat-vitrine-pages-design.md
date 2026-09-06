# WikiChat — Vitrine produit (GitHub Pages)

**Date** : 2026-09-06  
**Statut** : accepted — implémentation en cours / livrée avec `site/`  
**Repo** : [nic01asFr/Wikichat](https://github.com/nic01asFr/Wikichat)

## Problème

Le dépôt public présente WikiChat surtout comme un système technique (README, CLAUDE.md, INSTALL). Il manque une **surface produit / utilisateur** : promesse, parcours, preuves, sans noyer le lecteur dans l’API MCP.

## Décisions

1. **Deux surfaces, deux publics**
   - Repo + README (+ docs techniques) → développeur / agent
   - GitHub Pages (vitrine) → utilisateur / curieux produit
2. **Même repo** `Wikichat` — pas de repo marketing séparé
3. **Mécanismes inspirés de Widgets Grist** (`vitrine.json` → générateur → HTML → Pages), **sans lien éditorial** ni catalogue `manifest.json`
4. **Une page produit d’abord** (ancres OK) ; pages secondaires (`/install/`, etc.) seulement si le besoin apparaît après

## Non-objectifs

- Pas de lien / section « écosystème Widgets Grist »
- Pas de manifeste catalogue Grist
- Pas de duplication de la doc technique (outils MCP, variables d’env exhaustives) sur le site
- Pas de dashboard live du service (reste local `127.0.0.1`)
- Pas de redesign du README au-delà d’un lien vers la vitrine

## Architecture

```
site/
  vitrine.json              # source éditoriale produit (unique)
  generate.mjs              # lit vitrine.json → écrit dist/
  dist/                     # artefact déployé sur GitHub Pages
    index.html
    assets/                 # aperçu, CSS inline ou fichier, favicon
.github/workflows/pages.yml # build generate + deploy dist/
```

- **Homepage** GitHub About → `https://nic01asfr.github.io/Wikichat/`
- README : une ligne en tête du type « Présentation produit : [lien] » ; le reste inchangé dans son rôle technique
- Sources versionnées : `site/vitrine.json` (+ éventuellement images sous `site/assets/`). **Ne pas éditer `site/dist/*.html` à la main** (régénérés)

## Contrat `vitrine.json` (v1)

Champs lus par le générateur (sous-ensemble du contrat Widgets Grist, un seul produit) :

| Champ | Rôle |
|-------|------|
| `nom` | Titre |
| `pitch` | 1–2 phrases valeur |
| `couleur` | Accent `#RRGGBB` |
| `tags` | Mots-clés courts |
| `depot` | URL du repo |
| `points` | `[{titre, texte}]` — ce que ça change pour l’utilisateur |
| `produit.accroche` | Phrase d’ouverture du corps |
| `produit.chiffres` | `[{valeur, libelle}]` |
| `produit.sequence` | Parcours d’usage (ex. install → register → search → spawn → close) |
| `produit.contextes` | Moments d’usage (plusieurs projets / multi-sessions / routines) + images optionnelles |
| `produit.apercu` / `demonstration` | Optionnel v1 ; captures ou scénario narratif si pas de démo live |
| `journal` | Changelog narratif court |
| `encart` | Optionnel — CTA secondaire (ex. service de fond) |

Champs forum-only (`constat`, `usages`, `forum.postId`) : **hors scope v1** (pas de workflow forum branché).

## Contenu éditorial (orientation)

La vitrine parle **expérience** :

- Mémoire transverse entre projets
- Sessions Claude Code qui se parlent
- Surveillance événementielle sans veilleur coûteux
- Travail délégué (spawn) + capitalisation (`close_project`)
- Local, abonnement Claude, pas de clé API

Elle **ne** détaille pas : liste des 51 outils, schéma des triggers, variables d’env — le README / INSTALL le font.

## Générateur

- Script Node autonome dans `site/generate.mjs` (pas de dépendance runtime hors stdlib Node, ou dépendances déjà dans le repo si utiles)
- Entrée : `site/vitrine.json` (+ assets)
- Sortie : `site/dist/index.html` autonome (HTML+CSS, zéro build bundler obligatoire)
- Identité visuelle : propre à WikiChat (pas une copie visuelle Widgets Grist) ; lisible, une composition, CTA vers le repo / install
- Tests : smoke minimal (JSON valide → fichier HTML non vide ; champs requis présents) — `node --test` ou assert dans le script

## CI / GitHub Pages

- Workflow : sur push `main` touchant `site/**`, ou manuel
  1. `node site/generate.mjs`
  2. Deploy `site/dist` via `actions/deploy-pages`
- Activer Pages sur le repo (GitHub Actions comme source)
- Vérifier l’URL live avant d’annoncer quoi que ce soit

## Critères d’acceptation

1. `https://nic01asfr.github.io/Wikichat/` affiche une page produit cohérente (pitch, points, séquence)
2. Homepage du repo GitHub pointe vers cette URL
3. README technique conserve son rôle + lien vitrine en tête
4. Régénérer après édition de `vitrine.json` met à jour le site sans edit manuel du HTML
5. Aucune mention Widgets Grist sur la vitrine

## Risques / ouvertures

- **Pas de démo live** : WikiChat est local — la vitrine s’appuie sur récit + captures / transcripts stylisés, pas sur un service hébergé
- Pages secondaires (`/install/`) : hors v1 ; un lien « Installer » vers `README` / `docs/setup/INSTALL.md` sur GitHub suffit
- Si le HTML généré grossit : extraire CSS ; rester sans bundler tant que possible

## Suite

Après validation de cette spec → plan d’implémentation (`docs/superpowers/plans/`) → génération + workflow + contenu v1 + activation Pages.
