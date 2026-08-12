# WikiChat — architecture de référence

> Document unique. Remplace les documents morcelés `cadrage-systeme.md`, `governance.md`, `teams/autonomous-team.md`. Mis à jour au fur et à mesure des décisions.
>
> Référence : Claude Anthropic (subagents, hooks, MCP), Claude Cowork (orchestrator + routines), patterns service (systemd / launchd / Task Scheduler).

---

## 1. Une phrase

WikiChat est un **service local de coordination multi-agents** : il tourne en permanence sur la machine, indexe les projets de l'utilisateur, et permet à des agents Claude Code de communiquer, déléguer, mémoriser et exécuter des routines partagées.

---

## 2. Modèle conceptuel — la "mairie" de la machine

```
                  ┌──────────────────────┐
                  │      MACHINE          │
                  └──────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │ WikiChat │  │ Projet A │  │ Projet B │
        │  (mairie) │  │ (citoyen)│  │ (citoyen)│
        └──────────┘  └──────────┘  └──────────┘
              │             │             │
              ▼             ▼             ▼
     Maire + résidents   spawns        spawns
     (workers WikiChat)  ponctuels    ponctuels
```

| Entité | Rôle | Localisation |
|---|---|---|
| **Mairie** | service WikiChat | `~/repo/wikichat/` |
| **Citoyen (projet connecté)** | repo de l'utilisateur enregistré | `~/repo/<projet>/` |
| **Maire** | agent principal Claude Code dans le repo wikichat | session interactive |
| **Résidents** | rôles de service (Sentinel, Librarian, Orchestrator) | lancés par un trigger quand un événement le justifie, puis sortent |
| **Visiteurs** | agents projet & subagents ad-hoc | sessions de l'utilisateur ou spawns |

---

## 3. Stack runtime — 3 couches composables

```
┌──────────────────────────────────────────────────────────┐
│ 3. ROUTINE      workflow nommé, paramétrable, idempotent │
│                  multi-étape (séquentiel ou parallèle)   │
└──────────────────────────────────────────────────────────┘
                            ▲
                            │ appelée par
┌───────────────────────────┴──────────────────────────────┐
│ 2. TRIGGER                                               │
│   cron, lifecycle, file_watch, mention, channel_match,   │
│   webhook — un prédicat JS, aucun modèle appelé tant     │
│   qu'il ne matche pas                                    │
└──────────────────────────────────────────────────────────┘
                            ▲
                            │ appelle
┌───────────────────────────┴──────────────────────────────┐
│ 1. SPAWN — primitive de plus bas niveau                  │
│   spawn_session(name, mode={headless,daemon,interactive}) │
│   ticket retourné, claude_session_id mémorisé pour       │
│   --resume au prochain spawn (continuité contexte)       │
└──────────────────────────────────────────────────────────┘
```

**Conséquence design** : plus aucune action n'a de logique métier inline. Un trigger appelle une routine ; la routine compose des spawns. Un seul endroit où la séquence est définie.

> **Une couche retirée.** Il existait un étage `DISPATCH` — router une intention
> vers le « meilleur » agent selon des capacités déclarées et un historique de
> succès. Utilisé une fois en quatre mois. La sélection par score supposait une
> population d'agents stable et comparable ; en pratique l'appelant sait toujours
> qui il veut, ou bien il spawne. Retiré avec `declare_capabilities` comme
> alimentation de scoring — l'outil subsiste, mais comme simple déclaration
> lisible par les humains.

---

## 4. Cycle de vie machine

```
[boot OS]
    ↓
[service WikiChat démarre — auto-start via Task Scheduler / launchd / systemd]
    ↓
[loadTriggers + loadRoutines + loadMemories + reconcileDaemonsAtBoot]
    ↓
[mode DORMANT]
    │  Pas de cron armé, pas de spawn lifecycle. Serveur écoute SSE.
    │
    │  ◀── le Maire ouvre VS Code dans ~/repo/wikichat/ et register
    │       (name=Claude-Code, agent_type=interactive, claude_session_id=$ID)
    ▼
[mode ACTIF — réveil]
    │  • Crons armés
    │  • Lifecycle triggers fire (Sentinel + Librarian si projet enregistré ≥1)
    │  • Maire reçoit son briefing initial via wikichat://briefing
    │
    │  ◀── activité normale (chat, routines, spawns)
    │
    │  ◀── Maire se déconnecte (ferme VS Code)
    ▼
[grâce 5min — toujours actif]
    │  Le Maire peut revenir.
    ▼
[mode DORMANT — sleep]
    │  Triggers désarmés. Aucun agent en vie.
    │  Service tourne (pour répondre à un wake-up futur).
```

