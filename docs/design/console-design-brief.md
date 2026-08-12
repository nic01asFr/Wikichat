> **ARCHIVE — fonctionnalité retirée.** Ce document décrit la console web, supprimée avec les cinq autres interfaces du projet : aucune n'a jamais été ouverte. Conservé comme trace de conception, il ne décrit rien de ce que fait WikiChat aujourd'hui. L'état du service se lit via `GET /api/health` ou depuis une session Claude Code.

# Console WikiChat — Design Brief

**Destinataire** : Claude Design
**Auteur** : Claude Code (après évaluation UX/UI live de l'implémentation MVP)
**Date** : 2026-05-08
**Statut** : Brief pour cahier des charges — pas un plan d'implémentation

Ton job : produire un **cahier des charges design** pour la console `/console` de WikiChat. Ce document décrit le service, les usages réels, l'état actuel observé, et les contraintes. Le cahier des charges que tu produiras sera ensuite implémenté en HTML+CSS+JS vanilla par un autre agent.

---

## 1 · Ce qu'est WikiChat

WikiChat est un service local multi-agents qui tourne en arrière-plan sur la machine de l'utilisateur (Windows 11, mais cross-platform). Il fournit :

- Un **bus de coordination** pour plusieurs sessions Claude Code actives en parallèle (channels, DMs, broadcasts)
- Une **mémoire transverse** (KB par axes thématiques, ideas pool persistantes)
- Un **registry des projets** détectés sur la machine (~132 projets locaux avec ou sans GitHub remote)
- Un **moteur de spawn** capable de lancer des sous-agents headless ou daemon
- Une **régie** : santé des repos, harmonisation des idées, métadonnées projet structurées (purpose, axes, lifecycle, publish, relations, health)

Le service tourne sur `http://localhost:3777`. Il est **dormant à 0% CPU** quand aucun agent n'est connecté ; il s'éveille automatiquement quand une session Claude Code se register.

L'utilisateur unique est **Nicolas**, développeur senior travaillant sur ~10-20 projets actifs simultanément, avec un parc total de 132 projets registrés. Il bosse sur une seule machine avec plusieurs agents Claude Code potentiellement ouverts en parallèle.

## 2 · Ce qu'est `/console`

`/console` est l'interface navigateur de WikiChat — la **surface d'usage quotidien**. Coexiste avec :
- `/dashboard` : vue live SSE 3-colonnes (existant, dev-mode)
- `/cockpit` : inspecteur profond (existant, dev-mode)
- `/game.html`, `/concepts.html`, `/hybrid-concepts.html` : tentatives de design "game" mises au placard, à ignorer pour ce brief

`/console` est un **first-cut MVP** : tabs Chat / Régie / Spawns + rail gauche sessions/channels + bouton spawn. Cette version est fonctionnelle mais a plusieurs problèmes UX que ton cahier doit adresser. **Voir screenshots dans `.wikichat/artifacts/console-0[1-6]-*.png`**.

## 3 · Les jobs-to-be-done réels

Voici **les actions concrètes** que l'utilisateur veut faire dans cette console. Chaque job est court et fréquent — la console doit les rendre **rapides**.

### Job 1 — Capter une idée en 10 secondes
"Je suis en train de coder, j'ai une intuition. Je veux la noter sans changer de contexte mental, avec 1-2 axes et éventuellement le projet auquel elle se rattache."

Exemple : "tiens, on pourrait indexer les axes KB par embeddings — ça concerne `search` et le projet `wikichat`".

Friction max acceptable : 3 clics + 1 phrase tapée.

### Job 2 — Voir l'état général au matin
"J'ouvre la console le matin. Je veux savoir : quels agents tournent ? sur quoi ? est-ce qu'il y a des messages que j'ai ratés cette nuit ? quels projets sont en alerte (audit score bas, blockers non résolus, no commit > 30j) ?"

Friction max : 1 chargement de page, scan visuel < 5 sec pour voir les rouges.

### Job 3 — Déléguer une tâche bornée à un agent
"J'ai un projet où il manque des tests. Je veux spawner un agent headless qui setup vitest et écrit les premiers tests, sans avoir à ouvrir une nouvelle session Claude Code."

Friction max : 5 clics + 2 phrases tapées (nom + tâche).

### Job 4 — Discuter avec un agent en cours d'exécution
"Un agent daemon tourne sur le projet Archipel. Je veux lui dire 'arrête, j'ai changé d'avis, fais plutôt X'."

Friction max : cliquer son nom dans le rail → champ message → Entrée.

### Job 5 — Suivre les convergences d'idées
"J'ai capté 15 idées au fil des semaines. Lance la harmonisation, montre-moi les clusters qui émergent, propose-moi de scoper celui qui semble mûr."

Friction max : 1 bouton "harmonize" + lecture des clusters proposés.

### Job 6 — Avancer une idée
"L'idée [b4bd59ca] 'index KB par embeddings' est devenue pertinente. Je veux la passer en `scoped`, créer le projet correspondant, et les agents existants doivent voir le lien."

Friction max : 2 clics pour la transition + auto-création du projet (idéal mais pas blocant).

### Job 7 — Auditer un repo
"Je viens de revoir un projet après 3 mois. Audit-le maintenant : README à jour ? CLAUDE.md ? tests ? uncommitted ? ahead/behind ? Donne-moi le score."

Friction max : 1 clic sur la carte projet.

### Job 8 — Comprendre un projet
"Cliquer sur une carte projet et voir ses tâches actives, ses blockers, ses agents historiques (roster), ses décisions récentes, son state."

C'est le job qui n'existe PAS dans le MVP — pas de vue détail. À adresser.

## 4 · État actuel observé (baseline)

### 4.1 Layout

3 zones :
1. **Header** (48px) : titre + 4 status badges + 2 liens externes
2. **Rail gauche** (240px fixe) : bouton spawn + sections Sessions + Channels
3. **Centre** : 3 tabs (Chat / Régie / Spawns) + leur contenu

Voir `console-01-chat-default.png` pour la vue par défaut au chargement.

### 4.2 Stack visuelle

- Dark theme : `#0D1117` bg / `#161B22` bg2 / `#1C2128` bg3 / `#30363D` border
- Accent teal `#45B8B0` pour interactif
- Couleurs sémantiques : `#3FB950` green / `#F85149` red / `#D29922` yellow / `#A371F7` purple / `#E3832D` orange
- Typo : Segoe UI / system / sans-serif, 13px de base
- Tout est inline dans `public/console.html` — un seul fichier vanilla HTML/CSS/JS, pas de build, pas de framework

### 4.3 Fonctionnel

- **Header** rafraîchi toutes les 8s (uptime, budget, sessions, dormant)
- **Chat** poll toutes les 3s sur `/api/messages?channel=X&since_minutes=120`
- **Rail** sessions+channels poll toutes les 6s
- **Régie** ne refresh QUE sur switch de tab (silent staleness)
- **Spawns** ne refresh QUE sur switch de tab

## 5 · Findings — par sévérité

### S1 — Bloquants pour l'usage quotidien

**S1.1 Sessions anonymes saturent le rail.** 9 entrées `session-XXXXXX` italiques affichées comme "sessions" alors que le compteur dit `0`. Aucune n'est actionable. Voir `console-01-chat-default.png` ligne 5-13 du rail. → cluttering pur.

**S1.2 Pas de responsive.** Layout grid `240px 1fr` cassé dès 768px (voir `console-05-tablet.png`) et inutilisable à 375px (`console-06-mobile.png`). Sur tablette les colonnes Régie débordent en scroll horizontal. Pas de breakpoints.

**S1.3 Liste de channels plate avec doublons.** 20 channels listés en flat dont des duplicates `##design` et `##insights` (bug de doublement de `#`). Pas de groupement (system / project / DM). Voir `console-01-chat-default.png` lignes channels.

**S1.4 Régie ne refresh pas en continu.** Si tu es sur Régie et qu'un autre agent capte une idée, tu ne le verras qu'en sortant et revenant sur le tab. Idem pour `audit_project` lancé depuis MCP par un agent.

**S1.5 Polling agressif.** 608 requêtes HTTP en ~5 min d'observation. La plupart sont des 304 Not Modified mais c'est du bruit. SSE à envisager pour Chat + Régie. Voir réseau capturé.

### S2 — Friction quotidienne notable

**S2.1 Job 1 (capter une idée) demande trop de clics.** Switch tab → scroll vers form → 4 champs visibles → click bouton. Devrait être un raccourci global ou un widget toujours visible.

**S2.2 Project cards illisibles.** Mélange description + purpose + warnings + agents + badges sans hiérarchie visuelle (voir `console-02-regie.png`, panneau droit). Aucun ordre de scan évident. Aucune carte ne permet d'expand.

**S2.3 Pas de vue détail projet.** Cliquer sur un nom de projet = rien. Job 8 impossible. Devrait au minimum router vers `/cockpit/project/<slug>` ou ouvrir un drawer latéral.

**S2.4 Spawn modal trop étroit (480px) sur écran 1440px.** Champ "repo path" demande de coller un chemin Windows à la main. Aucun autocomplete depuis le registry de 132 projets. Voir `console-04-spawn-modal.png`.

**S2.5 Status flip d'idée invisible.** Boutons `→ scoped`, `→ started`, `→ shelved`, `✕` en taille 10px gris foncé sur fond sombre. Voir `console-02-regie.png` carte idée.

**S2.6 Pas de filter / search.** Avec 132 projets et N idées, scroll infini. Job 2 devient impossible en > 1 mois d'usage.

### S3 — Limites & gaps fonctionnels

**S3.1 Pas de kill spawn.** Onglet Spawns est lecture seule. Pour tuer un daemon il faut sortir et passer par MCP.

**S3.2 Pas d'édition body d'idée.** Seulement status flip + delete. Pour modifier le contenu, retour à MCP.

**S3.3 Pas de visualisation des relations.** Le champ `relations` est stocké et affiché en badges mais sans graph ni navigation entre projets liés.

**S3.4 Pas de notifications.** Si un agent t'envoie un DM, rien ne le signale en dehors du tab Chat.

**S3.5 Pas de threading dans chat.** Liste plate, pas de quote, pas de reply.

**S3.6 Empty states austères.** "Idea pool vide" est correct mais opportunité ratée d'éduquer (exemples, pourquoi capter, comment relier).

### S4 — Accessibilité

**S4.1 Tabs non sémantiques.** Voir snapshot a11y : `Chat`, `Régie`, `Spawns` apparaissent comme `StaticText`, pas comme `tablist`/`tab`/`tabpanel`. Pas keyboard-navigable.

**S4.2 Signaux color-only.** Score health 30/60/100 = rouge/jaune/vert sans icône ou texte explicite. Idem badges lifecycle.

**S4.3 Modal pas focus-trapped.** Tab sort du modal et passe à l'arrière.

**S4.4 Aucun focus ring visible** (pas de `:focus-visible` styling).

### S5 — Cohérence visuelle

**S5.1 Tous les boutons ont le même poids.** "+ Spawn agent" (action critique) et `→ scoped` (status flip mineur) sont visuellement plus proches qu'ils ne devraient.

**S5.2 Header sparse.** 4 status badges quasi-identiques visuellement, links externes muets en haut à droite.

**S5.3 Scrollbar du rail s'affiche bizarrement** (Firefox) — thumb sombre sur track clair.

## 6 · Données disponibles (pour mockups réalistes)

Voici les shapes des données que la console manipule. **Tu peux les utiliser pour mocker du contenu réaliste dans tes propositions.**

### 6.1 Project (régie schema enrichi)

```json
{
  "name": "Archipel",
  "description": "Stack open-data territoriale pour Cerema",
  "purpose": "Brique data partagée entre 5 territoires",
  "axes": ["geomatique", "open-data"],
  "lifecycle": "active",
  "publish": {
    "github": { "visibility": "private", "url": "https://github.com/cerema/archipel" },
    "package": null,
    "deployed": { "url": "https://archipel.cerema.fr", "env": "prod" },
    "license": "MIT"
  },
  "relations": [
    { "type": "depends-on", "project": "Portmap", "note": "auth" },
    { "type": "provides-to", "project": "IISR-Audit" }
  ],
  "health": {
    "score": 72,
    "readme_present": true,
    "readme_age_days": 14,
    "claude_md_present": true,
    "license": "MIT",
    "has_tests": true,
    "ci": "github-actions",
    "is_git_repo": true,
    "branch": "main",
    "last_commit_age_days": 3,
    "uncommitted": 0,
    "ahead_of_remote": 0,
    "behind_remote": 0,
    "warnings": []
  },
  "tasks_active": 2,
  "blockers": 1,
  "decisions": 14,
  "open_questions": 3,
  "tracked_agents": 4,
  "live_agents": [{ "id": "abc", "name": "Alice", "role": "dev" }]
}
```

### 6.2 Idea

```json
{
  "id": "b4bd59ca-ce2",
  "title": "Indexer la KB par embeddings",
  "body": "Construire un index vectoriel local des axes pour accélérer search_knowledge transverse.",
  "axes": ["search", "knowledge"],
  "related_projects": ["wikichat"],
  "status": "raw",  // raw | clustered | scoped | started | shelved
  "source": "user", // user | channel | closure | git-signal | harmonizer
  "created_at": "2026-05-08T15:42:00.000Z",
  "updated_at": "2026-05-08T15:42:00.000Z",
  "created_by": "Console",
  "cluster_id": null,  // string after Harmonizer pass
  "similar_to": []     // array of other idea ids in same cluster
}
```

### 6.3 Session live

```json
{
  "id": "abc123de",
  "name": "Alice",
  "role": "dev",
  "agent_type": "interactive",  // interactive | daemon | headless
  "availability": "available",
  "current_project": "Archipel",
  "lastSeen": "2026-05-08T15:40:00.000Z",
  "anonymous": false  // true if name starts with "session-"
}
```

### 6.4 Channel

```json
{
  "name": "ideation",
  "description": "Idea pool : capture, harmonisation, scoping",
  "isSystem": true,
  "isDM": false  // true if name starts with "dm:"
}
```

### 6.5 Spawn ticket

```json
{
  "name": "FileHooksWorker",
  "role": "implementer",
  "mode": "headless",  // headless | daemon | interactive
  "spawned_at": "2026-05-08T13:00:00.000Z",
  "status": "completed",  // running | starting | completed | failed | done | max-respawns
  "repo_path": "c:/.../wikichat-filehooks"
}
```

### 6.6 Volumes typiques observés

- **Projets** : 132 dans le registry, ~17 explicitement déclarés dans `state.projects` (avec meta)
- **Sessions live** : 0-9 typiquement (1 principal + 3 résidents quand éveillé + agents spawnés ponctuels)
- **Channels** : 20 (3 system + ~15 par-projet auto-créés + DMs)
- **Idées** : 0-100 sur la durée
- **Spawns** : 14 dans le registry après GC, peut monter à 50+ en usage soutenu
- **Messages** : cap à 200 en mémoire (eviction LRU sur les plus vieux 10%)

## 7 · Contraintes

### 7.1 Techniques (durs)

- **Zéro build step** : HTML+CSS+JS vanilla, un seul fichier `public/console.html` (taille actuelle 1192 lignes — peut grossir à ~2500 si justifié)
- **Pas de framework** : pas de React, Vue, Svelte, etc. JS vanilla moderne (ES2022 OK)
- **Pas de CDN externe** : pas d'imports `<script src="https://...">`. Tout doit fonctionner offline localhost
- **Cible navigateurs** : Chrome / Edge / Firefox récents (2024+). Pas IE, pas Safari < 16
- **Backend stable** : 11 endpoints REST sous `/api/regie/*` + endpoints existants `/api/chat`, `/api/spawn/headless`, `/api/spawn/daemon`, `/api/agents`, `/api/messages`, `/api/health`, `/api/admin/dormant`. **Tu peux proposer de nouveaux endpoints SSE/WebSocket** si nécessaire (à argumenter, pas obligatoire)
- **Single-page** : pas de routing multi-page. Hash-routing OK (`/console#/regie/projects/Archipel`)

### 7.2 Design (durs)

- **Dark theme uniquement** pour ce cut. Light theme = phase 2
- **Garder la palette existante** comme base (peut être étendue) : `#0D1117` / `#161B22` / `#1C2128` / `#30363D` / `#45B8B0` / `#E6EDF3` / `#8B949E`
- **Pas d'emoji décoratif dans les labels** — les emojis présents (`🩺 🧩 💡 🏷 🚀 🔴`) sont fonctionnels comme icônes. Si tu veux les remplacer par des SVG inline, c'est OK et probablement souhaitable
- **Localisation** : français principal (interface utilisateur Nicolas) — pas besoin d'i18n
- **Densité d'info** : c'est un outil pro, pas une app grand public. Densité haute autorisée si lisible. Pas de white space gratuit

### 7.3 Design (souples)

- Typo : Segoe UI peut être remplacé par Inter / IBM Plex Sans / SF Pro Display si tu veux
- Animations : minimales OK (transitions 150-250ms), pas de hero animations
- Iconographie : actuellement emoji, tu peux passer à SVG inline (préféré) ou icon font (moins préféré)

## 8 · Hors-scope (pour ce brief)

Ne PAS designer :
- ❌ Le `/dashboard` ou `/cockpit` existants — ils restent comme inspecteurs dev
- ❌ Une vue mobile native ou une PWA — desktop-first, tablet OK, mobile ignorable pour ce cut
- ❌ Un système d'authentification — localhost-only, pas de login
- ❌ Une vue "île / village / animal-crossing" — `game.html` reste mort, c'est explicitement pas ce qu'on cherche
- ❌ Un éditeur visuel pour les axes KB (markdown reste source de vérité)
- ❌ Un mode collaboratif multi-utilisateur — Nicolas est seul utilisateur

## 9 · Critères de succès

Le design est réussi si :

1. **Job 1 (capter une idée) prend ≤ 10 secondes.** Mesurable.
2. **Job 2 (état général au matin) lisible en ≤ 5 secondes.** Les rouges/alertes sautent aux yeux.
3. **Le rail gauche n'affiche jamais de bruit.** Pas d'anonymes en clair, channels groupés.
4. **Régie + Chat se mettent à jour en temps réel** sans switch de tab.
5. **Le coût en requêtes HTTP/min baisse vs MVP** (idéalement par 5x grâce à SSE).
6. **Job 8 (vue détail projet) existe** — drawer ou route dédiée.
7. **Le design tient sur 768px** sans scroll horizontal forcé.
8. **L'a11y de base passe** (tablist sémantique, focus rings, aria-live pour les nouveautés chat).
9. **Le code reste lisible** : un dev humain peut comprendre `console.html` en 1h.

## 10 · Livrables attendus

Pour ton cahier des charges, fournis :

1. **Sitemap / IA** : la nouvelle structure de l'écran avec zones nommées
2. **Wireframes textuels ou ASCII** des 3-5 vues principales (matin, capture idée, vue projet détail, spawn flow, chat actif)
3. **Hiérarchie visuelle** : ordre de scan recommandé pour chaque vue
4. **Liste des composants** atomiques avec spec (badge, card, button, input, modal, drawer, tab, etc.) — ce qui sera réutilisé
5. **Patterns d'interaction** : comment on navigue, raccourcis clavier proposés, états loading/error/empty
6. **Choix techniques** : SSE vs polling pour quoi, hash-routing vs single-view, animations spec
7. **Migration plan** : ce qu'on garde du MVP, ce qu'on remplace, ordre de livraison (la console doit rester utilisable pendant la transition)
8. **Risques identifiés** : où ton design peut casser, ce qui demande validation Nicolas

## 11 · Références

### 11.1 Screenshots à étudier

Disponibles dans `.wikichat/artifacts/` :
- `console-01-chat-default.png` — vue chargement par défaut, tab Chat (1440x900)
- `console-02-regie.png` — tab Régie avec 1 idée + 17 projets (1440x900)
- `console-03-spawns.png` — tab Spawns avec ~15 entrées (1440x900)
- `console-04-spawn-modal.png` — modal Spawn ouvert
- `console-05-tablet.png` — Régie à 768x900 (cassé)
- `console-06-mobile.png` — Régie à 375x812 (cassé)

### 11.2 Code à lire

- `public/console.html` — l'implémentation MVP complète
- `server.mjs` lignes ~940-1130 — endpoints `/api/regie/*`
- `src/ideas.mjs`, `src/repo-audit.mjs`, `src/harmonizer.mjs` — modules métier
- `templates/.claude-overlay/skills/wikichat/SKILL.md` — référence "comment WikiChat est utilisé par les agents Claude Code" (utile pour comprendre l'écosystème)

### 11.3 Concepts antérieurs (POUR INSPIRATION SEULEMENT)

`public/concepts.html` et `public/hybrid-concepts.html` contiennent 5 concepts de design "game" antérieurs (Village / Cité des Flux / Labyrinthe / QG des Héros / Interface Arcane) + leurs hybrides A×B. Ils sont **abandonnés** mais peuvent inspirer. Ne pas les imiter — l'objectif n'est pas un jeu, c'est une console pro.

---

**Quand tu rends ton cahier des charges, sauve-le dans `docs/design/console-cahier-des-charges.md`**, et fais ping sur `#design` (channel WikiChat) ou directement à Nicolas. L'agent qui implémentera ensuite suivra ton document.
