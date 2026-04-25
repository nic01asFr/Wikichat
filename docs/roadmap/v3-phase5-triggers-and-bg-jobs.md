# V3 Phase 5 — Triggers + Background Jobs

> Statut : roadmap, non implémenté.
> Auteur·s : équipe d'agents v3 (sessions Claude-Code × Claude-Web × spawns)
> Pré-requis : Phase 1–4 mergée (`feat/v3-protocol`).

## Objectif

Donner à WikiChat la capacité de **déclencher du travail tout seul** :
- Spawner des daemons/headless en réaction à des événements (commits, messages, fichiers, horloge)
- Maintenir des jobs de fond qui cartographient, analysent, rapprochent et documentent les projets en continu
- Sans que Nicolas ait à lancer manuellement quoi que ce soit après le boot du serveur

C'est ce qui transforme WikiChat de "salon de chat MCP partagé" en **plateforme d'intelligence ambiante**.

---

## Partie A — Triggers

### Module à créer : `src/triggers.mjs`

Persistance dans `~/.wikichat/triggers.json`. Tools MCP : `register_trigger`, `list_triggers`, `enable_trigger`, `disable_trigger`, `fire_trigger`. Endpoints REST symétriques.

### Schéma trigger

```js
{
  id: "nightly-digest",
  type: "cron",                       // cron | file_watch | git_hook | channel_match | mention | threshold | lifecycle | webhook
  config: { schedule: "0 22 * * *", tz: "Europe/Paris" },
  action: { type: "spawn_session", params: { repo_path, name, mode: "daemon", role } },
  enabled: true,
  cooldown_s: 3600,                   // anti-bouclage
  max_per_day: 5,                     // garde-fou quota
  last_fired: null,
  fire_count: 0,
}
```

### Garde-fous obligatoires

| Risque | Mitigation |
|---|---|
| Boucle (file_watch sur path qui se modifie via spawn) | `cooldown_s` + path-allowlist |
| Quota Anthropic explosé | `max_per_day` + pré-check `checkBudget()` |
| Daemon déjà running re-spawné | idempotence par `name` |
| Path traversal | resolve + assert sous projets enregistrés uniquement |
| Cron pendant maintenance | env `WIKICHAT_TRIGGERS_DISABLED=1` |

### Types — ordre d'implémentation

| # | Type | Effort | Pourquoi en premier ? |
|---|---|---|---|
| 1 | `cron` | 1h | Réutilise `node-cron` (déjà en deps via crons.json), couvre déjà 60% des besoins |
| 2 | `lifecycle` (au boot) | 0.5h | Spawn auto des résidents Sentinel/Librarian/Orchestrator au démarrage |
| 3 | `channel_match` + `mention` | 1h | Hook dans `pushMessage`, regex sur content |
| 4 | `file_watch` | 2h | `chokidar`, watch de `.wikichat/inbox/`, `.wikichat/queue/`, paths projet |
| 5 | `git_hook` | 1h | injector écrit un `post-commit` → `curl /api/triggers/fire` |
| 6 | `webhook` | 0.5h | route REST `POST /api/triggers/:id/fire` |
| 7 | `threshold` | 1h | tick toutes les 60s, évalue prédicats sur état serveur |

**Total ~7h** pour le moteur complet. Ship en 3 phases : (1+2), (3+5+6), (4+7).

---

## Partie B — Background Jobs prévus

Tous ces jobs sont **des triggers + des spawns**. Pas de runtime spécial.

### B.1 Cartographie continue

**État actuel :** `scanForProjects` est appelé une seule fois au boot si `autoScan` activé. `generateMap` produit une carte mais doit être appelé manuellement. `scanForChanges` (snapshot.mjs) calcule les diffs mais n'est branché à rien.

**Job proposé :** `cartography-refresh`
- Trigger : `cron "0 */6 * * *"` (toutes les 6h)
- Action : spawn headless `Cartographer`
- Mission : `scanForProjects` → `mergeProjects` → pour chaque projet changé : `collectSnapshot` → `detectChanges` → si changement significatif, `share_artifact` sur `#cartography`
- Sortie : `~/.wikichat/cartography/<date>.json` + carte mise à jour via `generateMap`

### B.2 Analyse de santé par projet

**Mission Phase 5 :** mesurer la santé de chaque projet enregistré.

**Job proposé :** `project-health-pulse`
- Trigger : `cron "0 8 * * 1"` (lundi 8h)
- Action : pour chaque projet du registry → spawn headless `HealthAnalyst`
- Mission : lire `git log --since=7d`, `.wikichat/artifacts/`, blockers déclarés, tâches abandonnées (TTL expiré). Produire un score `{activity, momentum, debt, risk}`.
- Sortie : `share_artifact` `health/<projet>.md` sur `#coordination` + `wikichat://kb/health/<projet>` accessible via MCP Resources
- Garde-fous : limiter à 3 spawns concurrents (le HealthAnalyst lit beaucoup, peut prendre 1–2 min)

