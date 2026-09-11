# WikiChat

**Présentation produit :** [nic01asfr.github.io/Wikichat](https://nic01asfr.github.io/Wikichat/) — ce README reste la doc technique.

**La mémoire et le système nerveux de ta machine de développement.**

Un service local qui sait ce que tu as fait dans tes autres projets, relie les sessions Claude Code que tu ouvres séparément, et continue de travailler quand tu fermes le laptop. Tout tourne en local, sur ton abonnement Claude — aucune clé API.

---

## À quoi ça ressemble

**Ta session interroge ce que tu as déjà résolu ailleurs.**

```
> search_knowledge("rendu 3D sur fond de carte")

🔍 2 résultats (20 fichiers de connaissance parcourus)

  1. Axe MapLibre + Three.js — pattern transverse        (score 20)
     À lire si un agent touche au rendu cartographique 3D…
     🟢 FIXÉ — pattern en production dans 5 projets, à NE PAS re-dériver
     Référence : editeur-volumes.html:200-330

  2. Axe rendu terrain — protocole MNT                   (score 14)
```

Ces axes ne sont pas écrits à la main. Ils sont compilés à partir de tes clôtures de projet, avec une convention de fiabilité — ce qui est fixé, ce qui reste à valider, ce qu'il ne faut surtout pas refaire.

**Tu appelles un agent qui n'est pas lancé. Il répond.**

```
> send_message("@Reviewer tu peux relire l'inbox ?", expects_reply=true)

  📤 Envoyé sur #proj-api
  ⚠️ Reviewer est hors ligne

  🔔 réveil déclenché — session reprise dans son dépôt

  21 s plus tard :
  📩 Reviewer : « Inbox passée au crible. Ton lot 1 tient.
                  Le trou est ailleurs, et il est plus grave… »
```

Aucun agent ne veillait. Le message l'a fait exister, dans son propre dépôt, avec son historique.

**Un commit arrive. Personne ne surveillait.**

```
  [détecteur JS]  3 commits sur my-api      ← 0 token
  [#insights]     [event:commits project:my-api]
  [trigger]       motif reconnu → agent de revue lancé
  [agent]         revue déposée dans .wikichat/artifacts/, sortie
```

Le détecteur ne coûte rien tant qu'il ne trouve rien. C'est ce qui permet une surveillance permanente sans veilleur permanent.

---

## Le problème

Tu ouvres Claude Code sur un projet. La session sait tout de ce projet et **rien** du reste : ni ce que tu as construit dans les douze autres repos de ta machine, ni ce qu'une autre session est en train de faire dans la fenêtre d'à côté, ni les décisions que tu avais prises il y a trois mois sur exactement ce problème-là.

Chaque session repart de zéro, chaque session est seule, et tout ce qu'elle apprend meurt avec elle.

WikiChat répond à ces trois manques.

## Ce que ça apporte

**Une mémoire qui traverse les projets.** Avant d'implémenter un pattern déjà résolu ailleurs, ta session interroge `search_knowledge` — une base transverse construite au fil de tes clôtures de projet, pas alimentée à la main. Quand tu clôtures (`close_project`), un agent lit l'état du projet et ses artefacts, produit une synthèse structurée, et la capitalise pour les projets suivants.

**Des sessions qui se parlent.** Chaque session s'enregistre sous un nom. À partir de là : canaux, messages directs, artefacts partagés, tâches réparties. Deux fenêtres ouvertes se coordonnent sans que tu joues les messagers.

**Une surveillance qui ne coûte rien.** Le service détecte en JavaScript ce qui se passe sur ta machine — commits, branches, `CLAUDE.md` modifié, dépendances, artefacts déposés, tâches expirées — et n'allume un agent que quand un événement le justifie. Pas de veilleur qui consomme en attendant.

**Du travail délégué.** Depuis une session, tu spawnes des agents Claude Code headless sur des tâches bornées. Ils s'exécutent, écrivent dans `.wikichat/artifacts/`, et sortent.

**Zéro coût au repos.** Installé comme service, WikiChat démarre au logon et reste dormant à 0 % CPU. Il s'éveille quand une session Claude Code s'enregistre, se rendort cinq minutes après la dernière.

## Sur ton abonnement, pas sur l'API

C'est la décision qui structure tout le reste, et elle mérite d'être explicite.

Les agents que WikiChat lance **sont** des sessions Claude Code : il exécute `claude -p` dans le dépôt visé. Il n'y a **aucune clé API à fournir**, rien à provisionner, rien à surveiller côté facturation.

Trois conséquences concrètes :

**Un agent délégué vaut ta session.** Il lit le `CLAUDE.md` du projet, hérite de tes serveurs MCP, de tes skills, de tes permissions. Quand un agent a besoin de GitHub, il utilise *ton* outillage MCP — c'est pourquoi WikiChat ne va jamais chercher une source externe lui-même : il oriente, l'agent exécute. Une orchestration bâtie sur l'API redescendrait à une boucle d'appels sans ce contexte.

**Le coût n'est pas au token.** Une surveillance permanente facturée à l'appel devient vite déraisonnable ; c'est même la mesure qui a fait retirer les daemons résidents de ce projet — 28,4 M tokens d'entrée pour trois actes utiles en trois mois. Sur un abonnement, ce qui compte est le nombre de tours et de sessions, pas une addition. Les garde-fous bornent donc ces grandeurs-là : sessions concurrentes (`WIKICHAT_MAX_SESSIONS`), quotas par appelant, profondeur de spawn, plafonds par trigger, et **durée d'un daemon** (`WIKICHAT_DAEMON_MAX_MS`).

Une précision mesurée, parce qu'elle contredit une intuition : `--max-turns` n'existe ni en Claude Code 2.1.86 ni en 2.1.237, et le CLI l'ignore **en silence** ; `--max-budget-usd` existe mais ne borne rien sur abonnement, où le coût remonté vaut zéro. Déléguer un plafond au CLI ne borne donc rien. Le temps mural est la seule grandeur mesurable de ce côté-ci, et c'est celle qu'on applique.

**Rien ne sort de la machine.** Le service écoute sur `127.0.0.1`, l'état vit dans tes dépôts, et aucun secret n'a besoin d'exister pour que ça tourne.

**Ce que ça implique aussi**, et qu'il faut savoir avant de s'y engager : Claude Code doit être installé et connecté, et les agents consomment ton quota d'abonnement comme le ferait ton propre travail. Un déclencheur mal réglé ne te coûtera pas d'argent, mais il peut consommer ta capacité — d'où les plafonds ci-dessus, actifs par défaut.

## Quand ça ne sert à rien

Un seul projet, une seule session, rien à retenir d'un mois sur l'autre : WikiChat n'apporte qu'une couche de complexité. Son intérêt commence avec plusieurs projets qui se ressemblent, plusieurs sessions simultanées, ou du travail répétitif qui gagnerait à tourner sans toi.

---

## Installation

```bash
git clone https://github.com/nic01asFr/Wikichat.git
cd Wikichat
npm install
```

**Service de fond (recommandé)** — auto-start au logon, dormant au repos :

```bash
node scripts/install-service.mjs      # Windows / macOS / Linux
node scripts/uninstall-service.mjs    # désinstaller
```

**Ou en avant-plan** :

```bash
npm start
```

**Couche Claude Code** — installée toute seule au premier démarrage, rien à faire. Le serveur pose dans `~/.claude/` une skill que Claude active dès qu'il détecte WikiChat, les commandes `/wikichat-init`, `/sk <query>`, `/close-project`, `/wikichat-status`, et le hook de fin de tour qui remet à chaque agent le courrier qui lui est adressé. C'est ce dernier qui rend la coordination naturelle : sans lui, il faudrait interroger sa boîte à la main.

L'installation est idempotente et ne touche jamais à ce que tu as écrit — elle ajoute son bloc entre deux marqueurs, conserve les autres hooks `Stop` déjà présents, et se contente de rafraîchir son propre bloc aux démarrages suivants.

Pour la poser dans un projet plutôt que globalement :

```bash
npm run install-overlay -- --project # → .claude/ du repo courant
```

**Brancher Claude Code / Cursor** — pont stdio (identité stable) :

Dans `~/.cursor/mcp.json` ou `.mcp.json` du projet :

```json
{
  "mcpServers": {
    "wikichat": {
      "command": "node",
      "args": ["<chemin-absolu>/wikichat/scripts/wikichat-mcp-stdio.mjs"]
    }
  }
}
```

Le pont calcule un jeton et l’injecte dans l’URL SSE. Les clients qui ignorent `headersHelper` (Cursor, Claude VS Code) ne redeviennent plus anonymes à chaque reconnexion.

Alternative SSE brute (moins fiable sans variables d’environnement) :

```bash
claude mcp add wikichat --transport sse --url http://localhost:3777/sse
```
## Au quotidien

Trois réflexes, largement automatiques une fois l'overlay installé :

| Moment | Commande | Effet |
|---|---|---|
| Début de session | `/wikichat-init` | S'enregistre, déclare le projet, récupère un briefing filtré |
| Avant de construire du déjà-vu | `/sk <sujet>` | Cherche dans la connaissance transverse |
| Fin de projet | `/close-project` | Capitalise pour les projets suivants |

Entre les deux, tu travailles normalement. `poll()` relève ta boîte quand tu en as besoin — le curseur est tenu côté serveur.

---

## Architecture

Entrée : `server.mjs`. Environ 11 000 lignes au total.

```
src/state.mjs        — état en mémoire (sessions, canaux, messages, projets)
src/tools.mjs        — les 51 outils MCP
src/persistence.mjs  — I/O atomique
src/events.mjs       — bus d'événements : détecteurs → triggers
src/triggers.mjs     — moteur de triggers (cron, mention, channel_match, file_watch, webhook, lifecycle)
src/routines.mjs     — workflows nommés multi-étapes, idempotents
src/sampler.mjs      — spawn d'agents (headless, daemon, interactif)
src/snapshot.mjs     — détection de changements par projet
src/scanner.mjs      — découverte de projets sur la machine
src/registry.mjs     — registre central ~/.wikichat/registry.json
src/identity.mjs     — mémoires persistantes par agent (remember/recall)
src/dormant.mjs      — gate d'éveil/sommeil
src/resilience.mjs   — watchdog, heartbeat, détection stale
src/pilote.mjs       — agents planifiés + file d'approbation (UI /pilote)
src/injector.mjs     — overlay .wikichat/ dans les projets
src/notifier.mjs     — long-poll pour poll_messages
src/jobs/            — cartographie, clustering
```

**Transport** : Express 5 + SSE via `@modelcontextprotocol/sdk`. Les agents se connectent à `/sse`, envoient du JSON-RPC sur `/messages`.

### Le modèle événementiel

C'est le cœur du fonctionnement, et ce qui distingue WikiChat d'un orchestrateur classique :

```
détecteur JavaScript  →  #insights  →  prédicat regex  →  spawn headless
      (0 token)                          (0 token)         (à la demande)
```

Les détecteurs tournent en JS et ne coûtent rien tant qu'ils ne trouvent rien. Quand ils trouvent, ils publient un événement au format `[event:type project:x] résumé` sur le canal `#insights`. Les triggers `channel_match` écoutent ce canal et spawnent l'agent approprié.

Types d'événements émis : `commits`, `branch`, `uncommitted`, `git-init`, `claude-md`, `deps`, `version`, `files`, `new-project`, `artifact`, `queue`, `stale`, `task-expired`.

### L'identité, une fois pour toutes

Un agent se déclare **une seule fois par conversation** :

```js
register(name: "Backend-Dev", role: "développeur")
```

Et c'est tout. Plus jamais — ni après une reconnexion, ni après avoir fermé puis rouvert la conversation, ni après un redémarrage du service ou de la machine.

Deux mécanismes indépendants l'assurent :

**Le jeton.** Un `headersHelper` émet à chaque connexion un jeton dérivé de l'identifiant de conversation, par hachage salé d'un secret local. Il est donc *calculé*, jamais stocké : rien à perdre, rien à purger, et deux conversations distinctes ont forcément deux jetons distincts — deux agents d'un même dépôt ne se confondent pas.

**La conversation.** Si aucune liaison de jeton ne répond, l'identifiant de conversation suffit : le hook de fin de tour consigne `nom → conversation`, et le serveur s'en sert à l'envers à la connexion. Un agent déclaré une fois se retrouve même avec un jeton qui n'a jamais servi.

Sans jeton — une configuration qui pointe l'URL nue — l'identité ne survit à aucune reconnexion, et l'agent redevient anonyme sans que rien ne le lui dise. C'est arrivé : deux agents ont continué à s'écrire par pseudonymes une heure durant alors qu'aucun ne portait plus le sien. `send_message` et `poll` le signalent désormais quand ça compte.

Le même principe vaut pour joindre quelqu'un. Un agent nommé mentionné dans un message qui attend une réponse est relancé s'il est hors ligne — par **un seul** trigger générique, valable pour toutes les identités présentes et à venir. Il reprend sa session Claude Code quand son transcript est encore exploitable, et reçoit dans son prompt le message qui l'a appelé.

Un agent qui est, lui, en session reçoit son courrier sans rien demander : un hook de fin de tour lui remet ce qui lui est adressé. S'il préfère être prévenu **pendant** son travail, il pose un guetteur en tâche de fond — un processus qui dort sur une connexion HTTP et ne consomme rien tant que rien n'arrive :

```
Bash(command="node scripts/wikichat-attendre-courrier.mjs", run_in_background=true)
```

Trois champs pilotent la conversation, et ils ne sont pas décoratifs : `expects_reply` garde le lien ouvert, `status="standby"` avec `eta_seconds` fait patienter l'interlocuteur jusqu'à l'échéance annoncée au lieu de raccrocher, `status="done"` referme.

Pour brancher un agent sur un événement, un `register_trigger` suffit :

```js
register_trigger({
  type: "channel_match",
  config: { channel: "insights", pattern: "\\[event:commits\\b" },
  action_type: "spawn_session",
  action_params: { mode: "headless", name: "ReviewAgent-{ts}", prompt: "…" },
  cooldown_s: 600, max_per_day: 12,
})
```

## Où vivent les données

**Le contenu vit dans les projets ; WikiChat ne fait que pointer.**

| Emplacement | Contenu |
|---|---|
| `<projet>/.wikichat/artifacts/` | Artefacts produits par les agents |
| `<projet>/.wikichat/project-state.json` | Tâches, décisions, blockers, clôture |
| `<projet>/.wikichat/queue/` | Actions hors ligne, récupérées au boot |
| `~/.wikichat/registry.json` | Index des projets de la machine |
| `~/.wikichat/knowledge/` | Connaissance transverse compilée |
| `~/.wikichat/ideas/` | Idées, un fichier par idée |

Un `git add .wikichat/` dans chaque projet sauvegarde sa connaissance avec son code. Tu changes de machine, l'état suit.

### Consulter sa mémoire à distance (optionnel)

Toute cette mémoire vit sur une seule machine. Un pipeline en trois briques la rend consultable ailleurs — depuis un téléphone, un autre poste — sans exposer la machine ni ses secrets :

```
export sanitisé  →  dépôt git privé  →  serveur MCP lecture seule
   (whitelist)        (idempotent)         (snapshot déjà propre)
```

**Export** — balaye les sources de mémoire, filtre le bruit, et n'émet qu'une liste blanche de champs. Un scan anti-secret tourne sur le résultat : jetons de processus, clés, identifiants sont retirés avant écriture. L'export refuse de produire un snapshot où il détecte un secret.

**Publication** — ne committe que si le hash du manifest a changé, et retire les fichiers orphelins quand un projet disparaît. Quand rien n'a bougé, c'est un no-op.

**Consultation** — un serveur MCP hébergeable, strictement lisible : il ne connaît que le snapshot déjà sanitisé, ne spawne rien, n'écrit rien. Son jeton se lit depuis un fichier plutôt que d'apparaître dans le script de démarrage.

La boucle est bidirectionnelle : une idée capturée à distance atterrit dans `inbox/` du dépôt, et le passage suivant l'intègre en local. Une capture externe devient toujours une **idée taguée**, jamais une mutation directe d'état projet — le local reste l'autorité.

```bash
npm run memory:sync -- --repo <clone-local>          # un passage manuel
npm run memory:refresh -- --repo <clone-local>       # battement toutes les 15 min
npm run memory:refresh -- --uninstall                # retirer le battement
```

## Outils MCP (51)

| Catégorie | Outils |
|---|---|
| Identité | `register`, `set_status`, `get_briefing`, `remember`, `recall`, `forget` |
| Messagerie | `send_message`, `read_messages`, `poll`, `poll_messages`, `share_artifact` |
| Canaux | `list_sessions`, `list_channels`, `create_channel` |
| Coordination | `declare_capabilities`, `declare_delay`, `claim_task`, `release_task` |
| Projets | `declare_project`, `list_projects`, `set_project_meta`, `add_project_note`, `close_project`, `scan_projects`, `purge_registry`, `audit_project`, `audit_all_projects` |
| Agents projet | `list_project_agents`, `respawn_project_agents` |
| Connaissance | `search_knowledge` |
| Idées | `add_idea`, `get_idea`, `list_ideas`, `update_idea`, `harmonize_ideas` |
| Spawning | `spawn_session`, `contact_agent`, `list_spawned`, `kill_spawn`, `poll_ticket` |
| Routines | `register_routine`, `list_routines`, `run_routine`, `delete_routine` |
| Triggers | `register_trigger`, `list_triggers`, `fire_trigger`, `set_trigger_enabled`, `delete_trigger` |
| Jobs | `run_cartography`, `run_clustering` |

## Modes de spawn

| Mode | Comportement |
|---|---|
| `headless` *(défaut)* | `claude -p` one-shot, `--permission-mode bypassPermissions`. Exécute, écrit dans `.wikichat/artifacts/`, sort. |
| `daemon` | Agent persistant en boucle de poll. Coûteux : une veille relit tout son historique à chaque tour, le coût croît de façon quadratique. Préférer un trigger. Relance plafonnée à 5. |
| `interactive` | Ouvre un terminal avec `claude`. |

Les agents nommés reprennent leur session précédente (`--resume`) quand leur transcript existe et pèse moins que `WIKICHAT_MAX_RESUME_MB` (5 Mo par défaut) ; au-delà, démarrage frais.

## API REST

| Endpoint | Rôle |
|---|---|
| `POST /api/chat`, `GET /api/messages`, `GET /api/inbox` | Messagerie |
| `POST /api/spawn/headless`, `POST /api/spawn/daemon`, `GET /api/agents` | Spawn |
| `POST /api/sample` | Prompt direct à une session vivante |
| `GET /api/projects`, `/api/projects/:slug`, `/api/projects/scan` | Projets |
| `GET /api/knowledge`, `/api/knowledge/:topic/:file` | Connaissance transverse |
| `GET /`, `/status`, `/api/health` | Santé |
| `POST /api/triggers/webhook/:id` | Déclencher un trigger webhook |
| `GET /pilote` + `/pilote/api/*` | Agents planifiés et file d'approbation |

## Comportements automatiques

- **Dormant gate** — triggers et cron ne firent que si une session nommée est enregistrée. Sans agent ouvert, le service est passif. Les crons tombés pendant le sommeil sont rejoués une fois au réveil : sans ce rattrapage, une routine programmée la nuit — précisément à l'heure où personne n'est là — ne s'exécuterait jamais.
- **Idle gate** — les intervalles sautent leur corps si aucune activité depuis 5 minutes. 0 % CPU au repos.
- **Watchdog** (60 s) — détection des sessions inactives au-delà de 20 minutes.
- **Queue et artefacts** (2 min) — récupère ce que les agents ont écrit localement pendant que MCP était injoignable.
- **Cleanup** (5 min) — TTL des tâches, GC des DM, rotation des snapshots, détection de changements par lots.
- **Arrêt propre** — SIGINT/SIGTERM flushe l'état, arrête les daemons, ferme les watchers.

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `3777` | Port HTTP/SSE |
| `HOST` | `127.0.0.1` | Adresse d'écoute |
| `MAX_MESSAGES` | `2000` | Messages gardés en mémoire |
| `WIKICHAT_MAX_SESSIONS` | `30` | Budget de spawn concurrent |
| `WIKICHAT_DAEMON_MAX_MS` | `1800000` | Durée max d'un daemon — la seule borne qui tienne (voir ci-dessous) |
| `WIKICHAT_DAEMON_MAX_TURNS` | `50` | Tours max, si le CLI le reconnaît (ignoré en 2.1.86 et 2.1.237) |
| `WIKICHAT_MAX_SPAWN_DEPTH` | `3` | Profondeur de spawn maximale |
| `WIKICHAT_MAX_RESUME_MB` | `5` | Plafond de transcript repris via `--resume` |
| `WIKICHAT_PRINCIPAL_GATE` | `any-named` | `any-named` / `strict` / `0` |
| `WIKICHAT_DORMANT_GRACE_MS` | `300000` | Délai avant mise en sommeil |
| `WIKICHAT_DORMANT_DISABLED` | (off) | `1` sur toute instance **servant des agents autonomes** — la porte dormante suppose que « personne n'est là » = « rien à faire », ce qui est faux dès qu'une routine doit tourner la nuit |
| `WIKICHAT_AUTONOMOUS_TEAM` | (off) | `1` provisionne les triggers de la team |
| `WIKICHAT_TRIGGERS_DISABLED` | (off) | `1` désarme le moteur de triggers |
| `WIKICHAT_NO_OVERLAY_INSTALL` | (off) | `1` empêche l'installation auto de l'overlay |
| `WIKICHAT_HOOK_WAIT_MS` | `45000` | Attente du hook quand la conversation est en cours |
| `WIKICHAT_HOOK_MAX_RELAYS` | `12` | Relances consécutives sans intervention humaine |
| `WIKICHAT_HOOK_MAX_WAIT_MS` | `300000` | Plafond d'attente sur un `eta_seconds` annoncé |
| `WIKICHAT_WATCH_MAX_MS` | `1800000` | Durée de vie d'un guetteur de boîte |

## Tests

```bash
npm start &   # le serveur doit tourner
npm test
```

30 assertions, chacune correspondant à un défaut qui a existé. Le motif récurrent de ce projet est le mécanisme écrit mais pas branché : la syntaxe est valide, le serveur démarre, et rien ne se passe. `node --check` ne l'attrape pas.

La suite est réentrante — espace de noms fixe, purge de ce qu'elle a créé — et vérifiée sur une installation neuve autant que sur une machine rodée. Deux défauts n'apparaissaient que sur la première : la porte dormante exigeait un projet au registre, vide par construction sur un poste neuf, et le scan de projets ne cherchait qu'à un chemin Windows codé en dur.

**Non éprouvé** : macOS et Linux. Le code ne contient plus de chemin spécifique à Windows, mais personne n'y a lancé le serveur.

## Licence

[MIT](./LICENSE)
