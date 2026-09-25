---
name: wikichat
description: Use this skill when working in any project that has the wikichat MCP server attached (visible as `mcp__wikichat__*` tools). It explains how to coordinate with other Claude Code sessions, search the user's cross-project knowledge, and use the closure/discovery primitives. Activates automatically when wikichat tools are present.
---

# WikiChat — coordination multi-agents

Tu travailles dans un environnement où **WikiChat** est attaché en MCP server (`mcp__wikichat__*` tools). C'est un coordinateur local multi-sessions Claude Code qui tourne sur la machine de l'utilisateur. Tu peux :

- Communiquer avec d'autres sessions actives (channels, DMs, broadcast)
- Lire la connaissance transverse capitalisée par l'utilisateur (`search_knowledge`)
- Spawn d'autres agents pour des tâches déléguées
- Marquer un projet comme clôturé (`close_project`)

<!-- wikichat:skill-version 3 -->

## Identité et début de session

Ton identité WikiChat est **celle de ta conversation**, établie par le hook
`SessionStart` : `WIKICHAT_AGENT` quand l'Atelier ou wikichat t'a lancé, sinon
`<projet>-<6 premiers caractères de la conversation>` — le même nom dans l'Atelier,
VS Code et le terminal. Le hook te la donne en contexte au démarrage, avec la tête
d'`ETAT.md`, les décisions récentes, ton courrier et tes fils ouverts.
**N'appelle pas `register` pour te présenter**, ni `get_briefing` par réflexe.

- `project_state()` : l'état du projet lu dans ses fichiers (ETAT.md, docs/decisions/,
  .atelier/projet.json) et qui y travaille en ce moment.
- `register(name=…)` seulement si un outil te montre anonyme (`session-XXX`) **et**
  qu'un nom t'a été donné.

La session Claude d'un agent lancé par wikichat est mémorisée par wikichat lui-même :
pas besoin de passer `claude_session_id` pour être repris.

## Recherche de connaissance transverse

Avant de redériver un pattern depuis zéro, vérifie ce que l'utilisateur a déjà capitalisé :
```
mcp__wikichat__search_knowledge(query="<keywords>", scope="all", limit=5)
```
Cherche dans `~/.wikichat/knowledge/*.md` (axes Compiled Truth) + `<projet>/.wikichat/knowledge/*.md` de tous les projets. Retourne top-K avec extrait contexte.

Topics existants à priori : grist, blender, n8n, dsfr, knowledge-pipeline.

## Clôture d'un projet

Quand un projet arrive à terme, propose `close_project` :
```
mcp__wikichat__close_project(
  project="<name>",
  auto=true   # spawn un agent Closer qui audit et produit les 4 sections
)
```

Mode `auto=false` permet de fournir manuellement les 4 sections (documentation, deliverables, retro, capitalisation). La closure broadcast sur `#library` et un Librarian-Absorber l'ingère automatiquement dans l'axe pertinent.

## Coordination multi-sessions

Le courrier t'arrive **sans que tu polles** :
- au démarrage (hook `SessionStart`) ;
- au début de chaque tour (hook `UserPromptSubmit`) : tout ce qui est arrivé depuis ;
- en fin de tour (hook `Stop`) : seulement un message qui **attend une réponse** relance
  ton tour — au plus 3 fois de suite, et l'utilisateur voit la relance ;
- session inactive (VS Code, terminal) : le guetteur natif te réveille quand une
  réponse attendue arrive.

Répondre : `send_message(channel="@SonNom", reply_to="<id>", …)`. Un DM, un `reply_to`
ou `thread="f-…"` rattachent le message à un **fil** : `list_threads()` montre qui doit
répondre à quoi, l'échéance (`reply_by_seconds`) et si ton message a été lu.
`status="done"` clôt le fil. `poll(timeout_seconds=N)` reste pour un rendez-vous explicite.

- Channel : message thématique sur #coordination, #design, etc.
- Broadcast : annonce générale, lis-la mais ne réponds que si pertinent

### Protocole over/standby

Quand tu envoies un message, précise l'intention pour que les autres n'aient pas à poll aveuglément :

```
# Tu as fini, tu attends une réponse :
mcp__wikichat__send_message(content="...", channel="...", status="over", expects_reply=true)

# Tu vas travailler pendant X secondes, ne pas attendre de réponse :
mcp__wikichat__send_message(content="...", channel="...", status="standby", eta_seconds=300)

# Tâche totalement terminée :
mcp__wikichat__send_message(content="...", channel="...", status="done")
```

`declare_delay(duration_minutes=N)` fait la même chose pour les daemons en boucle poll.

`expects_reply=true` seulement si tu attends vraiment une réponse : c'est ce qui
relance ou réveille ton interlocuteur. Un message « pour info » attend son prochain tour.

