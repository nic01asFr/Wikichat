# Équipe autonome supervisée

À partir de Phase 5, WikiChat peut provisionner **une équipe d'agents auto-organisée** dès le démarrage du serveur, supervisée par un agent unique : **Orchestrator**.

## Composition

```
                       Nicolas
                          ↑
                 #directives | #general
                          ↓
                  ┌──────────────┐
                  │ Orchestrator │  (daemon, Sonnet)
                  │  superviseur  │
                  └──┬─────────┬─┘
                     │         │
              dispatch         agrège
                     │         │
       ┌─────────────┼─────────┼─────────────┐
       ↓             ↓         ↓             ↓
   Sentinel      spawns       …          Librarian
   (daemon       headless                (daemon
    Haiku)       ponctuels                Haiku)
       │
   alerte
       │
       └→ détecte event → DM Orchestrator
```

- **Orchestrator** est le seul agent qui parle directement à l'utilisateur.
- **Sentinel** et **Librarian** sont en arrière-plan, communiquent uniquement avec Orchestrator (DM) ou via leurs canaux dédiés (`#library`, `#digest`).
- Les **subagents headless** (Reviewer, Cartographer, HealthAnalyst, Matchmaker, Triager) sont spawnés à la demande, font leur tâche, partagent un artifact, exit.

## Provisionnement (opt-in)

> ⚠️ **Désactivé par défaut.** L'équipe résidente consomme des tokens même au repos (~$1/jour). Active explicitement avec `WIKICHAT_AUTONOMOUS_TEAM=1 npm start`.

Une fois activé, `src/team-bootstrap.mjs` enregistre 6 triggers :

| Trigger | Type | Effet |
|---|---|---|
| `team-lifecycle-orchestrator` | lifecycle (`if_no_session_named:Orchestrator`) | Spawn Orchestrator daemon Sonnet si absent |
| `team-lifecycle-sentinel` | lifecycle | Spawn Sentinel daemon Haiku |
| `team-lifecycle-librarian` | lifecycle | Spawn Librarian daemon Haiku |
| `team-cron-cartography` | cron `0 */6 * * *` | Spawn Cartographer headless toutes les 6h |
| `team-cron-clustering` | cron `0 3 * * 0` | Spawn Matchmaker headless dimanche 3h |
| `team-cron-digest` | cron `0 22 * * *` | Broadcast `[DIGEST]` à Librarian sur `#library` à 22h |

Idempotent : si tu redémarres le serveur, les triggers existants sont préservés. Pour forcer la re-création : `WIKICHAT_TEAM_RESET=1 npm start`.

## Activer / désactiver

- Activer : `WIKICHAT_AUTONOMOUS_TEAM=1 npm start`
- Désactivé par défaut sans cette variable
- Pour effacer une équipe déjà provisionnée : supprime `~/.wikichat/triggers.json` (ou utilise `delete_trigger` pour chaque `team-*`)

## Configurer manuellement une équipe sur mesure

Tu peux ignorer le bootstrap par défaut et écrire tes propres triggers via les outils MCP :

```
register_trigger(
  type="lifecycle",
  config={condition:"if_no_session_named:MyAgent"},
  action_type="spawn_session",
  action_params={name:"MyAgent", role:"...", mode:"daemon", task:"..."}
)
```

Et autant de triggers cron que voulu pour tes jobs récurrents.

## Comment Orchestrator supervise

Orchestrator est un daemon classique (`agent_type="daemon"`). Sa supervision passe par :

1. **Visibilité** : `get_briefing()` ou `wikichat://briefing` lui donne en un appel l'état du réseau (sessions, projets, mentions, tâches actives).
2. **Identité des autres** : `wikichat://identity/Sentinel` pour voir leurs memories, leur dernier état, leurs skills déclarés.
3. **Dispatch** : `spawn_session(mode="headless", initial_task="...")` pour déléguer une tâche bornée. Reçoit un `ticket_id`.
4. **Suivi** : `poll_ticket(ticket_id, timeout_seconds=120)` pour attendre la fin et récupérer le résultat.
5. **Coordination** : `claim_task` / `release_task` pour éviter les doublons.
6. **Mémoire** : `remember("last_dispatch", ...)` et `recall(...)` pour garder le fil entre cycles de poll.
7. **Escalation** : `broadcast(priority="urgent")` ou DM à Nicolas si décision humaine requise.

## Observer l'équipe

Côté humain, trois surfaces :

- **Dashboard** : `http://localhost:3777/dashboard` — sessions live + 3 dernières activités + heartbeat
- **Resources MCP** dans VS Code : `wikichat://briefing`, `wikichat://identity/<nom>`, `wikichat://decisions`, `wikichat://kb/<topic>`
- **Canal `#general`** : où Orchestrator rapporte les conclusions agrégées des sous-tâches

Tu n'as pas à lire les 200 messages de coordination des subagents — Orchestrator filtre et te remonte seulement ce qui demande ton attention.

## Coût en tokens

- Orchestrator (Sonnet, daemon idle) : ~$0.50/jour si timeout poll = 120s
- Sentinel + Librarian (Haiku, daemons idle) : ~$0.20/jour combinés
- Subagents headless ponctuels : payés à l'usage réel (Cartographer ~30s ≈ $0.005, ReviewAgent ~1min ≈ $0.01)

Soit ~**$1/jour de présence d'équipe** + le coût des tâches effectivement exécutées. Le `--max-budget-usd 5` injecté par `sampler.mjs` reste un cap dur par session.

## Garde-fous

- `WIKICHAT_MAX_SESSIONS` (défaut 10) plafonne le nombre total de sessions concurrentes (résidents + spawns en cours)
- Chaque trigger a `cooldown_s` et `max_per_day`
- `idempotence` : un nouveau spawn avec un `name` déjà actif est refusé
- Si un daemon crashe, watchdog le relance (max 5 fois, backoff exponentiel)
- `WIKICHAT_TRIGGERS_DISABLED=1` désactive complètement le moteur
