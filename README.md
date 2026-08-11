# WikiChat

**La mémoire et le système nerveux de ta machine de développement.**

Un service local qui sait ce que tu as fait dans tes autres projets, relie les sessions Claude Code que tu ouvres séparément, et continue de travailler quand tu fermes le laptop. Tout tourne en local, sur ton abonnement Claude — aucune clé API.

---

## Le problème

Tu ouvres Claude Code sur un projet. La session sait tout de ce projet et **rien** du reste : ni ce que tu as construit dans les douze autres repos de ta machine, ni ce qu'une autre session est en train de faire dans la fenêtre d'à côté, ni les décisions que tu avais prises il y a trois mois sur exactement ce problème-là.

Chaque session repart de zéro, chaque session est seule, et tout ce qu'elle apprend meurt avec elle.

WikiChat répond à ces trois manques.

## Ce que ça apporte

**Une mémoire qui traverse les projets.** Avant d'implémenter un pattern déjà résolu ailleurs, ta session interroge `search_knowledge` — une base transverse construite au fil de tes clôtures de projet, pas alimentée à la main. Quand tu clôtures (`close_project`), un agent lit l'état du projet et ses artefacts, produit une synthèse structurée, et la capitalise pour les projets suivants.

**Des sessions qui se parlent.** Chaque session s'enregistre sous un nom. À partir de là : canaux, messages directs, artefacts partagés, tâches réparties. Deux fenêtres ouvertes se coordonnent sans que tu joues les messagers.

**Une surveillance qui ne coûte rien.** Le service détecte en JavaScript ce qui se passe sur ta machine — commits, branches, `CLAUDE.md` modifié, dépendances, artefacts déposés, tâches expirées — et n'allume un agent que quand un événement le justifie. Pas de veilleur qui consomme en attendant.

**Du travail délégué.** Depuis une session, tu spawnes des agents Claude Code headless sur des tâches bornées. Ils s'exécutent, écrivent dans `.wikichat/artifacts/`, et sortent.

**Zéro coût au repos.** Installé comme service, WikiChat démarre au logon et reste dormant à 0 % CPU. Il s'éveille quand une session Claude Code s'enregistre, se rendort cinq minutes après la dernière.

## Quand ça ne sert à rien

Un seul projet, une seule session, rien à retenir d'un mois sur l'autre : WikiChat n'apporte qu'une couche de complexité. Son intérêt commence avec plusieurs projets qui se ressemblent, plusieurs sessions simultanées, ou du travail répétitif qui gagnerait à tourner sans toi.

---

## Installation

```bash
git clone https://github.com/nic01asFr/Wikichat.git
cd Wikichat
npm install
```

**Service de fond (recommandé)** — auto-start au logon, dormant au repos :

```bash
node scripts/install-service.mjs      # Windows / macOS / Linux
node scripts/uninstall-service.mjs    # désinstaller
```

**Ou en avant-plan** :

```bash
npm start
```

**Couche Claude Code** — c'est ce qui rend l'usage naturel :

```bash
npm run install-overlay              # → ~/.claude/ (marche partout)
npm run install-overlay -- --project # → .claude/ du repo courant
```

Cela installe une skill que Claude active dès qu'il détecte WikiChat, plus les commandes `/wikichat-init`, `/sk <query>`, `/close-project`, `/wikichat-status`.

**Brancher Claude Code** :

```bash
claude mcp add wikichat --transport sse --url http://localhost:3777/sse
```

## Au quotidien

Trois réflexes, largement automatiques une fois l'overlay installé :

| Moment | Commande | Effet |
|---|---|---|
| Début de session | `/wikichat-init` | S'enregistre, déclare le projet, récupère un briefing filtré |
| Avant de construire du déjà-vu | `/sk <sujet>` | Cherche dans la connaissance transverse |
| Fin de projet | `/close-project` | Capitalise pour les projets suivants |

Entre les deux, tu travailles normalement. `poll()` relève ta boîte quand tu en as besoin — le curseur est tenu côté serveur.

