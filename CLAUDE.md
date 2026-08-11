# CLAUDE.md

## Project Overview

**WikiChat** is a local service that gives a development machine a memory across projects, lets independently-opened Claude Code sessions talk to each other, and keeps working in the background. Deterministic detectors watch for events; agents are spawned only when one occurs. Runs on the user's subscription — no API keys.

## Commands

```bash
npm start                    # Start server (localhost:3777, dormant)
npm run dev                  # Start with auto-reload
node test-e2e.mjs            # E2E tests (server must be running)
PORT=3777 HOST=127.0.0.1 npm start  # Override defaults
```

Pilote (agents planifiés + file d'approbation) : `http://localhost:3777/pilote`

Les autres interfaces (dashboard, cockpit, console, régie) ont été supprimées :
aucune n'était utilisée, et l'état du service se lit via `GET /api/health`,
`GET /status`, ou depuis une session Claude Code via les outils MCP.

## Background service (recommandé)

Le service est conçu pour tourner en tâche de fond, **dormant à 0% CPU** quand
personne ne l'utilise, et qui s'éveille automatiquement quand tu ouvres Claude
Code. Le boot est géré par l'OS (logon Windows / launchd macOS / systemd-user
Linux).

```bash
node scripts/install-service.mjs    # auto-start au logon
node scripts/uninstall-service.mjs  # désinstaller
```

Cycle de vie automatique :
1. **Allumage machine** → service démarré, dormant (0% CPU, triggers cron schedulés mais ne firent pas)
2. **Tu ouvres Claude Code** → register de toi-même → `dormant_gate` s'ouvre → les triggers deviennent armés
3. **Un événement survient** (commit, artefact, mention) → un agent headless est spawné, agit, et sort
4. **Tu fermes Claude Code** → 5min grace period → idle gate kicks in → 0% CPU

Les daemons résidents (Sentinel/Librarian/Orchestrator) ont été retirés : ils
consommaient 28,4 M tokens d'entrée en 506 tours de poll pour 3 actes utiles en
trois mois. Leur fonction est reprise par la détection déterministe + triggers.
`npm run start:team` et `--with-team` existent encore mais ne provisionnent que
des triggers ; les trois triggers lifecycle correspondants sont désactivés.

### Variables d'environnement utiles

- `WIKICHAT_AUTONOMOUS_TEAM=1` : active la team (sinon triggers décoratifs)
- `WIKICHAT_PRINCIPAL_GATE` : `any-named` (défaut) | `strict` | `0`
  - `any-named` : tout session non-anonyme registered active la team
  - `strict` : seul `WIKICHAT_PRINCIPAL_AGENT` (défaut "Claude-Code") compte
  - `0` : pas de gate principal (registry seul décide)
- `WIKICHAT_DORMANT_DISABLED=1` : toujours actif (legacy, déconseillé)
- `WIKICHAT_DORMANT_GRACE_MS=300000` : grace period avant mise en sommeil (défaut 5min)
- `WIKICHAT_MAX_RESUME_MB=5` : plafond de transcript repris via `--resume`
- `WIKICHAT_MAX_SESSIONS=30` : budget de spawn concurrent

## Distribution principle

**Le contenu vit dans les projets, WikiChat ne fait que pointer.**

- `<projet>/.wikichat/artifacts/` — artefacts produits par les agents
- `<projet>/.wikichat/queue/` — actions offline (recovery au boot)
- `<projet>/.wikichat/state-snapshot.json` — git/files snapshot
- `<projet>/.wikichat/project-state.json` — **state du projet** : tasks, decisions, blockers, closure (anciennement centralisé dans `wikichat/projects/<slug>.json`, migré local automatiquement à la 1ère save)
- `<projet>/.wikichat/instructions.md` + `context.json` — boilerplate par projet
- `<projet>/.wikichat/roles/` — overrides locaux des rôles

Côté wikichat (mairie, légitimement central) :
- `~/.wikichat/registry.json` — index des paths projet, **enrichi avec `github` field** (URL remote, owner, repo, visibility) détecté par scanner via `git remote`
- `~/.wikichat/triggers.json` — config triggers
- `~/.wikichat/clusters/<date>.json` + `cartography/<date>.json` — vues transverses
- `~/.wikichat/knowledge/` — Compiled Truth du Librarian (KB transverse), markdown plain
- `wikichat-repo/.wikichat/messages.json` — derniers messages (cap MAX_MESSAGES, défaut 2000)
- `wikichat-repo/projects/` — fallback pour projets déclarés sans repo réel

### Sources externes (GitHub, APIs) — DÉLÉGATION aux agents

WikiChat ne fetche jamais GitHub/GitLab/APIs lui-même. Le scanner enrichit le registry avec `github.url` détecté localement, et les prompts d'agents (Librarian-Compiler, Librarian-Absorber) mentionnent "si tu as des tools GitHub MCP disponibles, sers-t'en". Cela évite de gérer auth/rate-limiting/cache côté wikichat — l'utilisateur a déjà son tooling MCP configuré, les agents l'utilisent à la demande.

Pattern : `wikichat orchestre + state local`, `agents exécutent + tool use`. Les sources externes deviennent des capacités d'agents, pas des features wikichat.

Bénéfice : `git add .wikichat/` dans chaque projet sauvegarde naturellement la connaissance projet. Tu peux déplacer un projet entre machines, sa state suit.

## Architecture

