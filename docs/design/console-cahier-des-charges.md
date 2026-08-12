> **ARCHIVE — fonctionnalité retirée.** Ce document décrit la console web, supprimée avec les cinq autres interfaces du projet : aucune n'a jamais été ouverte. Conservé comme trace de conception, il ne décrit rien de ce que fait WikiChat aujourd'hui. L'état du service se lit via `GET /api/health` ou depuis une session Claude Code.

# Wikichat — Cahier des charges v2

> **Objet** : spec écrite qui complète `wikichat-spec.html` (les 5 vues en pixels) et `docs/design/components.html` (les atomes/molécules). Lis ce fichier *en regard* de ces deux-là — il décrit les algos, les contrats, et les décisions qui ne se voient pas dans les pixels.
>
> **Statut** : v2, post-feedback du 8 mai. Remplace toute discussion antérieure.
>
> **⚠ Voir `console-cahier-feedback.md`** : 3 corrections dures à appliquer avant implémentation (vanilla JS only, zéro build, reviewer = Nicolas).

---

## 1. Sitemap

```
/#today                                    ← landing par défaut
/#canvas                                   ← canvas plein écran
/#canvas?proj=<id>                         ← + peek panel ouvert
/#canvas?proj=<id>&zoom=<n>&cx=<n>&cy=<n>  ← + état pan/zoom
/#capture                                  ← overlay (fond = canvas)
/#capture?proj=<id>                        ← overlay pré-scopé
/#spawn?proj=<id>                          ← overlay (fond = canvas)
/#chat/<projId>                            ← vue chat
/#chat/<projId>?agent=<name>               ← + agent ouvert
/#chat/<projId>?agent=<name>&at=msg-<id>   ← + scrollé à un message
```

**Règle** : les overlays (`capture`, `spawn`) ont toujours un fond. Si on y arrive en deep-link sans contexte, le fond est `canvas` par défaut. Esc ferme l'overlay et retourne au fond.

## 2. State machine

```
              ┌──────────────┐
              │              │
              ▼              │
    ┌─────────────────┐      │ esc
    │     today       │      │
    └────────┬────────┘      │
             │ g c           │
             ▼               │
    ┌─────────────────┐      │
    │     canvas      │◀─────┤
    └─┬───┬───┬───────┘      │
      │   │   │              │
   ⌘N │   │ ⌘↩│              │
      │   │   │              │
      ▼   │   ▼              │
   spawn  │ capture           │
   (modal)│ (overlay)         │
          │                   │
          │ click peek        │
          ▼                   │
    ┌─────────────────┐      │
    │     chat        │──────┘
    └─────────────────┘
```

**Transitions** :
- `today → canvas` : crossfade 220ms + scale .98→1 sur le canvas
- `canvas → chat` : slide horizontal (chat entre par la droite, 220ms)
- `* → capture/spawn` : overlay fade-in 180ms sur le fond (le fond reste statique)
- `* → today` (via esc depuis today, ou logo click) : fade 180ms

## 3. Hash routing — implémentation

**Choix tech** : router maison vanilla, ~80 lignes. Pas de react-router, pas de framework. Justification :
- L'app a 5 vues seulement. Un router 4kb fait le job.
- Hash routing évite la config serveur (pas de fallback `/*` à configurer).
- Deep-linkable depuis un message Slack : tu colles l'URL, ça marche.

**Contrat** (en JSDoc — vanilla JS) :

```js
/**
 * @typedef {Object} Route
 * @property {'today'|'canvas'|'capture'|'spawn'|'chat'} view
 * @property {string} [segment]                     - /#chat/<segment>
 * @property {Object<string,string>} params
 */

router.subscribe(/** @param {Route} route */ (route) => void);
router.navigate({ view, segment?, params? }, { replace?: boolean });
router.update(params);       // patch params sans changer view (debounced 300ms, replaceState)
```

