# Cadrage système — WikiChat comme service de coordination machine

> Document de cadrage avant nouvelles implémentations.
> Sert de référence pour les choix d'architecture et la priorisation.
> **À valider** point par point avant que l'équipe ne code.

---

## 1. Vision

WikiChat est un **service système permanent**, lancé au démarrage de la machine, qui sert de **mairie** à tous les projets et à tous les agents Claude Code locaux.

```
                       MACHINE
                          │
            ┌─────────────┴──────────────┐
            ▼                            ▼
       WikiChat (service)           Projets de l'utilisateur
       répertoire central                  │
       ~/repo/wikichat/                    │
            │                              │
            ├─ serveur node (auto-start)   │
            ├─ ~/.wikichat/ (state)        │
            ├─ registry des projets ───────┘
            └─ agent principal worker
                (Claude-Code dans ce repo)
```

### Trois niveaux d'entités

| Entité | Description | Exemple |
|---|---|---|
| **Repo wikichat** | Le centre. Sert le service à toute la machine. | `~/repo/wikichat/` |
| **Projets connectés** | Tout repo de l'utilisateur enregistré dans le registry WikiChat. | `~/repo/panoramax3d/`, `~/repo/IISR-Audit/` |
| **Agents** | Sessions Claude Code connectées via MCP. | Toi, moi, Sentinel, un Reviewer ponctuel… |

### Quatre catégories d'agents

| Catégorie | Type | Origine | Cycle de vie |
|---|---|---|---|
| **Agent principal** | interactive | session de l'utilisateur dans `~/repo/wikichat/` | tant que l'utilisateur est devant son ordi, lancée par lui |
| **Workers WikiChat** | daemon | spawnés par triggers du service au boot | tant que le service tourne |
| **Agents projet** | interactive ou daemon | session lancée par l'utilisateur dans un projet connecté | quand l'utilisateur travaille sur ce projet |
| **Subagents (spawns)** | headless ou daemon | spawnés par n'importe quel agent ci-dessus | bornés à leur tâche (headless) ou tant que owner vivant (daemon) |

---

## 2. État actuel — ce qui est déjà en place (commits sur `main`)

### Plomberie de base
- ✅ Serveur Express + SSE + MCP SDK v1.12 (12 modules dans `src/`)
- ✅ 20+ tools MCP, 5 resources MCP
- ✅ Persistance atomique (sessions, projets, registry, channels, messages, memories)
- ✅ Watchdog 60s + queue pickup 2min + cleanup 5min
- ✅ Graceful shutdown SIGINT/SIGTERM avec flush

### Identité & coordination
- ✅ `register(name, role, agent_type, claude_session_id)` avec restoration auto
- ✅ `agent_type ∈ {interactive, daemon, headless}` → workflow hint adapté
- ✅ `remember/recall/forget` — mémoire persistante par nom
- ✅ `get_briefing` filtré par `lastSeen`, mentions, mission
- ✅ MCP Resources : `wikichat://briefing | role/X | identity/X | decisions | kb/X`
- ✅ Canal `#decisions` au format `[DECISION] sujet | conclusion | rationale | qui`