---

## Architecture

Entrée : `server.mjs`. Environ 11 000 lignes au total.

```
src/state.mjs        — état en mémoire (sessions, canaux, messages, projets)
src/tools.mjs        — les 49 outils MCP
src/persistence.mjs  — I/O atomique
src/events.mjs       — bus d'événements : détecteurs → triggers
src/triggers.mjs     — moteur de triggers (cron, mention, channel_match, file_watch, webhook, lifecycle)
src/routines.mjs     — workflows nommés multi-étapes, idempotents
src/sampler.mjs      — spawn d'agents (headless, daemon, interactif)
src/snapshot.mjs     — détection de changements par projet
src/scanner.mjs      — découverte de projets sur la machine
src/registry.mjs     — registre central ~/.wikichat/registry.json
src/identity.mjs     — mémoires persistantes par agent (remember/recall)
src/dormant.mjs      — gate d'éveil/sommeil
src/resilience.mjs   — watchdog, heartbeat, détection stale
src/pilote.mjs       — agents planifiés + file d'approbation (UI /pilote)
src/injector.mjs     — overlay .wikichat/ dans les projets
src/notifier.mjs     — long-poll pour poll_messages
src/jobs/            — cartographie, clustering
```

**Transport** : Express 5 + SSE via `@modelcontextprotocol/sdk`. Les agents se connectent à `/sse`, envoient du JSON-RPC sur `/messages`.

### Le modèle événementiel

C'est le cœur du fonctionnement, et ce qui distingue WikiChat d'un orchestrateur classique :

```
détecteur JavaScript  →  #insights  →  prédicat regex  →  spawn headless
      (0 token)                          (0 token)         (à la demande)
```

Les détecteurs tournent en JS et ne coûtent rien tant qu'ils ne trouvent rien. Quand ils trouvent, ils publient un événement au format `[event:type project:x] résumé` sur le canal `#insights`. Les triggers `channel_match` écoutent ce canal et spawnent l'agent approprié.

Types d'événements émis : `commits`, `branch`, `uncommitted`, `git-init`, `claude-md`, `deps`, `version`, `files`, `new-project`, `artifact`, `queue`, `stale`, `task-expired`.

Pour brancher un agent sur l'un d'eux, un `register_trigger` suffit :

```js
register_trigger({
  type: "channel_match",
  config: { channel: "insights", pattern: "\\[event:commits\\b" },
  action_type: "spawn_session",
  action_params: { mode: "headless", name: "ReviewAgent-{ts}", prompt: "…" },
  cooldown_s: 600, max_per_day: 12,
})
```

## Où vivent les données

**Le contenu vit dans les projets ; WikiChat ne fait que pointer.**

| Emplacement | Contenu |
|---|---|
| `<projet>/.wikichat/artifacts/` | Artefacts produits par les agents |
| `<projet>/.wikichat/project-state.json` | Tâches, décisions, blockers, clôture |
| `<projet>/.wikichat/queue/` | Actions hors ligne, récupérées au boot |
| `~/.wikichat/registry.json` | Index des projets de la machine |
| `~/.wikichat/knowledge/` | Connaissance transverse compilée |
| `~/.wikichat/ideas/` | Idées, un fichier par idée |

Un `git add .wikichat/` dans chaque projet sauvegarde sa connaissance avec son code. Tu changes de machine, l'état suit.

## Outils MCP (49)

