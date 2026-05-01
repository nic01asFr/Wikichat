---
description: Recherche rapide dans la knowledge transverse wikichat (~/.wikichat/knowledge/ + .wikichat/knowledge/ des projets). Usage : /sk <query>
---

Cherche dans la knowledge wikichat avec la query : `$ARGUMENTS`

Exécute :
```
mcp__wikichat__search_knowledge(query="$ARGUMENTS", scope="all", limit=5)
```

Affiche les résultats au format :
- Titre + score + path source
- Extrait de 2 lignes max par résultat

Si **aucun résultat pertinent** (top score < 5), suggère à l'utilisateur :
1. Soit aucune connaissance compilée sur ce sujet → proposer `mcp__wikichat__run_routine("team:knowledge-compile-axis", { topic: "<query>" })` pour la compiler
2. Soit la query est trop générique → reformuler avec des keywords plus précis