### Spawning
- ✅ `spawn_session(mode = headless | daemon | interactive)` avec ticket retourné
- ✅ `poll_ticket(ticket_id)` long-poll de fin de spawn
- ✅ `--resume <claude_session_id>` pour continuité contexte
- ✅ Resource budget global `WIKICHAT_MAX_SESSIONS` (défaut 10)
- ✅ Sur Windows, daemons en `detached: false` → meurent avec le serveur (plus d'orphelins)

### Background jobs
- ✅ `runCartography()` — scan + diff snapshot + map
- ✅ `runClustering()` — Jaccard sur deps/langs/tags, clusters union-find
- ✅ Tools `run_cartography` / `run_clustering` exposés

### Triggers (Phase 5 PR1)
- ✅ Module `triggers.mjs` : `cron`, `lifecycle`, garde-fous (cooldown, max_per_day, idempotence, budget)
- ✅ 5 tools : `register_trigger`, `list_triggers`, `fire_trigger`, `set_trigger_enabled`, `delete_trigger`
- ✅ Persistance `~/.wikichat/triggers.json`

### Équipe autonome
- ✅ `team-bootstrap.mjs` opt-in (`WIKICHAT_AUTONOMOUS_TEAM=1`)
- ✅ 6 triggers définis : 3 lifecycle (Orchestrator, Sentinel, Librarian) + 3 cron (cartography 6h, clustering dim. 3h, digest 22h)
- ✅ docs/teams/autonomous-team.md

### Lifecycle & gouvernance
- ✅ `daemon-lifecycle.mjs` : `reconcileDaemonsAtBoot` + `shutdownDaemons` + `fullCleanup`
- ✅ Endpoint `POST /api/admin/cleanup`
- ✅ Tool `kill_spawn(name)` avec règle d'ownership (owner ou principal)
- ✅ docs/governance.md

### Setup public
- ✅ `docs/setup/INSTALL.md`
- ✅ `docs/setup/global-claude-md.template.md`
- ✅ `injector.mjs` : whitelist `mcp__wikichat__*` + `enabledMcpjsonServers`

---

## 3. Ce qui manque pour la vision complète

### A — Auto-start service au démarrage machine
- [ ] Script Windows : Task Scheduler `OnLogon` ou installer NSSM
- [ ] Script macOS : `launchd` plist
- [ ] Script Linux : `systemd --user` unit
- [ ] Documentation `docs/setup/autostart.md`

### B — Renforcement agent principal
- [ ] Au boot, vérifier qu'une session `WIKICHAT_PRINCIPAL_AGENT` est joignable. Si oui, l'utiliser comme superviseur. Sinon, fonctionner en mode dégradé.
- [ ] Resource MCP `wikichat://principal` qui expose l'identité et les permissions de l'agent principal
- [ ] Channel dédié `#principal` pour les directives de l'agent principal aux daemons

### C — Quotas par owner (Phase 6)
- [ ] Cap quotidien par `spawned_by` (ex: max 50 spawns/jour par owner)
- [ ] Cap concurrent par owner (ex: max 5 spawns simultanés par owner)
- [ ] Garde-fou : un owner ne peut pas spawner si son cap est atteint

### D — Permissions plus fines
- [ ] Liste blanche de tools accessibles selon `agent_type` (un headless ne peut pas appeler `register_trigger` par exemple)
- [ ] Audit log : journal de toutes les actions admin (kill_spawn, register_trigger, etc.) sous `~/.wikichat/audit.jsonl`

### E — Triggers manquants
- [ ] Type `file_watch` (chokidar) — pour `.wikichat/inbox/`
- [ ] Type `git_hook` — post-commit dans projets connectés
- [ ] Type `channel_match` — regex sur message
- [ ] Type `mention` — `@AgentName` quand l'agent est offline → spawn auto
- [ ] Type `threshold` — métrique > seuil
- [ ] Type `webhook` — POST `/api/triggers/:id/fire`

### F — Background jobs restants
- [ ] B.2 `project-health-pulse` (analyse santé hebdo par projet via Sonnet)
- [ ] B.4 `Librarian` daemon avec format Compiled Truth dans `~/.wikichat/knowledge/`
- [ ] B.5 `inbox-triage` (file_watch sur `.wikichat/inbox/**`)
- [ ] B.6 `night-watch` (Sentinel ping toutes les 30min 22h–6h)

### G — Stabilité & propreté observée pendant les tests
- [ ] **Bug noté** : sur certaines sessions, `spawn_registry` accumule des entrées `running` avec PID mort sans que reconcile les nettoie tant que le serveur ne reboot pas. Ajouter un check périodique (toutes les 5min) sur PID des entrées running.
- [ ] **Improvement** : claude.exe orphelins de jours précédents pollue le système. Tool admin `wipe_orphans` qui détecte et nettoie les claude.exe spawnés par WikiChat dans le passé (par filtre cmdline contenant `--mcp-config <path>/wikichat`).

### H — Multi-utilisateur (futur, pas court terme)
- [ ] Auth token côté MCP — chaque session signe ses requêtes
- [ ] Liaison `agent_name ↔ token` pour empêcher l'usurpation

---

## 4. Décisions architecturales à valider AVANT d'implémenter

> Chaque ✅/❌ ici détermine la suite. Réponds avant qu'on code.

### Q1 — Service auto-start
**Le repo wikichat doit-il fournir un installateur "service auto-start" public**, ou est-ce une affaire purement locale Nicolas (instructions doc seulement) ?
- Option A : Script `npm run install-service` qui installe via Task Scheduler (Windows) / launchd (mac) / systemd (Linux).
- Option B : Documentation pas-à-pas, l'utilisateur fait à la main.

### Q2 — Agent principal toujours présent ?
Quand le serveur démarre **sans** que tu aies lancé une session Claude Code dans le repo wikichat (ex : reboot machine, tu n'as pas encore ouvert ton IDE) :
- Option A : Le serveur démarre **et** spawn lui-même un agent principal headless si manquant (= un Claude Code "système" tourne en daemon dédié).
- Option B : Le serveur démarre **sans** agent principal. Tant que tu n'as pas lancé ta session, les workers tournent en mode "self-managed" (Sentinel + Librarian seuls, sans superviseur).
- Option C : Désactiver tous les triggers (workers + cron) tant qu'aucun agent principal n'est connecté. Mode "dormant".

### Q3 — Spawns daemon récursifs autorisés ?
Un daemon (ex: Orchestrator) peut-il spawner ses propres daemons enfants, ou seulement des headless ?
- Option A : libre — tout agent peut spawner n'importe quel mode.
- Option B : seuls les daemons **résidents** (workers WikiChat) peuvent spawner d'autres daemons. Les autres ne peuvent que headless.
- Option C : seul l'agent principal peut autoriser un spawn daemon (workflow d'approbation).

### Q4 — Workers tournent même sans projet enregistré ?
Si le registry est vide (machine fraîche, aucun projet scanné) :
- Option A : Les workers tournent quand même (Sentinel surveille les events système, Librarian construit une KB vide).
- Option B : Les workers ne démarrent qu'à partir du moment où ≥1 projet est dans le registry (sinon rien à faire).

### Q5 — Quotas
Veux-tu un quota par owner dès maintenant, ou on laisse pour Phase 6 ?

### Q6 — Auto-respawn des daemons sur Windows
Avec `detached: false`, un daemon meurt avec le serveur. Au prochain boot, il est respawné par lifecycle trigger. Mais pendant qu'il est mort, il ne tourne pas.
- Acceptable ? (= service down → équipe down, redémarrage manuel requis)
- Ou doit-on garder `detached: true` et accepter le risque d'orphelins (mitigé par reconcile + cleanup) ?

---

## 5. Plan d'implémentation proposé (ordre)

> À ré-arbitrer selon les réponses ci-dessus.

1. **Cadrage** (ce document) — review & valider Q1–Q6
2. **Phase 6.1 — Service auto-start** (3h)
   Selon Q1 : script + doc, ou doc seule.
3. **Phase 6.2 — Agent principal** (3h)
   Selon Q2 : daemon principal optionnel + resource MCP `wikichat://principal`
4. **Phase 6.3 — Quotas par owner** (2h, si Q5 = oui maintenant)
5. **Phase 6.4 — Triggers manquants** (file_watch + git_hook + channel_match + mention) — 5h
6. **Phase 6.5 — Background jobs restants** (Librarian Compiled Truth, project-health-pulse) — 5h
7. **Phase 6.6 — Audit log + permissions par agent_type** — 2h

**Total ~20h** d'implémentation après cadrage. Shippable en PR séparées comme avant.

---

## 6. Hors scope (pour mémoire)

- Auth multi-utilisateur (Phase 7+)
- UI dashboard améliorée (filtres, graph clustering visualisé)
- Intégration cloud (sync entre machines)
- Webhooks Slack/email pour escalation hors-machine