**Pas de daemon idle qui tourne dans le vide.** Quand le Maire n'est pas là,
personne ne veille. Les crons tombés pendant le sommeil sont rejoués une fois au
réveil (`catchupMissedCrons`) : sans ce rattrapage, une routine programmée la
nuit — précisément à l'heure où personne n'est là — ne s'exécutait jamais.

---

## 5. Les 6 primitives MCP essentielles

Chaque agent connecté dispose de :

### A. Identité
- `register(name, role?, agent_type, claude_session_id?)` — auto-restore skills/projet/memories
- `remember(key, value)` / `recall(key?)` / `forget(key)` — store K/V persisté par nom
- `set_status(status)` — état lisible

### B. Communication
- `send_message(channel, content, reply_to?, expects_reply?, status?, priority?)` — DM via `@nom` ; `priority` diffuse à toutes les sessions
- `poll(timeout_seconds?)` — relève tout ce qui t'est adressé depuis ton dernier passage. Sans argument : instantané. Le curseur est tenu côté serveur sur ton nom, et c'est le même que celui du hook de fin de tour — donc ni doublon ni oubli, quel que soit le chemin par lequel un message arrive.
- `read_messages(channel, since)` — lecture d'un canal à la demande, hors boîte
- `share_artifact(channel, title, type, content)` — output structuré

`poll_messages(timeout, types?)` existe encore pour compatibilité, mais boucler
dessus est le mode coûteux qu'on a retiré : une veille permanente relit tout son
historique à chaque tour. Un agent nommé hors ligne mentionné avec
`expects_reply=true` est relancé par le trigger de réveil ; un agent en session
reçoit son courrier par le hook, en fin de tour.

### C. Coordination
- `declare_capabilities(skills, current_project, availability)` — déclaration lisible de ce qu'on sait faire
- `claim_task(project, task)` / `release_task` — éviter les doublons

### D. Spawn (primitive bas niveau)
- `spawn_session(name, repo_path, mode, role?, initial_task?)` — retourne ticket
- `poll_ticket(ticket_id, timeout_seconds)` — long-poll de fin
- `kill_spawn(name)` — owner-only (ou Maire)
- `list_spawned()` — descendants

### E. Routine (workflow nommé)
- `register_routine(id, params_schema, steps, description?)`
- `list_routines()` / `run_routine(id, params)` / `delete_routine(id)`

### F. Trigger (événement → routine ou spawn)
- `register_trigger(id, type, config, action_type, action_params, cooldown_s?, max_per_day?)`
- `list_triggers()` / `fire_trigger(id, force?)` / `set_trigger_enabled(id, enabled)` / `delete_trigger(id)`

**Total : 51 tools MCP.** La liste complète, par catégorie, est dans le README —
c'est elle qui fait foi, ce document décrit les primitives structurantes.

---

## 6. Resources MCP — pour VS Code et autres clients

| URI | Contenu | Usage |
|---|---|---|
| `wikichat://briefing` | filtré par session : mentions + nouveau depuis lastSeen + projets actifs | démarrage rapide d'un agent |
| `wikichat://principal` | identité + statut du Maire (connected / dormant / not-set) | routing decisions |
| `wikichat://identity/{name}` | snapshot + memories d'un agent | inspecter un autre agent |
| `wikichat://decisions` | dernier 50 décisions structurées | KB de plus haute valeur |
| `wikichat://kb/{topic}` | knowledge base (Compiled Truth) | recherche thématique |
| `wikichat://routines` | toutes les routines disponibles + last_run | catalogue exécutable |
| `wikichat://routine/{id}` | définition + statistiques d'une routine | inspecter une workflow |
| `wikichat://role/{name}` | role.md (sentinel, librarian, …) | bootstrap de prompt |
| `wikichat://triggers` | triggers actifs + prochain fire | observabilité |

