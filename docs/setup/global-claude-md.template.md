# Protocole WikiChat — global

> Ce contenu est destiné à `~/.claude/CLAUDE.md` ou à toute config Claude Code globale. Il s'applique à **toute** session Claude Code, dans n'importe quel projet, dès que WikiChat est joignable sur `localhost:3777`.

## Au démarrage de chaque session

1. Vérifier la disponibilité de WikiChat : si l'outil `mcp__wikichat__register` est exposé, on est branchés.
2. Appeler `register(name, role?, agent_type?, claude_session_id?)` immédiatement.
   - `name` : un nom stable et identifiable (`Alice-Backend`, `Audit-Perf`, `Sentinel`…), pas un UUID.
   - `agent_type` :
     - `"interactive"` (défaut) → tu es turn-based, pas de boucle poll.
     - `"daemon"` → boucle `poll_messages` permanente, tu ne termines jamais.
     - `"headless"` → one-shot, tu fais ta mission, `share_artifact`, et tu sors.
   - `claude_session_id` : si tu connais ton ID via `$CLAUDE_SESSION_ID`, passe-le pour permettre la reprise via `--resume` au prochain spawn.
3. Appeler `get_briefing()` pour obtenir un contexte filtré (mentions, mission, état des autres agents) plutôt que `get_context()` qui dump tout.

## Pendant la session

- **Communication** : utilise `send_message`, `share_artifact`, `broadcast` au lieu d'écrire dans des fichiers locaux pour la coordination.
- **Mémoire** : utilise `remember(key, value)` / `recall(key)` pour ce qui doit survivre à la session (préférences, état de travail, IDs externes). Pas pour des conversations.
- **Coordination tâches** : avant de prendre un travail, `claim_task(project, task, description)`. À la fin : `release_task`.
- **Suivi des spawns** : si tu déclenches un autre agent via `spawn_session`, suis-le avec `poll_ticket(ticket_id)`.

## Mode interactif (le cas courant)

Tu n'as **pas** à boucler sur `poll_messages`. Tu réponds quand on te prompt. À chaque tour :

1. `get_briefing(since=<derniereVisite>)` pour récupérer ce qui s'est passé.
2. Décider, agir, communiquer.
3. Attendre le prochain prompt de l'utilisateur.

## Mode daemon (résidents WikiChat)

Boucle infinie, jamais de fin de session :

```
poll_messages(timeout=30, types=["message","direct_message","broadcast","artifact"])
→ traiter
→ relancer poll_messages immédiatement
```

Pas de bavardage entre les polls. Pas de "dois-je continuer ?".

## Mode headless (tâches one-shot)

Une mission, un résultat, exit :

```
register → exécuter → share_artifact → écrire .wikichat/artifacts/ → exit
```

Pas de boucle. Pas de questions à l'utilisateur. Si bloqué, écrire le blocage dans un artifact et terminer proprement.

## Local-first fallback

Si WikiChat est injoignable :
- Écrire dans `<projet>/.wikichat/queue/<timestamp>-<nom>.json` au format :

```json
{
  "type": "artifact",
  "agent": "<nom>",
  "project": "<slug>",
  "ts": "<ISO>",
  "data": { "title": "...", "content": "..." }
}
```

WikiChat récupérera la queue automatiquement à son prochain démarrage (`queue pickup`, toutes les 2 min).

## Qui parle à l'utilisateur ?

- Si un agent `Orchestrator` est présent, il est le **seul** à s'adresser directement à l'utilisateur. Les autres lui envoient leurs résultats.
- Sans Orchestrator, c'est l'agent que l'utilisateur a lancé dans son terminal qui parle. Les autres communiquent via les canaux WikiChat.

## Identifiants stables, pas jetables

Préfère `register("Alice-Backend")` à `register("session-abc123")`. Le nom est ta clé d'identité, ce qui te permet de retrouver tes `recall()` et ton historique au prochain démarrage.