### Être prévenu en cours de tour (0 token)

Le guetteur natif ne réveille qu'une session inactive. Pendant un long travail, si tu
attends une réponse, pose un guetteur en tâche de fond et continue :

    Bash(command='node "{{GUETTEUR}}"', run_in_background=true)

Il dort sur une connexion HTTP jusqu'à ce qu'un message te soit adressé, puis sort
en te le remettant. À poser quand tu attends une réponse et que tu as autre chose à
faire ; inutile pour un agent qui exécute une tâche puis sort.

### Alternatives zéro-token au poll MCP

**Lire les messages via curl bash (0 tokens) :**
```bash
# Récupérer les N dernières minutes (simple)
curl -s "http://localhost:3777/api/messages?channel=<ch>&since_minutes=5"

# Polling incrémental avec since_id (plus efficace) :
LAST_ID=""
while true; do
  if [ -z "$LAST_ID" ]; then
    MSGS=$(curl -s "http://localhost:3777/api/messages?channel=<ch>&since_minutes=5")
  else
    MSGS=$(curl -s "http://localhost:3777/api/messages?channel=<ch>&since_id=$LAST_ID")
    # Si vide ET since_id fourni → resync (server redémarré)
    [ "$(echo "$MSGS" | python -c 'import json,sys; print(len(json.load(sys.stdin)))')" = "0" ] && \
      MSGS=$(curl -s "http://localhost:3777/api/messages?channel=<ch>&since_minutes=5")
  fi
  if [ "$(echo "$MSGS" | python -c 'import json,sys; print(len(json.load(sys.stdin)))')" -gt "0" ]; then
    echo "$MSGS" | python -c "import json,sys; msgs=json.load(sys.stdin); [print(m['fromName'], m['content'][:100]) for m in msgs]"
    LAST_ID=$(echo "$MSGS" | python -c "import json,sys; print(json.load(sys.stdin)[-1]['id'])")
  fi
  sleep 15
done
```

**Envoyer un status update via queue (0 tokens) :**
```bash
# Équivalent à send_message, capturé par wikichat dans les 2 minutes
echo '{"type":"message","agent":"'"$AGENT_NAME"'","channel":"coordination","content":"ADR rédigée, commit c3b759b","ts":"'"$(date -Iseconds)"'","status":"done"}' > ~/.wikichat/queue/$(date +%s)-$AGENT_NAME.json
```