Modular — 25 files in `src/`, entry point `server.mjs`. ~11 000 lines total.

```
server.mjs          — Express routes, SSE transport, boot sequence
src/state.mjs       — In-memory state (sessions, channels, messages, projects)
src/tools.mjs       — 49 MCP tool definitions
src/persistence.mjs — Atomic file I/O (sessions, projects, spawn registry, channels, messages)
src/events.mjs      — Event bus: deterministic detectors → #insights → triggers
src/triggers.mjs    — Trigger engine (cron, mention, channel_match, file_watch, webhook, lifecycle)
src/routines.mjs    — Named multi-step workflows, idempotent by run_key
src/notifier.mjs    — Long-poll waiter system for poll_messages
src/sampler.mjs     — Agent spawning (headless, daemon, interactive) + --resume resolution
src/resilience.mjs  — Watchdog (60s), cron persistence, heartbeat, stale detection
src/snapshot.mjs    — Per-project change detection (git, CLAUDE.md, deps, files)
src/scanner.mjs     — Filesystem project discovery (CLAUDE.md/.claude/.mcp.json markers)
src/registry.mjs    — Central project registry (~/.wikichat/registry.json)
src/identity.mjs    — Per-agent persistent memories (remember/recall)
src/dormant.mjs     — Wake/sleep gate
src/pilote.mjs      — Scheduled agents, proposer contract, approval queue (UI /pilote)
src/injector.mjs    — Safe .wikichat/ overlay injection into projects
src/jobs/           — Cartography, clustering
```

**Event model** — the core mechanism: a JavaScript detector costs nothing while
it finds nothing; when it does, it publishes `[event:type project:x] summary` on
`#insights`, and a `channel_match` trigger spawns the right agent. Types emitted:
`commits`, `branch`, `uncommitted`, `git-init`, `claude-md`, `deps`, `version`,
`files`, `new-project`, `artifact`, `queue`, `stale`, `task-expired`.

**State** is in-memory with persistence: channels, last 2000 messages, spawn registry, and session snapshots survive restarts. Projects and tasks are persisted per-project.

**Transport:** Express 5 + SSE (`/sse`) using `@modelcontextprotocol/sdk`. Agents connect via SSE, send JSON-RPC to `/messages`.

## Agent Spawning Modes

- **headless** (default): `claude -p` one-shot with `--mcp-config` + `--permission-mode bypassPermissions`. Executes task, writes to `.wikichat/artifacts/`, exits.
- **daemon**: Persistent agent looping on poll_messages. Expensive — a poll loop re-reads its whole history each turn, so cost grows quadratically. Prefer a trigger. Auto-respawn capped at 5.
- **interactive**: Opens a terminal window with `claude` in interactive mode.

Named agents resume their previous session (`--resume`) when the transcript still
exists and is under `WIKICHAT_MAX_RESUME_MB` (5 MB); otherwise they start fresh.

## MCP Tools (49 total)

**Identity:** register, set_status, get_briefing, remember, recall, forget
**Messaging:** send_message, read_messages, poll, poll_messages, broadcast, share_artifact
**Channels:** list_sessions, list_channels, create_channel
**Coordination:** declare_capabilities, declare_delay, claim_task, release_task
**Projects:** declare_project, list_projects, set_project_meta, add_project_note, close_project, scan_projects, purge_registry, audit_project, audit_all_projects
**Project agents:** list_project_agents, respawn_project_agents
**Knowledge:** search_knowledge
**Ideas:** add_idea, get_idea, list_ideas, update_idea, harmonize_ideas
**Spawning:** spawn_session, contact_agent, list_spawned, kill_spawn, poll_ticket
**Routines:** register_routine, list_routines, run_routine, delete_routine
**Triggers:** register_trigger, list_triggers, fire_trigger, set_trigger_enabled, delete_trigger
**Background jobs:** run_cartography, run_clustering

## REST API

**Chat:** POST /api/chat, GET /api/messages
**Spawn:** POST /api/spawn/headless, POST /api/spawn/daemon, GET /api/agents
**Sample:** POST /api/sample (direct prompt to live agent)
**Projects:** GET /api/projects, GET /api/projects/:slug, GET /api/projects/scan
**Health:** GET /, GET /status, GET /api/health (memory, sessions, metrics)
**Artifacts:** GET /api/projects/:slug/wikichat/artifacts, GET /api/knowledge
**Webhook:** POST /api/triggers/webhook/:id (fire a webhook trigger from anywhere)
**Pilote:** GET /pilote + /pilote/api/* (scheduled agents, approval queue)

## Automatic Behaviors

- **Watchdog** (60s): stale detection >15min, daemon auto-respawn
- **Queue pickup** (2min): recovers offline agent actions from .wikichat/queue/
- **Artifact recovery** (2min): recovers local artifacts from .wikichat/artifacts/
- **Cleanup** (5min): expired task TTLs, DM channel GC, snapshot rotation >7d
- **Graceful shutdown**: SIGINT/SIGTERM flushes all state to disk

## Key Patterns

- **Event-first**: les détecteurs JS publient sur #insights, les triggers spawnent à la demande — aucun agent ne veille
- **MCP-first preamble**: headless agents register() immediately, use MCP tools for all communication, local artifacts as backup
- **Channel count cache**: O(1) via Map, updated in pushMessage/eviction
- **Spawn registry**: cached in-memory with 2s debounced disk writes
- **Atomic writes**: tmp file + rename pattern everywhere
