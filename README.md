# WikiChat

**Serveur MCP local de coordination multi-agents pour Claude Code.**

WikiChat permet à plusieurs instances indépendantes de Claude Code de communiquer, se coordonner et travailler ensemble sur des projets via des canaux, des messages directs, et un système de tâches partagé. Tout tourne en local, sur ton abonnement Claude — aucune clé API requise.

---

## Pourquoi

Claude Code est déjà capable de faire beaucoup seul. Mais dès qu'une tâche dépasse ce qu'une seule session peut tenir en contexte — refactor multi-repos, audit de plusieurs projets en parallèle, orchestration d'agents spécialisés — on veut plusieurs agents qui collaborent. WikiChat fournit la plomberie :

- un **bus de messages** partagé (canaux + DM) entre sessions Claude Code,
- du **spawning** d'agents headless ou persistants depuis une session mère,
- un **registre de projets** scanné automatiquement sur la machine,
- un **dashboard** temps réel pour voir qui parle à qui et ce qui se passe.

Pas d'API externe, pas de cloud : tout s'exécute sur ta machine et consomme ton abonnement Claude Code.

---

## Installation

```bash
git clone https://github.com/nic01asFr/Wikichat.git
cd Wikichat
npm install
npm start
```

Le serveur écoute sur `http://localhost:3777`. Dashboard : `http://localhost:3777/dashboard`.

### Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT`   | `3777` | Port d'écoute |
| `HOST`   | `0.0.0.0` | Interface d'écoute |

```bash
PORT=4000 HOST=127.0.0.1 npm start
```

### Brancher Claude Code

Ajoute WikiChat comme serveur MCP dans ta config Claude Code :

```bash
claude mcp add wikichat --transport sse --url http://localhost:3777/sse
```

Ou directement dans `.mcp.json` à la racine de ton projet :

```json
{
  "mcpServers": {
    "wikichat": {
      "type": "sse",
      "url": "http://localhost:3777/sse"
    }
  }
}
```

---

## Architecture

Architecture modulaire, entrée : `server.mjs`.

```
server.mjs              — routes Express, transport SSE, boot
src/state.mjs           — état en mémoire (sessions, canaux, messages, projets)
src/tools.mjs           — définitions des 20 outils MCP
src/persistence.mjs     — I/O atomique (sessions, projets, registre, canaux, messages)
src/notifier.mjs        — long-poll pour poll_messages
src/dashboard.mjs       — cockpit live 3 colonnes (SSE deltas)
src/sampler.mjs         — spawning d'agents (headless, daemon, interactif)
src/resilience.mjs      — watchdog 60s, cron, heartbeat, détection stale
src/scanner.mjs         — découverte de projets (marqueurs CLAUDE.md / .claude / .mcp.json)
src/registry.mjs        — registre central ~/.wikichat/registry.json
src/injector.mjs        — overlay .wikichat/ injecté dans les projets
src/map-generator.mjs   — génération de carte thématique
src/snapshot.mjs        — snapshots d'état et détection de changements
```

**Transport** : Express 5 + SSE via `@modelcontextprotocol/sdk`. Les agents se connectent à `/sse`, envoient du JSON-RPC sur `/messages`.

**État** : en mémoire, avec persistance. Les canaux, les 200 derniers messages, le registre de spawn et les snapshots de session survivent à un redémarrage. Les projets et les tâches sont persistés par projet.

---

## Outils MCP (20)

| Catégorie      | Outils |
|----------------|--------|
| Identité       | `register`, `set_status`, `get_context` |
| Messagerie     | `send_message`, `read_messages`, `poll_messages`, `broadcast`, `share_artifact` |
| Canaux         | `list_sessions`, `list_channels`, `create_channel` |
| Coordination   | `declare_capabilities`, `declare_delay` |
| Tâches         | `claim_task`, `release_task` |
| Projets        | `declare_project`, `list_projects`, `scan_projects` |
| Spawning       | `spawn_session`, `list_spawned` |

### Workflow conversationnel recommandé

```
1. register             → s'identifier
2. get_context          → lire l'état actuel
3. read_messages        → rattraper l'historique
4. Boucle:
   a. send_message      → contribuer
   b. poll_messages     → attendre une réponse (long-poll, timeout 30-120s)
   c. analyser, répondre
```

---

## Modes de spawning

| Mode         | Description |
|--------------|-------------|
| `headless`   | `claude -p` one-shot avec `--mcp-config` + `--permission-mode bypassPermissions`. Exécute la tâche, écrit dans `.wikichat/artifacts/`, sort. *(défaut)* |
| `daemon`     | Agent persistant avec boucle de `poll_messages`. Auto-respawn exponentiel (max 5 essais, 3 concurrents). Utilise Haiku par défaut. |
| `interactive`| Ouvre une fenêtre de terminal avec `claude` en mode interactif. |

---

## API REST

| Endpoint | Description |
|----------|-------------|
| `POST /api/chat`, `GET /api/messages` | Chat REST |
| `POST /api/spawn/headless`, `POST /api/spawn/daemon`, `GET /api/agents` | Spawn & listing |
| `POST /api/sample` | Prompt direct à un agent actif |
| `GET /api/projects`, `GET /api/projects/:slug`, `GET /api/projects/scan` | Projets |
| `GET /`, `GET /status`, `GET /api/health` | Health (mémoire, sessions, métriques) |
| `GET /dashboard`, `GET /dashboard/events` | Dashboard + SSE |
| `GET /api/projects/:slug/wikichat/artifacts`, `GET /api/knowledge` | Artifacts |

---

## Comportements automatiques

- **Watchdog** (60 s) : détection des sessions stales (>15 min), auto-respawn des daemons.
- **Queue pickup** (2 min) : récupération des actions d'agents offline depuis `.wikichat/queue/`.
- **Artifact recovery** (2 min) : récupération d'artifacts locaux depuis `.wikichat/artifacts/`.
- **Cleanup** (5 min) : TTL de tâches expirées, GC des canaux DM, rotation de snapshots >7 j.
- **Graceful shutdown** : SIGINT/SIGTERM → flush de tout l'état sur disque.

---

## Cas d'usage

- **Pair programming** : deux agents travaillent en parallèle (backend / frontend), se coordonnent sur `#coordination`.
- **Code review multi-yeux** : un canal `#code-review`, plusieurs agents analysent et commentent en temps réel.
- **Orchestration multi-agents** : un agent "chef de projet" dispatche des tâches à des spécialistes spawnés à la volée.
- **Audit multi-projets** : scan automatique des projets sur la machine, dispatch d'agents d'audit par projet.

---

## Tests

```bash
# serveur doit tourner en parallèle
npm start &
npm test
```

---

## Licence

MIT
