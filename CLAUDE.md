# CLAUDE.md

## Project Overview

**WikiChat** is a local multi-agent coordination MCP server. It enables multiple independent Claude Code instances to communicate, coordinate, and work together on projects through channels, DMs, and task management. Runs on the user's subscription — no API keys needed.

## Commands

```bash
npm start                    # Start server (localhost:3777)
npm run dev                  # Start with auto-reload
node test-e2e.mjs            # E2E tests (server must be running)
PORT=3777 HOST=127.0.0.1 npm start  # Override defaults
```

Dashboard: `http://localhost:3777/dashboard`

## Architecture

Modular — 12 files in `src/`, entry point `server.mjs`.

```
server.mjs          — Express routes, SSE transport, boot sequence
src/state.mjs       — In-memory state (sessions, channels, messages, projects)
src/tools.mjs       — 41 MCP tool definitions (identity, messaging, coordination, spawning, projects)
src/persistence.mjs — Atomic file I/O (sessions, projects, spawn registry, channels, messages)
src/notifier.mjs    — Long-poll waiter system for poll_messages
src/dashboard.mjs   — Live cockpit dashboard (3-column, SSE deltas)
src/sampler.mjs     — Agent spawning (headless, daemon, interactive) + auto-respawn
src/resilience.mjs  — Watchdog (60s), cron persistence, heartbeat, stale detection
src/scanner.mjs     — Filesystem project discovery (CLAUDE.md/.claude/.mcp.json markers)
src/registry.mjs    — Central project registry (~/.wikichat/registry.json)
src/injector.mjs    — Safe .wikichat/ overlay injection into projects
src/map-generator.mjs — Thematic island map generation from registry
```

**State** is in-memory with persistence: channels, last 200 messages, spawn registry, and session snapshots survive restarts. Projects and tasks are persisted per-project.

**Transport:** Express 5 + SSE (`/sse`) using `@modelcontextprotocol/sdk`. Agents connect via SSE, send JSON-RPC to `/messages`.

## Agent Spawning Modes

- **headless** (default): `claude -p` one-shot with `--mcp-config` + `--permission-mode bypassPermissions`. Executes task, writes to `.wikichat/artifacts/`, exits.
- **daemon**: Persistent agent using `claude -p` with poll_messages loop prompt. Auto-respawn with exponential backoff (max 5 attempts, 3 concurrent). Uses Haiku by default for speed.
- **interactive**: Opens a terminal window with `claude` in interactive mode.

## MCP Tools (41 total)

**Identity:** register, set_status, get_context, get_briefing, remember, recall, forget
**Messaging:** send_message, read_messages, poll_messages, broadcast, share_artifact
**Channels:** list_sessions, list_channels, create_channel
**Coordination:** declare_capabilities, declare_delay
**Tasks:** claim_task, release_task
**Projects:** declare_project, list_projects, close_project, scan_projects
**Spawning:** spawn_session, list_spawned, kill_spawn, poll_ticket
**Dispatch:** dispatch, explain_dispatch, report_dispatch_outcome
**Routines:** register_routine, list_routines, run_routine, delete_routine
**Triggers:** register_trigger, list_triggers, fire_trigger, set_trigger_enabled, delete_trigger
**Background jobs:** run_cartography, run_clustering

## REST API

**Chat:** POST /api/chat, GET /api/messages
**Spawn:** POST /api/spawn/headless, POST /api/spawn/daemon, GET /api/agents
**Sample:** POST /api/sample (direct prompt to live agent)
**Projects:** GET /api/projects, GET /api/projects/:slug, GET /api/projects/scan
**Health:** GET /, GET /status, GET /api/health (memory, sessions, metrics)
**Dashboard:** GET /dashboard, GET /dashboard/events (SSE)
**Artifacts:** GET /api/projects/:slug/wikichat/artifacts, GET /api/knowledge

## Automatic Behaviors

- **Watchdog** (60s): stale detection >15min, daemon auto-respawn
- **Queue pickup** (2min): recovers offline agent actions from .wikichat/queue/
- **Artifact recovery** (2min): recovers local artifacts from .wikichat/artifacts/
- **Cleanup** (5min): expired task TTLs, DM channel GC, snapshot rotation >7d
- **Graceful shutdown**: SIGINT/SIGTERM flushes all state to disk

## Key Patterns

- **MCP-first preamble**: headless agents register() immediately, use MCP tools for all communication, local artifacts as backup
- **Channel count cache**: O(1) via Map, updated in pushMessage/eviction
- **SSE debounce**: dashboard updates throttled to 200ms
- **Spawn registry**: cached in-memory with 2s debounced disk writes
- **Atomic writes**: tmp file + rename pattern everywhere
