# WikiChat Vitrine Pages — Implementation Plan

> **For agentic workers:** Execute task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Publier une page produit GitHub Pages générée depuis `site/vitrine.json`, distincte du README technique.

**Architecture:** Un JSON éditorial → `site/generate.mjs` (Node stdlib) → `site/dist/index.html` autonome → workflow `actions/deploy-pages`. Base path `/Wikichat/` pour les assets.

**Tech Stack:** Node ≥18 ESM, GitHub Pages (Actions), HTML/CSS inline, Google Fonts (Syne + Literata).

## Global Constraints

- Pas de mention Widgets Grist sur la vitrine
- Pas de `manifest.json` / catalogue Grist
- Ne pas éditer `site/dist/*.html` à la main
- README technique : seulement un lien vitrine en tête
- Zéro dépendance npm nouvelle pour le générateur

---

### Task 1: Contenu `vitrine.json` + test smoke + générateur

**Files:**
- Create: `site/vitrine.json`
- Create: `site/generate.mjs`
- Create: `site/generate.test.mjs`
- Modify: `package.json` (scripts `site` et `test:site`)

**Interfaces:**
- Produces: `generate()` écrit `site/dist/index.html` ; export optionnel pour tests
- Consomme: champs spec (`nom`, `pitch`, `couleur`, `tags`, `depot`, `points`, `produit.*`, `journal`, `encart`)

- [ ] **Step 1:** Écrire `site/generate.test.mjs` qui échoue sans générateur
- [ ] **Step 2:** Écrire `vitrine.json` + `generate.mjs` jusqu’à tests verts
- [ ] **Step 3:** Commit

### Task 2: Workflow Pages + README + homepage

**Files:**
- Create: `.github/workflows/pages.yml`
- Modify: `README.md` (lien en tête)
- Modify: `package.json` homepage vers Pages URL (optionnel — About GitHub via `gh`)

- [ ] **Step 1:** Workflow deploy `site/dist`
- [ ] **Step 2:** Lien README + `gh repo edit --homepage`
- [ ] **Step 3:** Push, activer Pages si besoin, vérifier URL

### Task 3: Spec status

- [ ] Marquer spec `Statut : accepted` / implémentée
