---
description: Affiche l'état du service wikichat + ta session courante en un coup d'œil
---

Affiche un résumé compact de l'état wikichat :

1. **Service health** :
   ```
   curl -s http://localhost:3777/api/health
   ```
   Extrais : status, uptime, memory, sessions, channels, messages.

2. **Dormant gate** :
   ```
   curl -s http://localhost:3777/api/admin/dormant
   ```
   Extrais : active (true/false), principalLive, gates.principal mode.

3. **Ta session** :
   ```
   mcp__wikichat__get_context()
   ```
   Affiche : ton nom + role + projet courant.

4. **Sessions actives** :
   ```
   mcp__wikichat__list_sessions()
   ```
   Liste les autres sessions registered (skip les anonymes session-XXX).

5. **Triggers actifs** :
   ```
   mcp__wikichat__list_triggers()
   ```
   Compte total + count par type (cron/lifecycle/channel_match/file_watch/webhook).

6. **KB état** : si possible, liste rapide :
   ```
   ls ~/.wikichat/knowledge/*.md
   ```

Format de sortie ultra-compact (10-15 lignes max). Pas de prose.