**Règles** :
- Param invalide (`?proj=ghost` mais le projet n'existe pas) → on charge la vue sans le param + warning console. Jamais d'erreur user-facing pour ça.
- `update()` est debounced : utile pour zoom/pan canvas, qui changent en continu mais ne doivent pas spammer l'historique.
- `navigate()` push par défaut, `replace: true` pour les changements latéraux (ouvrir un peek depuis le canvas).

## 4. Layout algorithm — canvas

**Décision tranchée : grid auto + override draggable persisté.**

### 4.1 Algorithme par défaut

```
1. CLUSTER  — grouper projets par cluster_id (champ explicite, sinon "default")
              chaque cluster a un seed de position (top-left), label éditable
2. PACK     — dans chaque cluster, packer en grille auto :
              - colonnes = floor(clusterWidth / (cardWidth + gap))
              - tri : pinned d'abord, puis activité_recente desc
              - gap : 24px
3. IDÉES    — chaque idée près de son projet rattaché :
              - offset radial pseudo-aléatoire stable par id
              - rayon 80–140px
              - sans projet rattaché → "sandbox" en bas
4. AGENTS   — au-dessus du projet, en pile horizontale
              offset y : -28px par agent supplémentaire
```

### 4.2 Override

```js
localStorage[`wikichat.layout.${projectId}`] = { x, y, fixed: true };
localStorage[`wikichat.layout.cluster.${clusterId}`] = { x, y };
localStorage[`wikichat.layout.idea.${ideaId}`] = { x, y };
```

- L'auto-layout coule autour des éléments fixés.
- `⌘⇧L` = reset (efface tous les overrides du localStorage).
- Pas de sync server-side. Le layout est *personnel* — chacun son arrangement.

### 4.3 Pourquoi pas force-directed

Force-directed re-arrange à chaque ajout. **Tue la mémoire spatiale** — qui est *la* valeur de cette vue. Un projet vu hier doit être au même endroit aujourd'hui.

## 5. Interactions live — SSE vs polling

**Décision** : SSE pour les événements *contextuels* (agent qui parle, idée qui apparaît), polling pour les *aggregats* (santé projet, stats).

| Événement | Transport | Fréquence | Endpoint |
|---|---|---|---|
| Message d'agent | SSE | push | `/events/chat/<projId>` |
| Idée captée | SSE | push | `/events/ideas` |
| Agent spawn / kill / crash | SSE | push | `/events/agents` |
| Santé projet (commit count, CI status) | poll | 30s | `/api/projects/health` |
| Token usage par agent | poll | 5s tant que chat ouvert | `/api/agents/<id>/usage` |

**Reconnect** : SSE avec exponential backoff (1s, 2s, 4s, 8s, max 30s). HUD top-right indique l'état.

**Pourquoi pas WebSocket** : pas besoin d'envoi client→server temps réel. Les actions user passent par REST (POST `/api/messages`). SSE est plus simple, traverse mieux les proxies.

## 6. Animations — durées de référence

| Élément | Durée | Easing |
|---|---|---|
| Hover, focus, sélection | 140ms | ease-out |
| Entrée overlay | 180ms | ease-out |
| Sortie overlay | 120ms | ease-in |
| Peek panel slide-in | 200ms | ease-out |
| Transition entre vues | 220ms | `cubic-bezier(.2,.7,.2,1)` |
| Idée nouvelle (overshoot) | 320ms | `cubic-bezier(.6,-.2,.2,1.4)` |
| Pulse "live" agent | 2000ms | infinite |

**Règles dures** :
- Aucune > 400ms (sauf pulse).
- Pas d'animation au load initial.
- `prefers-reduced-motion` → 60ms ou off.
- Canvas zoom **jamais animé** (transform direct).

## 7. Plan de migration MVP → cible

État actuel (mai 2026) : MVP CLI + chat web basique, pas de canvas, pas de capture overlay, pas de today.

### Wave 1 — Foundations (sem 1-2)
- [ ] Router hash + state machine (vide, avec stub views)
- [ ] Token system extrait (CSS custom properties dans `console.html`, copy-pasted depuis components.html)
- [ ] Atomes des composants intégrés directement en HTML/CSS/JS dans `console.html`
- [ ] Vue `today` — c'est la plus simple, *no live data needed initially* (lecture seule)

### Wave 2 — Capture (sem 3)
- [ ] Overlay `capture` + raccourci `⌘K`
- [ ] Inférence projet (last touched)
- [ ] Inférence axes (NLP local : tag matching d'abord, embeddings ensuite)
- [ ] Optimistic UI

**Jalon** : on peut remplacer `wikichat capture` CLI par l'UI sans perte.

### Wave 3 — Canvas read-only (sem 4-5)
- [ ] Layout algorithm (étapes 1-4 ci-dessus, sans override)
- [ ] Pan + zoom (transform-based, pas animé)
- [ ] Peek panel (sélection projet/idée)
- [ ] SSE pour idées entrantes

**Jalon** : `today` devient une vue raccourci ; le canvas est l'écran de travail.

### Wave 4 — Spawn + Chat (sem 6-7)
- [ ] Modal spawn (4 décisions)
- [ ] Vue chat 3-colonnes
- [ ] Watermark unread (localStorage)
- [ ] SSE pour messages agent

**Jalon** : on peut remplacer le chat web actuel.

### Wave 5 — Override + polish (sem 8)
- [ ] Drag-to-override layout
- [ ] Animations transitions vues
- [ ] Loading skeletons + error states locaux
- [ ] Reduced-motion

### Ce qu'on jette
- Le chat web actuel (remplacé en wave 4).
- Le `wikichat status` CLI (remplacé par `today`).

### Ce qu'on garde côté CLI
- `wikichat capture` (utile en TTY, redirige vers l'API)
- `wikichat spawn` (idem)
- L'agent runtime (rien à voir avec l'UI)

## 8. Choix techniques

### 8.1 Vanilla JS uniquement (contrainte projet)
**Décision** : vanilla JS, pas de framework, pas de web components.

Justifié par :
- L'app a 5 vues, pas un SaaS de 50 écrans.
- L'objectif `console.html` mono-fichier vanilla est précisément pour zéro friction de build.
- Bundle inexistant = cold start instantané. Cet outil est lancé 50× par jour.

Les atomes du `components.html` doivent être implémentables directement en HTML/CSS/JS dans `console.html`. Pas de port en composants framework.

### 8.2 CSS
- Pas de framework (Tailwind, etc.). CSS plain dans `<style>` inline du fichier.
- Tokens via custom properties (`:root { --bg-0: ...; }`).
- Pas de SCSS, pas de modules. Les custom properties font le job.

### 8.3 État
- Local : variables JS + `data-*` attributes + closures.
- Global : un store en mémoire (objet plain) + sync localStorage pour l'UI persistente (layout overrides, lastReadAt, sidebar collapsed, etc).
- Server state : fetch + cache maison (Map keyed par URL+timestamp). SSE invalide les entrées concernées.

### 8.4 Routing
- Hash router maison. ~80 lignes. Voir §3.

### 8.5 Build
- **Aucun build step.** `console.html` mono-fichier servi tel quel par le serveur Express.
- Si les tokens doivent être partagés avec `components.html` (mockup design), c'est par copy-paste documenté en commentaire `<!-- SOURCE: components.html §tokens -->`. Pas de bundler.

## 9. Risques + mitigations

| Risque | Impact | Mitigation |
|---|---|---|
| Le canvas devient illisible avec >50 projets | Élevé | Cluster collapsing (un cluster fermé = 1 carte aggrégée). Filtre rapide ⌘F. |
| L'inférence d'axes est fausse plus souvent qu'utile | Moyen | Toujours éditable, badge "inféré" visible, log feedback en local pour itérer. |
| SSE ne traverse pas le proxy (rare en localhost mais possible) | Moyen | Fallback long-polling automatique si SSE échoue 3× consécutifs. |
| Le hash routing perturbe le copy-paste depuis Slack/Discord | Moyen | Doc + bouton "copier le lien" qui formatte avec wrapper si nécessaire. |
| `prefers-reduced-motion` mal respecté → motion sickness | Faible | Audit a11y au wave 5. Désactivation globale via `--motion: 0` token. |
| Le watermark unread crée une attente de "notif" qui n'existe pas | Moyen | UX research wave 4 — observer Nicolas sur 1 semaine. |
| Drag override qui se désynchronise entre devices | Faible | C'est une feature. Le layout est local, pas global. Documenté. |
| Renommage de projet → ID change → layout perdu | Faible | Keyer le localStorage par slug stable, pas par display name. Ou migration au rename. |

## 10. Décisions ouvertes (à valider)

- **Mobile/tablet** : ma proposition = desktop-only en v1. Mobile = page "ouvre ce lien sur desktop" + lien deep-link. À valider.
- **Sync layout cross-device** : non en v1. À reposer en v2 si demande.
- **Multi-user** : hors scope v1. L'app est mono-utilisateur (un dev, ses projets). Pas de presence, pas de cursors partagés.
- **Theming clair** : non en v1. La direction warm-dark est l'identité ; un theme clair diluerait. À reconsidérer si demande utilisateur forte.
- **i18n** : v1 = FR seulement (Nicolas prod l'app en FR). v2 = EN si on ouvre.

## 11. Composants — voir `components.html`

Catalogue exhaustif dans `docs/design/components.html`. Couvre :
- Tokens (couleurs, type, rayons, motion)
- Atomes : Kbd, Dot, Badge, Avatar, Meter
- Pièces : ProjectCard, IdeaNote, AgentPill, ClusterZone, RelationLine, HudPill
- Organismes : CmdTrigger, CmdPalette, PeekPanel, Minimap

Chaque composant a : variantes, props, états, do/don't.

## 12. Vues — voir `wikichat-spec.html`

5 vues + cross-cutting dans `wikichat-spec.html`. Couvre :
- 01 Aujourd'hui (default + empty premier matin)
- 02 Canvas (fragment + empty)
- 03 Capture (default avec inférence)
- 04 Spawn (default avec preview commande)
- 05 Chat (default avec watermark unread)
- 06 Routing — détail des routes et raccourcis
- 07 Layout — recap algo
- 08 Motion — recap durées
- 09 Loading + Error

---

**Prochains pas** :
1. Validation de ce cahier (reviewer **Nicolas**).
2. Démarrer Wave 1 : router + tokens + atomes en vanilla JS dans `console.html`.
