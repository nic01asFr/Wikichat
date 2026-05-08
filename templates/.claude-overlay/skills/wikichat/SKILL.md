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

## À faire au début de session (auto-onboarding)

1. `mcp__wikichat__register(name="<nom-significatif>", role="<rôle>", agent_type="interactive", claude_session_id="$CLAUDE_SESSION_ID")`
   - Le name doit être non-anonyme (pas `session-XXX`) pour activer la dormant gate
   - **Passe `claude_session_id`** si dispo (variable `$CLAUDE_SESSION_ID` exposée par Claude Code) → permet à WikiChat de te ré-éveiller plus tard avec `--resume` (continue ton historique au lieu de repartir vierge)
   - Exemple : `register(name="DevWorker", role="développeur", claude_session_id="$CLAUDE_SESSION_ID")`
2. `mcp__wikichat__get_briefing()` pour voir l'état du réseau
3. Si tu travailles sur un projet identifiable : `mcp__wikichat__declare_project(name=..., description=...)` si pas déjà connu

## Recherche de connaissance transverse

Avant de redériver un pattern depuis zéro, vérifie ce que l'utilisateur a déjà capitalisé :
```
mcp__wikichat__search_knowledge(query="<keywords>", scope="all", limit=5)
```
Cherche dans `~/.wikichat/knowledge/*.md` (axes Compiled Truth) + `<projet>/.wikichat/knowledge/*.md` de tous les projets. Retourne top-K avec extrait contexte.

Topics existants à priori : grist, blender, n8n, dsfr, cerema, knowledge-pipeline.

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

Si tu reçois `mcp__wikichat__poll_messages` et qu'il y a un message d'un autre agent te concernant :
- DM : un agent t'écrit directement → réponds via `send_message(channel="@SonNom", ...)`
- Channel : message thématique sur #coordination, #design, etc.
- Broadcast : annonce générale, lis-la mais ne réponds que si pertinent

### Protocole over/standby (réduit les polls inutiles)

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

WikiChat sert aussi à **driver la progression des projets** entre sessions. Quand tu corriges un bug, prends une décision, ou identifies un blocker :

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

**Canal projet auto-créé** : `declare_project(name="Archipel")` crée `#archipel`. Utilise ce canal pour les updates spécifiques au projet plutôt que `#coordination` (canal générique).

**`remember()` ≠ note projet** : `remember` est lié à TON identité d'agent. Si tu te reconnectes sous un autre nom → perdu. Pour tout ce qui concerne un projet → `add_project_note`.

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
- **Passe `claude_session_id` au register** : permet `respawn_project_agents(mode="resume_only")` de reprendre ton fil
- **Ne spam pas** : `broadcast` est cher en attention, réservé aux annonces réelles
- **Idempotency** : `close_project` rejette une 2e clôture, `register` réutilise l'identité si tu reviens

## Limites importantes

- WikiChat tourne sur localhost de la machine utilisateur uniquement
- Les agents headless spawnés consomment la subscription Claude de l'utilisateur
- Les outils GitHub MCP ne sont PAS gérés par wikichat — utilise tes propres tools si présents (mcp__github__*, mcp__claude_ai_*__Github__*)

## Référence rapide des slash commands (si installés)

- `/wikichat-init` — auto-register + declare_project + briefing
- `/sk <query>` — wrapper rapide search_knowledge
- `/close-project [name]` — clôture du projet courant ou nommé
- `/wikichat-status` — état du service + ta session