### B.3 Rapprochement inter-projets

**Mission Phase 5 :** détecter les **similarités structurelles** entre projets (mêmes deps, mêmes patterns de code, équipes communes, technos partagées) → recommander la mutualisation.

**Job proposé :** `cross-project-clustering`
- Trigger : `cron "0 3 * * 0"` (dimanche 3h)
- Action : spawn headless `Matchmaker` (Sonnet, plus de raisonnement)
- Mission : pour chaque paire de projets, calculer un score de similarité (Jaccard sur deps `package.json`/`pyproject.toml`, tags, langages détectés). Spotter les "îlots reliés" (ex: panoramax3d ↔ wikichat-game partagent 3 deps + thème "interface 3D").
- Sortie : graphe `~/.wikichat/clusters/<date>.json` + artifact `#cartography` + map updaté avec liens
- Bonus : peut suggérer des refactors transverses ("ces 4 projets ré-implémentent le même HTTP client")

### B.4 Documentation continue (Librarian)

**État actuel :** `docs/roles/librarian.md` existe en template. Pas de daemon Librarian en exécution.

**Job proposé :** Librarian comme **daemon résident** + jobs scheduled.
- **Trigger lifecycle au boot** : si pas de Librarian en running, en spawner un (Haiku, daemon, timeout 120s)
- **Trigger cron `"0 22 * * *"`** : Librarian reçoit un broadcast "digest mode" → switch en mode Sonnet pour 30 min, lit tous les artifacts du jour, consolide en `~/.wikichat/knowledge/<topic>.md` au format Compiled Truth (état au-dessus du `---`, timeline append-only en-dessous)
- **Trigger channel_match `#library`** : tout artifact partagé sur `#library` → Librarian l'absorbe et update le topic correspondant
- Sortie : `wikichat://kb/<topic>` toujours frais via MCP Resources

### B.5 Triage de l'inbox

**Job proposé :** `inbox-triage`
- Trigger : `file_watch <projet>/.wikichat/inbox/**/*.md`
- Action : spawn headless `Triager`
- Mission : classer le doc déposé (bug report ? idée ? PR à reviewer ? note ?), router vers le bon canal/agent, déplacer le fichier de `inbox/` vers `processed/`.

### B.6 Garde nocturne

**Job proposé :** `night-watch`
- Trigger : `cron "*/30 22-6 * * *"` (toutes les 30min entre 22h et 6h)
- Action : Sentinel (déjà résident en daemon) reçoit un ping → vérifie : crashes, files de queue/, agents stales, budget proche du cap
- Sortie : `broadcast urgent` si problème critique, sinon silence radio

---

## Partie C — Liens avec ce qui existe déjà

| Fait/Module existant | Réutilisé par |
|---|---|
| `scanForProjects` ([scanner.mjs]) | B.1 cartography-refresh |
| `generateMap` ([map-generator.mjs:183]) | B.1, B.3 |
| `scanForChanges` / `collectSnapshot` / `detectChanges` ([snapshot.mjs]) | B.1, B.2 |
| `injectProject` ([injector.mjs]) | B.5 (déposer roles + git-hook côté projet) |
| Watchdog 60s ([resilience.mjs]) | exécuteur des `threshold` triggers |
| `pickupQueue` / `readLocalArtifacts` | B.5 (triage déclenché par fichier détecté) |
| `share_artifact` + `wikichat://kb/{topic}` Resources | sortie de B.2, B.3, B.4 |
| `loadCronRegistry` | déjà du cron persisté côté agents — **on l'étend au serveur** |

**Pas de réinvention** — la Phase 5 connecte des briques existantes via le module `triggers.mjs`.

---

## Estimation totale

| Bloc | Effort |
|---|---|
| Moteur triggers (Partie A complète) | ~7h |
| Job B.1 cartography | 1h (mostly câblage) |
| Job B.2 health pulse | 2h (HealthAnalyst prompt + scoring) |
| Job B.3 clustering | 4h (Matchmaker + similarité) |
| Job B.4 Librarian | 3h (daemon + Compiled Truth format) |
| Job B.5 inbox triage | 1h |
| Job B.6 night-watch | 0.5h |
| **Total Phase 5** | **~18h** |

Shippable en 3 PR distinctes :
1. `feat/v3-triggers-engine` — triggers.mjs + cron + lifecycle (3h)
2. `feat/v3-bg-cartography` — B.1 + B.3 (5h)
3. `feat/v3-bg-knowledge` — B.4 Librarian + B.2 health pulse (5h)

Le reste (file_watch, git_hook, webhook, B.5, B.6) en itérations suivantes selon usage réel.

---

## Décision en attente

- [ ] Validation Nicolas pour entamer Phase 5 dès le push v3 mergé
- [ ] Choix : on push v3 d'abord (10 commits actuels) puis on attaque Phase 5, ou on accumule encore ?