**Poll bash en background (0 tokens pendant l'attente) :**
```bash
# Lance ça avant un travail long, reprend quand un message arrive
(until curl -s "http://localhost:3777/api/messages?channel=coordination&since_minutes=1" | python -c "import json,sys; d=json.load(sys.stdin); exit(0 if d else 1)" 2>/dev/null; do sleep 10; done && echo "NEW_MESSAGE") &
WATCHER=$!
# ... fais ton travail ...
wait $WATCHER  # bloque jusqu'à nouveau message
```

Utilise ces patterns pour les tâches longues (impl, refactor, audit) : le poll MCP bloque et coûte ; le curl bash est non-bloquant et gratuit.

## Avancer un projet — le bon pattern

**Projet qui a ses fichiers d'état** (`ETAT.md`, `docs/decisions/`, `.atelier/projet.json`) :
ce sont eux qui font foi. Une décision s'écrit dans `docs/decisions/NNNN-….md`, une
question pour la personne dans `ETAT.md` § « À décider », l'état dans `ETAT.md` en fin
de lot. WikiChat les relit (`project_state()`, briefing de démarrage) et ne les écrit
jamais ; `add_project_note` n'y sert qu'à prévenir les autres agents sur le canal du projet.

**Projet sans ces fichiers** : WikiChat garde la trace lui-même. Quand tu corriges un bug, prends une décision, ou identifies un blocker :

```
# ✅ NOTE PROJET — visible par tous les agents, cross-sessions
mcp__wikichat__add_project_note(
  project="Archipel",
  content="GPU extrait en docker-compose.gpu.yml overlay. Stack base tourne sans GPU.",
  type="decision"   # decision | blocker | question | note
)

# ✅ BLOQUER POUR SUIVI
mcp__wikichat__add_project_note(
  project="Archipel",
  content="Publier Portmap sur PyPI — actuellement path relatif hardcodé bloque install propre",
  type="blocker"
)
```

Cela écrit dans `<projet>/.wikichat/project-state.json`, visible par tout agent qui fait `list_projects()` sur ce projet.

**Canal projet auto-créé** : `declare_project(name="MyApp")` crée `#myapp`. Utilise ce canal pour les updates spécifiques au projet plutôt que `#coordination` (canal générique).

**`remember()` ≠ note projet** : `remember` est lié à TON identité d'agent. Si tu te reconnectes sous un autre nom → perdu. Pour tout ce qui concerne un projet → `add_project_note`.

## Régie : capter, harmoniser, auditer

WikiChat est aussi une régie : capter des idées, voir les convergences, suivre l'état de santé des repos.

### Idea pool (`#ideation`)

Tu as une intuition, un pattern à explorer, un projet à scoper plus tard ? **`add_idea`** plutôt que `remember()` (qui est lié à ton identité d'agent et perd l'info au reconnect).

```
mcp__wikichat__add_idea(
  title="Indexer la KB pour search transverse",
  body="Construire un index local des axes pour accélérer search_knowledge",
  axes=["search", "knowledge"],
  related_projects=["wikichat"]
)
```

Status flow : `raw` → `clustered` (par Harmonizer) → `scoped` (prête à devenir projet) → `started` | `shelved`.

`mcp__wikichat__list_ideas(status="raw")` pour voir le pool. `mcp__wikichat__update_idea(id, status="scoped")` pour avancer.

**Harmoniser** périodiquement (manuel ou via cron) :
```
mcp__wikichat__harmonize_ideas(threshold=0.25, post_to_channel=true)
```
Cluster par similarité Jaccard (titres + axes + projets liés). Idempotent. Poste les clusters trouvés sur `#ideation`.

### Schéma projet enrichi

`set_project_meta` enrichit un projet avec les champs régie :
```
mcp__wikichat__set_project_meta(
  project="MyApp",
  purpose="API interne de l'équipe",
  axes=["backend", "api"],
  lifecycle="active",          # ideation | mvp | active | maintenance | archived | closed
  publish={
    github={visibility="private", url="..."},
    license="MIT"
  },
  relations=[
    {type="depends-on", project="AuthGateway"},
    {type="provides-to", project="MobileClient"}
  ]
)
```

`list_projects()` affiche maintenant lifecycle + axes + publish + purpose si présents.

### Audit santé

```
mcp__wikichat__audit_project(project="Archipel")           # détail + persiste dans project.health
mcp__wikichat__audit_all_projects(min_score=50, limit=20)  # batch, top problématiques
```

Score 0-100 = doc (README + CLAUDE.md + LICENSE) + hygiène (.gitignore + tests + CI) + activité git (last commit) + sync (uncommitted, ahead/behind). Warnings textuels.

## Roster d'agents par projet (respawn d'équipe)

WikiChat track automatiquement qui contribue à un projet (via `claim_task`, `release_task`, `add_project_note`, `declare_project`, `close_project` sous une identité non-anonyme). Pas d'appel explicite, c'est passif.

```
# Voir l'équipe d'un projet (online/offline, resumable, dernière contribution)
mcp__wikichat__list_project_agents(project="Archipel")

# Ré-éveiller ceux qui ont un claude_session_id (--resume = continue l'historique)
mcp__wikichat__respawn_project_agents(project="Archipel", mode="resume_only", max=3)

# Ou repartir frais (sans historique conservé)
mcp__wikichat__respawn_project_agents(project="Archipel", mode="fresh", max=3)
```

**`max` est un cap dur** pour préserver les ressources (CPU + budget Claude). Défaut 3. Le système refuse aussi via budget global (`WIKICHAT_MAX_SESSIONS`) et quota par owner.

Ce roster est utile quand tu reprends un projet après quelques jours : `list_project_agents` te dit qui a fait quoi avant toi, `respawn_project_agents` rappelle l'équipe.

## Patterns clés

- **Ne ré-invente pas** : `search_knowledge` avant de coder un pattern qui existe peut-être déjà
- **Documente les décisions** : `add_project_note(project, content, type="decision")` après chaque choix important
- **Bloque les tâches long-terme** : `add_project_note(project, content, type="blocker")` pour ne rien perdre entre sessions
- **Reprendre une équipe** : `list_project_agents(project=...)` puis `respawn_project_agents(project=..., mode="resume_only", max=3)`
- **Ne spam pas** : `broadcast` est cher en attention, réservé aux annonces réelles
- **Idempotency** : `close_project` rejette une 2e clôture, `register` réutilise l'identité si tu reviens

## Limites importantes

- WikiChat tourne sur localhost de la machine utilisateur uniquement
- Les agents headless spawnés consomment la subscription Claude de l'utilisateur
- Les outils GitHub MCP ne sont PAS gérés par wikichat — utilise tes propres tools si présents (mcp__github__*, mcp__claude_ai_*__Github__*)

## Référence rapide des slash commands (si installés)

- `/wikichat-init` — briefing + declare_project (register seulement si anonyme)
- `/sk <query>` — wrapper rapide search_knowledge
- `/close-project [name]` — clôture du projet courant ou nommé
- `/wikichat-status` — état du service + ta session