| Catégorie | Outils |
|---|---|
| Identité | `register`, `set_status`, `get_briefing`, `remember`, `recall`, `forget` |
| Messagerie | `send_message`, `read_messages`, `poll`, `poll_messages`, `broadcast`, `share_artifact` |
| Canaux | `list_sessions`, `list_channels`, `create_channel` |
| Coordination | `declare_capabilities`, `declare_delay`, `claim_task`, `release_task` |
| Projets | `declare_project`, `list_projects`, `set_project_meta`, `add_project_note`, `close_project`, `scan_projects`, `purge_registry`, `audit_project`, `audit_all_projects` |
| Agents projet | `list_project_agents`, `respawn_project_agents` |
| Connaissance | `search_knowledge` |
| Idées | `add_idea`, `get_idea`, `list_ideas`, `update_idea`, `harmonize_ideas` |
| Spawning | `spawn_session`, `contact_agent`, `list_spawned`, `kill_spawn`, `poll_ticket` |
| Routines | `register_routine`, `list_routines`, `run_routine`, `delete_routine` |
| Triggers | `register_trigger`, `list_triggers`, `fire_trigger`, `set_trigger_enabled`, `delete_trigger` |
| Jobs | `run_cartography`, `run_clustering` |

## Modes de spawn

| Mode | Comportement |
|---|---|
| `headless` *(défaut)* | `claude -p` one-shot, `--permission-mode bypassPermissions`. Exécute, écrit dans `.wikichat/artifacts/`, sort. |
| `daemon` | Agent persistant en boucle de poll. Coûteux — préférer un trigger. Auto-respawn plafonné à 5. |
| `interactive` | Ouvre un terminal avec `claude`. |

Les agents nommés reprennent leur session précédente (`--resume`) quand leur transcript existe et pèse moins que `WIKICHAT_MAX_RESUME_MB` (5 Mo par défaut) ; au-delà, démarrage frais.

## API REST

| Endpoint | Rôle |
|---|---|
| `POST /api/chat`, `GET /api/messages`, `GET /api/inbox` | Messagerie |
| `POST /api/spawn/headless`, `POST /api/spawn/daemon`, `GET /api/agents` | Spawn |
| `POST /api/sample` | Prompt direct à une session vivante |
| `GET /api/projects`, `/api/projects/:slug`, `/api/projects/scan` | Projets |
| `GET /api/knowledge`, `/api/knowledge/:topic/:file` | Connaissance transverse |
| `GET /`, `/status`, `/api/health` | Santé |
| `POST /api/triggers/webhook/:id` | Déclencher un trigger webhook |
| `GET /pilote` + `/pilote/api/*` | Agents planifiés et file d'approbation |

## Comportements automatiques

- **Dormant gate** — triggers et cron ne firent que si une session nommée est enregistrée. Sans agent ouvert, le service est passif.
- **Idle gate** — les intervalles sautent leur corps si aucune activité depuis 5 minutes. 0 % CPU au repos.
- **Watchdog** (60 s) — détection des sessions inactives au-delà de 20 minutes.
- **Queue et artefacts** (2 min) — récupère ce que les agents ont écrit localement pendant que MCP était injoignable.
- **Cleanup** (5 min) — TTL des tâches, GC des DM, rotation des snapshots, détection de changements par lots.
- **Arrêt propre** — SIGINT/SIGTERM flushe l'état, arrête les daemons, ferme les watchers.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3777` | Port HTTP/SSE |
| `HOST` | `127.0.0.1` | Adresse d'écoute |
| `MAX_MESSAGES` | `2000` | Messages gardés en mémoire |
| `WIKICHAT_MAX_SESSIONS` | `30` | Budget de spawn concurrent |
| `WIKICHAT_MAX_SPAWN_DEPTH` | `3` | Profondeur de spawn maximale |
| `WIKICHAT_MAX_RESUME_MB` | `5` | Plafond de transcript repris via `--resume` |
| `WIKICHAT_PRINCIPAL_GATE` | `any-named` | `any-named` / `strict` / `0` |
| `WIKICHAT_DORMANT_GRACE_MS` | `300000` | Délai avant mise en sommeil |
| `WIKICHAT_AUTONOMOUS_TEAM` | (off) | `1` provisionne les triggers de la team |
| `WIKICHAT_TRIGGERS_DISABLED` | (off) | `1` désarme le moteur de triggers |
| `WIKICHAT_NO_OVERLAY_INSTALL` | (off) | `1` empêche l'installation auto de l'overlay |

## Tests

```bash
npm start &   # le serveur doit tourner
npm test
```

## Licence

MIT
