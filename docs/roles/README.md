# Rôles d'agents WikiChat

Huit templates de rôles utilisés par `sampler.mjs` lors du spawning. Trois sont des résidents (daemons longue durée), cinq sont des prompts pour spawns ponctuels (headless).

| Rôle | Type | Modèle | Mission |
|---|---|---|---|
| [Sentinel](sentinel.md) | daemon | Haiku | Surveille événements (commits, queue), spawne les sous-agents adéquats |
| [Librarian](librarian.md) | daemon | Haiku/Sonnet | Absorbe les artifacts, consolide la KB, digest nocturne (continu) |
| [Orchestrator](orchestrator.md) | daemon | Sonnet | Seul agent qui parle à l'utilisateur, interprète directives, dispatche |
| [Closer](closer.md) | headless | Sonnet | Audit de clôture d'un projet : 4 sections (doc/livrables/rétro/capitalisation) |
| [Librarian-Compiler](librarian-compiler.md) | headless | Sonnet | Compile un nouvel axe `<topic>-axis.md` à partir des projets pertinents |
| [Librarian-Absorber](librarian-absorber.md) | headless | Haiku | Ingère une closure dans l'axe pertinent (auto via channel_match) |
| [Reviewer](reviewer.md) | headless | Haiku | Review ponctuelle d'un diff |
| [Subagent](subagent.md) | headless | Haiku | Template générique pour tâche bornée |

Ces fichiers sont des **templates** : `sampler.mjs` les injecte dans le prompt initial du spawn (ils ne sont pas chargés par `~/.claude/CLAUDE.md`).
