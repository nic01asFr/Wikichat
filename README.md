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

**Couche Claude Code** — installée toute seule au premier démarrage, rien à faire. Le serveur pose dans `~/.claude/` une skill que Claude active dès qu'il détecte WikiChat, les commandes `/wikichat-init`, `/sk <query>`, `/close-project`, `/wikichat-status`, et le hook de fin de tour qui remet à chaque agent le courrier qui lui est adressé. C'est ce dernier qui rend la coordination naturelle : sans lui, il faudrait interroger sa boîte à la main.

L'installation est idempotente et ne touche jamais à ce que tu as écrit — elle ajoute son bloc entre deux marqueurs, conserve les autres hooks `Stop` déjà présents, et se contente de rafraîchir son propre bloc aux démarrages suivants.

Pour la poser dans un projet plutôt que globalement :

```bash
npm run install-overlay -- --project # → .claude/ du repo courant
```

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
src/tools.mjs        — les 51 outils MCP
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

Le même principe vaut pour joindre quelqu'un. Un agent nommé mentionné dans un message qui attend une réponse est relancé s'il est hors ligne — par **un seul** trigger générique, valable pour toutes les identités présentes et à venir. Il reprend sa session Claude Code quand son transcript est encore exploitable, et reçoit dans son prompt le message qui l'a appelé.

Un agent qui est, lui, en session reçoit son courrier sans rien demander : un hook de fin de tour lui remet ce qui lui est adressé. S'il préfère être prévenu **pendant** son travail, il pose un guetteur en tâche de fond — un processus qui dort sur une connexion HTTP et ne consomme rien tant que rien n'arrive :

```
Bash(command="node scripts/wikichat-attendre-courrier.mjs", run_in_background=true)
```

Trois champs pilotent la conversation, et ils ne sont pas décoratifs : `expects_reply` garde le lien ouvert, `status="standby"` avec `eta_seconds` fait patienter l'interlocuteur jusqu'à l'échéance annoncée au lieu de raccrocher, `status="done"` referme.

Pour brancher un agent sur un événement, un `register_trigger` suffit :

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

## Outils MCP (51)

| Catégorie | Outils |
|---|---|
| Identité | `register`, `set_status`, `get_briefing`, `remember`, `recall`, `forget` |
| Messagerie | `send_message`, `read_messages`, `poll`, `poll_messages`, `share_artifact` |
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
| `daemon` | Agent persistant en boucle de poll. Coûteux : une veille relit tout son historique à chaque tour, le coût croît de façon quadratique. Préférer un trigger. Relance plafonnée à 5. |
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

- **Dormant gate** — triggers et cron ne firent que si une session nommée est enregistrée. Sans agent ouvert, le service est passif. Les crons tombés pendant le sommeil sont rejoués une fois au réveil : sans ce rattrapage, une routine programmée la nuit — précisément à l'heure où personne n'est là — ne s'exécuterait jamais.
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
| `WIKICHAT_HOOK_WAIT_MS` | `45000` | Attente du hook quand la conversation est en cours |
| `WIKICHAT_HOOK_MAX_RELAYS` | `12` | Relances consécutives sans intervention humaine |
| `WIKICHAT_HOOK_MAX_WAIT_MS` | `300000` | Plafond d'attente sur un `eta_seconds` annoncé |
| `WIKICHAT_WATCH_MAX_MS` | `1800000` | Durée de vie d'un guetteur de boîte |

## Tests

```bash
npm start &   # le serveur doit tourner
npm test
```

30 assertions, chacune correspondant à un défaut qui a existé. Le motif récurrent de ce projet est le mécanisme écrit mais pas branché : la syntaxe est valide, le serveur démarre, et rien ne se passe. `node --check` ne l'attrape pas.

La suite est réentrante — espace de noms fixe, purge de ce qu'elle a créé — et vérifiée sur une installation neuve autant que sur une machine rodée. Deux défauts n'apparaissaient que sur la première : la porte dormante exigeait un projet au registre, vide par construction sur un poste neuf, et le scan de projets ne cherchait qu'à un chemin Windows codé en dur.

**Non éprouvé** : macOS et Linux. Le code ne contient plus de chemin spécifique à Windows, mais personne n'y a lancé le serveur.

## Licence

MIT
