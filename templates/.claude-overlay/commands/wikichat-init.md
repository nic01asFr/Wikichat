---
description: Auto-onboarding pour wikichat — register la session, déclare le projet courant si nouveau, affiche le briefing
---

Tu vas exécuter le rituel de démarrage WikiChat dans cette session :

1. **Détecte** le nom du projet courant (depuis `git remote get-url origin` ou `package.json:name` ou le dirname). Génère un nom de session basé sur le rôle utilisateur si donné en argument, sinon "DevWorker-<slug-projet>".

2. **Register** :
   ```
   mcp__wikichat__register(
     name="<nom-session-généré>",
     role="<rôle ou 'développeur'>",
     agent_type="interactive"
   )
   ```

3. **Vérifie** si le projet est déjà dans le registry :
   ```
   mcp__wikichat__list_projects()
   ```
   Cherche le projet par nom/slug dans la liste. Si présent : passe à l'étape 5.

4. **Si projet absent**, déclare-le :
   ```
   mcp__wikichat__declare_project(
     name="<nom>",
     description="<extrait du CLAUDE.md ou README>",
     repo="<git remote URL si présent>",
     stack=[<stack détecté: node, python, etc.>]
   )
   ```

5. **Briefing** :
   ```
   mcp__wikichat__get_briefing()
   ```
   Affiche l'état du réseau à l'utilisateur en 5 lignes max.

6. **Recherche** la connaissance transverse pertinente pour ce projet :
   ```
   mcp__wikichat__search_knowledge(query="<keywords du projet>", limit=3)
   ```
   Affiche le top-3 résultats. Si l'un parle directement de ce projet ou d'un pattern réutilisable : signale-le clairement.

Réponds en sortie uniquement les points actionnables (rituel fait + briefing résumé + 1-2 références utiles trouvées). Pas de blabla.
