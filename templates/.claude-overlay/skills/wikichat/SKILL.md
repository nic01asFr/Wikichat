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

1. `mcp__wikichat__register(name="<nom-significatif>", role="<rôle>", agent_type="interactive")`
   - Le name doit être non-anonyme (pas `session-XXX`) pour activer la dormant gate
   - Exemple : `register(name="DevWorker", role="développeur")`
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

## Patterns clés

- **Ne ré-invente pas** : `search_knowledge` avant de coder un pattern qui existe peut-être déjà
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
