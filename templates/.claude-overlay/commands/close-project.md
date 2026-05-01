---
description: Clôture structurée d'un projet wikichat avec audit en 4 sections (auto via Closer headless ou manuel). Usage : /close-project [name]
---

Clôture le projet : `$ARGUMENTS` (si vide, prend le projet courant détecté depuis `cwd` ou `git remote`).

**Étape 1 — Détermine le projet à clôturer** :
- Si argument fourni : utilise tel quel
- Sinon : nom = basename du repo courant
- Vérifie qu'il existe via `mcp__wikichat__list_projects()`. Si absent : prévient et stoppe.

**Étape 2 — Présente l'option à l'utilisateur** :
- Demande s'il préfère mode `auto=true` (Closer headless audit, ~1-2min, coût tokens) ou `auto=false` (l'utilisateur fournit les 4 sections directement)
- Pour mode manuel : demande à l'utilisateur les 4 sections (Documentation, Livrables, Rétrospective, Capitalisation), 2-3 lignes chacune max

**Étape 3 — Lance la clôture** :
```
mcp__wikichat__close_project(
  project="<name>",
  auto=<true|false>,
  closure=<les 4 sections si manuel>,
  repo_path="<cwd absolu>"   # si mode auto
)
```

**Étape 4 — Affiche le résultat** :
- Mode auto : confirme le ticket spawn, donne le chemin où le résultat apparaîtra (`projects/<name>.json` + broadcast #library)
- Mode manuel : confirme la persistance + signale que le LibrarianAbsorber va automatiquement intégrer la closure dans l'axe pertinent (~30s)

Pas de blabla. Output minimal et actionnable.