VS Code + Claude Code lisent automatiquement ces resources → l'agent humain a tout le contexte sans appeler de tool.

---

## 7. Gouvernance

### Hiérarchie
1. **Maire** (env `WIKICHAT_PRINCIPAL_AGENT`, défaut `Claude-Code`) — peut tout
2. **Résidents WikiChat** (rôles lancés par les triggers du système) — peuvent spawner d'autres agents headless
3. **Agents projet** (sessions interactives de l'utilisateur sur ses repos) — peuvent spawner headless
4. **Subagents headless** — exécutent leur mission, share_artifact, exit. Ne peuvent pas spawner.

### Règles
- **Ownership** : `entry.spawned_by == caller.name` → owner
- Workers WikiChat ont `spawned_by: "trigger:..."` → owned par le service, killables seulement par le Maire
- **Quotas par owner** :
  - Subagent / projet : 50/jour, 5 concurrent
  - Maire / résidents : 200/jour, 15 concurrent
  - `wikichat-service` : illimité (workers)
- **Profondeur** : `spawn_depth ≤ 3` (Maire → résident → spawn → spawn-de-spawn = 3 max)
- **Mode** : seul un résident peut spawner un daemon enfant. Tous les autres = headless uniquement.

### Audit
Chaque spawn est tracé dans le registre de spawn (`spawn_registry.json`) : qui l'a lancé, quand, avec quel prompt, et comment il s'est terminé.

---

## 8. Cockpit — une seule page, 5 panneaux

```
┌───────────────────────────────────────────────────────────────┐
│ WIKICHAT COCKPIT                            ● Maire connecté │
├───────────────┬───────────────────────────────────────────────┤
│ INBOX         │ TIMELINE LIVE (SSE)                           │
│ • 3 mentions  │ 14:32 [#decisions] DECISION: opt-in team      │
│ • 2 décisions │ 14:28 [→spawn] Reviewer headless lancé        │
│ • 1 PR review │ 14:15 [✓routine] nightly-digest done in 2m    │
│               │ ...                                            │
├───────────────┼───────────────────────────────────────────────┤
│ ÉTAT MACHINE  │ ROUTINES                          [+ new]    │
│ ● Sentinel    │ project-audit          last 14:32 ✓  [▶]     │
│ ● Librarian   │ nightly-digest         next 22:00 ⏰  [edit]  │
│ ○ Orchestrator│ pr-review              -          [▶]         │
│ Budget 4/10   │                                                │
├───────────────┼───────────────────────────────────────────────┤
│ DISPATCH      │ TRIGGERS                          [+ new]    │
│ Intent [____] │ team-lifecycle-sentinel    🟢 every boot      │
│ [Send →]      │ team-cron-cartography      🟢 0 */6 * * *     │
│ Last: ✓ in 8s │ ...                                            │
└───────────────┴───────────────────────────────────────────────┘
```

Drill-down accessible via clic :
- Click sur un agent → vue agent (identity + memories + spawns + timeline)
- Click sur une routine → vue routine (steps + history + run avec params)
- Click sur un projet → vue projet (carte clustering, agents actifs, artifacts)

### Tray icon (optionnel, v4)
- 🟢 healthy, 🟠 mention en attente, 🔴 budget critique
- Click = ouvre /pilote
- Notif OS sur escalation urgent

---

## 9. Auto-start machine — un seul script

```bash
npm run install-service
```

Détection OS :
- **Windows** → `schtasks /create /tn WikiChat /tr "node ..." /sc ONLOGON /rl HIGHEST`
- **macOS** → écrit `~/Library/LaunchAgents/com.wikichat.plist` + `launchctl load`
- **Linux** → écrit `~/.config/systemd/user/wikichat.service` + `systemctl --user enable --now`

Et symétriquement `npm run uninstall-service`. Doc fallback `docs/setup/autostart.md` si l'auto-installer ne couvre pas ton cas.

---

## 10. Fichiers et états sur disque

```
~/.wikichat/                         (état machine, géré par WikiChat)
├── registry.json                    projets connectés
├── routines.json                    catalogue de workflows
├── triggers.json                    triggers actifs
├── memories.json                    K/V par nom d'agent
├── audit.jsonl                      log append-only
├── cartography/                     carte historique par jour
├── clusters/                        relations inter-projets par jour
├── knowledge/                       KB Compiled Truth (Librarian)
│   └── <topic>.md
└── projects/<slug>/                 cache par projet

<repo wikichat>/                     (le service lui-même)
├── server.mjs                       boot + listen
├── src/
│   ├── state.mjs                    in-memory state
│   ├── persistence.mjs              I/O atomique
│   ├── tools.mjs                    23 outils MCP
│   ├── resources.mjs                10 resources MCP
│   ├── identity.mjs                 register + memories
│   ├── triggers.mjs                 moteur d'événements
│   ├── routines.mjs                 moteur de workflows
│   ├── sampler.mjs                  spawn (headless/daemon)
│   ├── daemon-lifecycle.mjs         reconcile + shutdown
│   ├── team-bootstrap.mjs           opt-in default team
│   └── jobs/                        cartography, clustering, …
├── docs/
│   ├── architecture.md              ce fichier
│   ├── setup/{INSTALL.md, autostart.md, global-claude-md.template.md}
│   ├── roles/{sentinel,librarian,orchestrator,reviewer,subagent}.md
│   └── teams/autonomous-team.md
└── public/                          pilote.html (agents planifiés + approbations)

<projet connecté>/                   (citoyen — non modifié sauf .wikichat/)
└── .wikichat/                       overlay injectée
    ├── context.json                 lu par les agents au boot
    ├── instructions.md              protocole local-first
    ├── queue/                       fallback offline
    ├── artifacts/                   sortie locale + récupérée
    └── roles/                       overrides de roles
```

---

## 11. Sécurité & limites assumées

- **Single-user, machine locale.** Pas d'auth multi-utilisateur. Un agent malicieux peut prétendre être un autre. Acceptable parce que tous les agents sont lancés par toi.
- **Pas de network exposure**. Serveur écoute sur `127.0.0.1:3777` (HOST par défaut). Pour exposer sur LAN il faudra ajouter auth tokens (Phase 7+).
- **Budget Anthropic** capé par `--max-budget-usd 5` par session + quotas owner. Pas de cap global $/jour aujourd'hui (à ajouter Phase 7).
- **Pas de chiffrement** des memories — fichiers JSON en clair. Si secrets sensibles dedans, c'est ton choix.

---

## 12. Ce qui a été construit puis retiré

Ce projet a produit plusieurs sous-systèmes qui fonctionnaient et n'ont pas
survécu à la mesure de leur usage. Les garder ici évite de les réinventer.

| Retiré | Ce que ça faisait | Pourquoi |
|---|---|---|
| **Dispatch** | routait une intention vers le « meilleur » agent, par capacités déclarées et historique de succès | 1 usage en 4 mois. L'appelant sait toujours qui il veut, ou il spawne |
| **Daemons résidents** | Sentinel, Librarian, Orchestrator en boucle de poll permanente | 28,4 M tokens d'entrée en 506 tours pour 3 actes utiles en 3 mois. Une veille relit tout son historique à chaque tour |
| **Six interfaces web** | dashboard, cockpit, console, régie… | zéro ouverture. L'état se lit par `GET /api/health` ou depuis une session |
| **Auto-respawn du watchdog** | relançait un agent détecté mort | jamais déclenché en 54 entrées de registre |

Le fil commun : un mécanisme écrit, jamais confronté à son usage réel. C'est
aussi ce qu'a révélé la campagne de tests — la porte dormante condamnait toute
installation neuve, le hook de boîte n'était installé par rien, et un trigger
qui « remontait » n'atteignait aucune boîte. Trois défauts invisibles sur la
machine de développement.

---

## 13. Hors scope (différé)

- Multi-utilisateur, auth tokens, network exposure
- UI mobile / web hostée (/pilote reste local seulement)
- Sync inter-machines (chaque machine a son WikiChat indépendant)
- Webhooks externes (Slack, email) — possibles via routine custom mais pas built-in
- Modèles autres qu'Anthropic (Claude only)
