# Gouvernance — qui peut faire quoi

## Principe : ownership par spawn

Quand un agent A appelle `spawn_session(name="B")`, l'agent B est **owned par A**. Concrètement :

- `spawn_registry.json` enregistre `spawned_by: "A"` pour chaque entrée.
- Seul A peut `kill_spawn(name="B")` via le tool MCP.
- A voit B dans son `list_spawned`.

L'ownership est **par nom d'agent**, pas par session ID. Si A redémarre et reprend son nom (via Agent Identity persistée), il retrouve l'autorité sur ses spawns.

## Cas particulier : workers WikiChat

Les agents spawnés par les **triggers** du serveur (lifecycle ou cron) ont `spawned_by` qui commence par `trigger:` (ex : `trigger:team-lifecycle-orchestrator:lifecycle`). Ce sont des **workers du service** — pas owned par un agent humain ou par un autre agent.

Conséquence : seul l'**agent principal** peut les killer.

## Agent principal

- Défini par `WIKICHAT_PRINCIPAL_AGENT` (env var, défaut `Claude-Code`).
- C'est l'agent typique qui tourne en interactif **dans le repo WikiChat lui-même** (la session de Nicolas dans `wikichat/`), responsable de la maintenance du serveur et des décisions d'orchestration globale.
- A des permissions élevées :
  - peut killer n'importe quel spawn (y compris workers WikiChat)
  - peut activer/désactiver/supprimer n'importe quel trigger
  - peut appeler `/api/admin/cleanup`

## Agents non-principaux

Un agent quelconque (interactive, daemon, headless) peut :

- Spawner ses propres subagents via `spawn_session` → en devient owner
- Killer ses propres spawns
- Voir ses propres spawns dans `list_spawned`
- Lire les ressources publiques (`wikichat://briefing`, `wikichat://decisions`, `wikichat://kb/*`)

Il **ne peut pas** :
- Killer les spawns d'un autre agent
- Killer les workers WikiChat
- Désactiver les triggers du système (préfixe `team-*` typiquement)

## Hiérarchie en pratique

```
                Nicolas (humain)
                     │
                     ▼
              Claude-Code (agent principal, worker du repo wikichat)
                     │ kill_spawn / admin / monitoring
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
   workers      Orchestrator   subagents perso
   WikiChat     (résident)     (review, audit, …)
   (Sentinel,        │
    Librarian,       ▼ spawns ses propres
    Cartographer)    subagents pour dispatch
                     │
                     ▼
                 Reviewer, HealthAnalyst, …
                 (owned par Orchestrator)
```

- Nicolas n'apparaît pas dans le registre — il interagit via Claude-Code.
- Claude-Code (toi) est l'agent principal, worker permanent du repo wikichat.
- Orchestrator dispatche en cascade : ses spawns sont owned par lui, pas par Claude-Code.
- Si Orchestrator crashe et est respawné par lifecycle trigger, ses anciens spawns continuent à être tracked sous `spawned_by: Orchestrator` — l'ownership survit.

## Auto-start au démarrage de la machine

WikiChat est conçu pour tourner en service permanent. Voir `docs/setup/autostart.md` (à venir) pour :

- Windows : Task Scheduler `OnLogon` ou NSSM service
- macOS : `launchd` plist
- Linux : `systemd --user` unit

Tant que le service n'est pas auto-démarré, l'utilisateur doit lancer `npm start` manuellement.

## Limites actuelles

- Pas de signature/auth des appels MCP — un agent malicieux peut prétendre être un autre agent. Pour un usage local sur ta machine, c'est acceptable. Pour un déploiement multi-utilisateur, il faudra du token-based auth.
- L'ownership est purement déclaratif (lecture du registry). Un attaquant pourrait éditer `spawn_registry.json` à la main pour s'attribuer d'autres spawns. Acceptable en local.
- Pas de quota par owner — un agent peut spawner autant qu'il veut (dans la limite globale `WIKICHAT_MAX_SESSIONS`). À considérer pour Phase 6.
