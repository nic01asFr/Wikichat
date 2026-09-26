# wikichat et la cohérence de projet (lots A, C, D, W, profils, lancements)

Branche `atelier-coherence`, 25/09/2026. Mise en œuvre, côté wikichat, de
`Claude Code sspcloud/docs/coherence-projet.md` : un projet doit être le même
sur toutes les surfaces (Atelier, VS Code, terminal, processus lancés par
wikichat). Ce document dit ce qui a changé, ce qui reste à vérifier, et
comment mettre le pod à jour.

## 1. Réconciliation avec la copie du pod

La copie du pod est dans `~/work/wikichat/src` (et non `~/work/wikichat`, qui
ne contient que des données : `identity-bindings.json`, `triggers.json`…).
Elle est au commit `58d32fa` (22/08, « fermer le rebinding DNS »), avec :

| Fichier | État sur le pod | Retenu |
|---|---|---|
| `src/sampler.mjs` | modifié : `~/work/bin/claude` en tête des binaires, statut `max_turns` | déjà dans `main` (`0da5701` et `CLAUDE_CANDIDATES`) — rien à reprendre |
| `src/pilote.mjs` | modifié (78 lignes) | **repris tel quel** (commit « Réintégrer dans le Pilote… », empreinte du diff `de8e62a0…`) |
| `src/*.bak*`, `sampler.mjs.avant-max-turns` | copies de sauvegarde non suivies | non repris |
| `p4d2_go.mjs`, `p4d3_go.mjs` | scripts d'essai non suivis | non repris |
| `.mcp.json` du dépôt | SSE + `headersHelper`, ignoré par git | non repris (configuration locale) |

Ce que le diff du Pilote apporte : libellé de permission exact par outil,
mission transmise entière (400 lignes au lieu de 20, qui amputait la consigne
à chaque réédition), statut `max_turns` affiché « run coupé », champ `kind`,
sélection brute des serveurs pour la réédition, déclencheurs de plateforme
exposés en `system_agents`, contenu des résultats d'outils dans le fil.

**La vraie divergence n'était pas dans le code du pod mais dans ce que le code
écrit.** `58d32fa` créait les `.mcp.json` en SSE + `headersHelper` et
« complétait » une entrée existante en y ajoutant un `headersHelper` — d'où
`~/work/wikichat-memory/.mcp.json` réduit à `{enabled, headersHelper}` (ni url
ni command). `main` basculait ces entrées vers le pont stdio. Les deux
écrivaient dans le projet ; la branche n'écrit plus ni l'un ni l'autre (§2).

Constaté aussi sur le pod : la portée utilisateur (`~/.claude.json`) déclare
`wikichat` en `?agent=atelier` — identité commune à toutes les fenêtres.

## 2. Plus jamais de `.mcp.json` écrit par wikichat (lot A)

- `ensureMcpJson` est supprimé. Ni `spawnHeadless`, ni `spawnDaemon`, ni le
  mode `interactive` de `spawn_session` ne créent ni ne complètent le
  `.mcp.json` d'un projet ; ils ne passent plus non plus ce fichier en
  `--mcp-config` (ce qui court-circuitait l'approbation
  `enabledMcpjsonServers`).
- La connexion de wikichat pour un processus qu'il lance passe par
  `--mcp-config <fichier temporaire>` dans `$WIKICHAT_MCP_TMP` (défaut
  `<tmp>/wikichat-mcp/`, 0700, fichiers 0600), **sans `--strict-mcp-config`** :
  les serveurs de la portée utilisateur et du projet restent chargés
  nativement. Le fichier est supprimé à la sortie du processus.
- L'entrée écrite est toujours complète :
  `{"type":"sse","url":"http://127.0.0.1:<port>/sse?agent=<nom>"}`. Le nom est
  connu au lancement, le serveur tient `?agent=` pour faisant foi : ni pont,
  ni jeton, ni variable à développer. Une entrée sans url ni command lève
  une erreur au lieu d'être écrite ; un dossier temporaire situé dans le
  projet est refusé.
- `spawnHeadless` n'écrit plus non plus `Write(.wikichat/**)` dans
  `.claude/settings.local.json` du projet : ces règles passent par
  `--allowedTools`.

Code : `src/lancement.mjs` (`argumentsMcp`, `ecrireConfigMcpTemporaire`,
`entreeMcpUtilisable`).

## 3. Mode de permission explicite (lot D)

`--permission-mode bypassPermissions` n'est plus codé en dur (sampler, trois
endroits). Le mode vient d'un paramètre `permission_mode` :

| Source | Accepté | `bypassPermissions` |
|---|---|---|
| Définition de routine (`register_routine … permission_mode`) ou step `spawn` | oui | **oui** — lu dans la définition, jamais dans les paramètres d'exécution (`{mode}` interpolé ignoré) |
| Définition de déclencheur (`action.params.permission_mode`), agents du Pilote | oui | **oui** |
| `spawn_session`, API REST `/api/spawn/*` | oui | non (ramené à `acceptEdits`, avertissement au journal) |
| Contact / réveil sur mention | défaut | non |

Défaut : **`acceptEdits`**. Hors bypass, un `claude -p` refuse tout outil non
autorisé : quand l'appelant ne fixe pas `allowedTools`, wikichat autorise
`mcp__wikichat`, `Write(.wikichat/**)`, `Edit(.wikichat/**)`. Quand il la fixe
(Pilote : proposeur en lecture, applicateur en écriture), elle est respectée
telle quelle — et devient enfin effective : en bypass, `--allowedTools` ne
restreignait rien, la « lecture seule » du proposeur n'était qu'affichée.

Conséquence à connaître : un agent sans `allowedTools` ne peut plus lancer
`Bash` ni appeler d'autres connecteurs sans que sa routine le déclare.

Code : `resoudreModePermission`, `outilsAutorises` (`src/lancement.mjs`),
`modeDeLaDefinition` (`src/routines.mjs`), `bypassAutorise` posé par
`src/triggers.mjs` et le Pilote.

## 4. Lancement par l'Atelier — préparé (lot D ; remplacé par le §13)

| Variable | Défaut | Rôle |
|---|---|---|
| `WIKICHAT_LANCEUR` | `claude` | `atelier` pour faire passer spawn headless/daemon, réveils et routines par l'Atelier |
| `WIKICHAT_ATELIER_URL` | `http://127.0.0.1:8787` | base de l'Atelier (`POST /mcp`) |
| `WIKICHAT_ATELIER_CLE_FICHIER` | `~/work/.secrets/atelier_owner_key` | clé propriétaire, lue à chaque lancement, jamais journalisée |
| `WIKICHAT_ATELIER_PROJETS` | `~/work/projects` | racine des projets : `<racine>/<slug>/…` → projet `slug` |
| `WIKICHAT_ATELIER_PROJET_DEFAUT` | `default` | projet utilisé pour un dossier hors racine |
| `WIKICHAT_ATELIER_DELAI_MS` | `45000` | délai d'un appel HTTP |

Déroulé (`src/lanceur-atelier.mjs`) : session MCP streamable HTTP
(`initialize` → `Mcp-Session-Id`), puis
1. `atelier_ouvrir {projet, titre: <nom de l'agent>, modele?}` si l'agent n'a
   pas encore de conversation — l'identifiant est mémorisé
   (`remember(nom, "__atelier_conversation")`) ;
2. `atelier_envoyer {conversation, message: <prompt>}` ;
3. headless : `atelier_suivre {conversation, curseur, attendre_s ≤ 25}` jusqu'à
   `fini` ou délai ; daemon : on rend la main après l'envoi.

Un tour qui attend une autorisation (`autorisations_attendues`) est rendu
comme bloqué (`awaiting_permission` au registre) : wikichat ne décide jamais
à la place de l'humain, le tour reste visible dans l'Atelier.

**Avant d'activer** : `atelier_envoyer` joue le tour avec `peut_attendre=True`
et n'accepte pas de mode. Un tour lancé pour wikichat attendrait donc une
autorisation que personne ne donnera. Il faut, côté Atelier, soit un
paramètre de mode sur `atelier_envoyer`, soit le mode par défaut du projet
dans `.claude/settings.local.json` (lot E). Le `permission_mode` des routines
n'est pas transmis à l'Atelier aujourd'hui.

## 5. Environnement des processus lancés (lot A)

Si `~/work/.secrets/claude-env.sh` existe (ou `$WIKICHAT_FICHIER_ENV`), il est
sourcé par `sh` (`set -a`, pour que les affectations nues soient exportées)
et seules les variables qu'il ajoute ou change sont passées aux processus
lancés, par-dessus l'environnement du service. `WIKICHAT_AGENT` est posé en
dernier : le fichier ne peut pas changer l'identité. Relu seulement quand il
change (date, taille). Sans `sh`, lecture ligne à ligne (`export K=V`).
Aucune valeur n'est journalisée.

## 6. Consignes alignées sur toutes les surfaces

- Bloc de `~/.claude/CLAUDE.md` (`overlay-installer.mjs`) réduit : identité
  portée par la connexion (plus de réflexe `register`), `search_knowledge`,
  over/standby, renvoi à la skill. Le chemin du guetteur, le `curl` et les
  commandes passent dans la skill.
- Skill `wikichat` en version 2 (marqueur `<!-- wikichat:skill-version 2 -->`) :
  elle est désormais **rafraîchie** sur une installation existante quand le
  modèle est plus récent (l'ancienne gardée en `SKILL.md.bak`) ; jusqu'ici une
  skill installée n'était jamais mise à jour. `{{GUETTEUR}}` est remplacé par
  le chemin réel à l'installation.
- `AGENT_PREAMBLE`, gabarits de prompts, prompts de daemon, de réveil, de
  contact, de reprise d'équipe et du Closer : plus de `register()` à faire.
- Description de l'outil `register` : réservé à une session anonyme.
- La session Claude d'un agent lancé est mémorisée par wikichat lui-même
  (`session_id` de `--output-format json`, daemons compris) : le
  `register(claude_session_id=…)` n'est plus nécessaire à la reprise.

## 7. Tests

- `npm run test:lancement` (nouveau, 32 cas) : mode de permission, entrée
  MCP, fichier temporaire hors projet, sourçage de l'environnement, et
  `spawnHeadless` contre un faux `claude` (aucun `.mcp.json` ni `.claude/`
  créé, `.mcp.json` incomplet existant laissé intact, `--permission-mode`,
  absence de `--strict-mcp-config`, secrets et identité dans l'environnement,
  session mémorisée) ; lanceur Atelier contre un faux `/mcp` ; bloc
  CLAUDE.md et rafraîchissement de la skill.
- `npm test` (e2e, 32 cas) : passé contre un serveur de la branche isolé
  (`PORT=3791`, `HOME` temporaire, `WIKICHAT_NO_OVERLAY_INSTALL=1`).
- `npm run test:site`.

## 8. Mettre le pod à jour (plus tard)

1. Archiver l'état local : `cd ~/work/wikichat/src && git diff > ~/work/wikichat/pod-local-58d32fa.diff`.
2. Rendre la main aux fichiers suivis (leur contenu est dans la branche) :
   `git checkout -- src/pilote.mjs src/sampler.mjs` ; déplacer les
   `src/*.bak*`, `src/sampler.mjs.avant-max-turns`, `p4d*_go.mjs` hors du dépôt.
3. `git fetch origin && git checkout atelier-coherence` (la branche doit
   d'abord être poussée), puis `npm ci` (aucune dépendance ajoutée).
4. Redémarrer wikichat depuis `~/work/wikichat/src` (même dossier courant :
   la persistance en dépend).
5. Vérifier :
   - un `spawn_session` headless dans un projet de `~/work/projects` : l'agent
     apparaît sous **son nom** dans `list_sessions`, pas sous `atelier` (voir
     §9) ; `git -C <projet> status` ne montre ni `.mcp.json` ni `.claude/` ;
     `ls /tmp/wikichat-mcp` est vide après la fin ;
   - `ps -o args` pendant le tour : `--permission-mode acceptEdits`, pas de
     `bypassPermissions`, pas de `--strict-mcp-config` ;
   - une fois `claude-env.sh` généré par l'Atelier, la présence des
     `ATELIER_MCP_*` dans `/proc/<pid>/environ` du processus lancé.
6. Les agents du Pilote ou routines qui exigeaient le bypass doivent le
   déclarer (`permission_mode` dans leur définition), ou mieux, lister leurs
   outils.
7. Entrées `.mcp.json` héritées : `~/work/wikichat-memory/.mcp.json`
   (`{enabled, headersHelper}`) et `~/work/projects/m3-test/.mcp.json`
   (`{enabled}`) ne sont plus touchées par wikichat ; leur nettoyage revient à
   la liaison de projet de l'Atelier (lot A).
8. Lot D, plus tard : `WIKICHAT_LANCEUR=atelier` (et au besoin les variables
   du §4) dans l'environnement du service, une fois le point du §4 réglé côté
   Atelier.

### 8 bis. Hooks, suivi de projet, fils (§10)

Constaté le 25/09 : `~/work/wikichat/src` est déjà sur `atelier-coherence`
(`9138bd0`), node 18.19, `claude` 2.1.281 (le binaire contient
`asyncRewake`) ; `~/.claude/settings.json` porte `Stop` =
`wikichat-mailbox-hook.mjs` et `SessionEnd` = `atelier-figer-le-travail.sh`.

1. `cd ~/work/wikichat/src && git pull --ff-only origin atelier-coherence`
   (aucune dépendance ajoutée : `npm ci` inutile).
2. Redémarrer wikichat **depuis `~/work/wikichat/src`**. Au démarrage,
   l'installateur fusionne les hooks dans `~/.claude/settings.json` :
   `SessionStart`, `UserPromptSubmit`, `Stop` (+ guetteur `asyncRewake`,
   la version ≥ 2.1.250 étant détectée par `~/work/bin/claude --version`),
   `SessionEnd` ; l'entrée `wikichat-mailbox-hook.mjs` est retirée,
   `atelier-figer-le-travail.sh` reste en tête de `SessionEnd`. La skill passe
   en version 3 (ancienne en `.bak`), le bloc de `~/.claude/CLAUDE.md` est
   rafraîchi. Sans redémarrage, `node scripts/install-claude-overlay.mjs` fait
   la même chose. Si l'Atelier réécrit `settings.json` ensuite, il doit garder
   ces entrées (contrat, `hooks-et-dialogue.md` §8).
3. Vérifier `jq .hooks ~/.claude/settings.json` : une entrée
   `wikichat-hook.mjs` par événement, rien d'autre de modifié.
4. Constater sur le vrai binaire (non vérifiable hors du pod) :
   - VS Code : ouvrir une conversation dans `~/work/projects/<projet>` →
     `curl -s 127.0.0.1:3777/api/conversations/<session>` donne
     `<slug>-<id6>`, `surface: vscode` ; le premier tour voit l'identité ;
   - même conversation dans l'Atelier → **même nom** ;
   - un tour de l'Atelier qui reçoit un message `expects_reply` : la relance
     est accompagnée d'un `systemMessage` dans le flux stream-json (l'Atelier
     doit l'afficher) ; `WIKICHAT_STOP_ATELIER=jamais` dans l'environnement du
     service interdit ces relances ;
   - une session VS Code inactive reçoit un message `expects_reply` → elle se
     réveille (guetteur). Sinon : `WIKICHAT_HOOK_REVEIL=0` et redémarrage ;
   - `/api/projets/etat?cwd=~/work/projects/<projet>` pour un projet doté
     d'`ETAT.md`.
5. Variables utiles (environnement du service) : `WIKICHAT_HOOK_MAX_RELAYS`
   (3), `WIKICHAT_HOOK_WAIT_MS` (0 ; l'ancienne attente de 45 s si on la
   remet), `WIKICHAT_HOOK_REVEIL` (détection), `WIKICHAT_REVEIL_ATELIER`
   (0), `WIKICHAT_STOP_ATELIER`, `WIKICHAT_NOMS_GENERIQUES` (`atelier`),
   `WIKICHAT_ATELIER_PROJETS` (`~/work/projects`),
   `WIKICHAT_FIL_SUITE_MS` (30 min).
6. Retour arrière : `git checkout 9138bd0`, redémarrer, puis remettre à la
   main l'entrée `Stop` = `wikichat-mailbox-hook.mjs` (qui, dans la nouvelle
   version, délègue de toute façon au hook unifié).

## 9. Points ouverts

- **Priorité entre deux `wikichat` de même nom** (portée utilisateur
  `?agent=atelier` et `--mcp-config` temporaire `?agent=<nom>`). Le code
  suppose que la configuration passée en ligne de commande l'emporte ; c'est
  le point « à vérifier au lot A » de `coherence-projet.md`. Si ce n'est pas
  le cas, un agent lancé se connecterait sous `atelier` : la vérification du
  §8.5 le montrera, et la correction naturelle est côté portée utilisateur
  (lot C : `headersHelper` / `${WIKICHAT_AGENT}` plutôt qu'un nom figé).
- Serveurs du `.mcp.json` d'un projet : chargés nativement, donc soumis à
  `enabledMcpjsonServers` ; ils ne sont plus forcés par `--mcp-config`.
- Le mode `interactive` de `spawn_session` (Windows) écrit encore
  `.claude/settings.local.json` et `.claude/CLAUDE.md` dans le projet ; hors
  du périmètre de ce lot, à reprendre au lot E.

## 10. Hooks, suivi de projet et dialogue direct

Conception, contrat avec l'Atelier et mesures : `docs/hooks-et-dialogue.md`.
En bref :

- un script de hook (`scripts/wikichat-hook.mjs`) pour `SessionStart`,
  `UserPromptSubmit`, `Stop` (+ guetteur `asyncRewake`), `SessionEnd` ; les
  décisions sont côté serveur (`src/hooks-serveur.mjs`) ; rien d'injecté quand
  rien n'est neuf ; échec silencieux ;
- **identité par conversation** (`src/conversations.mjs`) : `WIKICHAT_AGENT`,
  sinon `<slug>-<session[:6]>` (formule de l'Atelier) ; `atelier` n'est plus
  une identité ; alias quand l'Atelier renomme ; une connexion MCP qui porte
  la conversation (`?claude_session=`, pont stdio) prend ce nom ;
- `Stop` ne relance que pour une réponse attendue, sans attente, 3 fois au
  plus, avec `systemMessage` ;
- **suivi de projet lu dans les fichiers** (`src/projet-fichiers.mjs`) :
  `project_state`, `/api/projets/etat`, `list_projects` ; `add_project_note`
  devient de la coordination éphémère dans un projet qui a ses fichiers ;
- **fils** (`src/fils.mjs`) : débiteur, échéance, lectures ; `list_threads`,
  `/api/fils`, `send_message(thread, reply_by_seconds)`.

Tests : `npm run test:hooks` (16 cas, dont un faux Claude Code qui lance les
hooks réellement installés), `npm run test:lancement` (32), `npm test` (32,
serveur isolé).

## 11. Lot W : remise en état de wikichat

Branche `lot-w` (depuis `atelier-coherence`), 25/09/2026. Transverse §5.4 :
chaque point répare ou branche une brique existante.

### 11.1 Ce qui a changé

| # | Changement | Code |
|---|---|---|
| W1 | **Un seul lecteur de connaissance** : fiches à plat `~/.wikichat/knowledge/*.md` et `<projet>/.wikichat/knowledge/*.md`. `search_knowledge`, `GET /api/knowledge` (attendait des sous-dossiers : renvoyait vide) et `wikichat://kb/{topic}` (lisait `<cwd>`) passent par `connaissance.mjs`. `/api/knowledge?q=` cherche, `/api/knowledge/:sujet` rend une fiche | `src/connaissance.mjs` |
| W2 | **Données sous `~/.wikichat/`** : `memories.json`, `messages.json`, `channels.json`, `fils.json`, `sessions/`, `projects/`, `agents/`, `spawn_registry.json`, `crons.json`, `roles/`. Plus rien sous `process.cwd()`. Reprise au démarrage, par copie et fusion (§11.3) | `src/chemins.mjs`, `src/migration.mjs`, `scripts/migrer-donnees.mjs` |
| W3 | **Étape `job`** (routines) et **action `job`** (triggers) : appel direct de `runCartography`, `runClustering`, `runHarmonizer`, audits (`auditMany`, gardés dans `~/.wikichat/audits.json`), `scanForChanges`, absorption des clôtures. Les routines `team:job-cartography` et `team:job-clustering` n'ont plus d'agent ; celles déjà enregistrées sont **réparées au démarrage**, même sans équipe (stats gardées). Nouvelle routine d'équipe `team:job-audits` (04:00). Un job n'est pas soumis à la porte dormante (J-c). Une étape d'action inconnue est refusée à l'enregistrement | `src/jobs/index.mjs`, `routines.mjs`, `triggers.mjs`, `team-bootstrap.mjs` |
| W4 | **`GET /api/cartographie`** : nœuds (registre et projets de l'Atelier, avec instantané, santé, ETAT.md, décisions, cycle de vie, clôture, connecteurs) et arêtes typées (`relation`, `proximite`, `meme_connecteur`). Contrat : `docs/cartographie-contrat.md`. Les ponts entre îles de `map-generator` sont ces vrais liens (plus trois paires de thèmes codées en dur) | `src/cartographie.mjs`, `map-generator.mjs` |
| W5 | **Closer** : prompt avec les vrais chemins (ETAT.md, `docs/decisions/`, `.atelier/projet.json`, `.wikichat/`), rôle injecté (il lisait `docs/roles/closer.md` depuis le projet), lancé dans le dossier du projet (plus `process.cwd()`), outils en lecture. `close_project` accepte un projet **à fichiers** ou du registre. **Absorption par le code** : chaque clôture devient `knowledge/closure-<slug>.md`, retrouvée par `search_knowledge` ; job `absorb_closures` pour les anciennes, en tête de la routine d'absorption | `src/closures.mjs`, `tools.mjs`, `docs/roles/closer.md` |
| W6 | Inventaire des triggers en échec, poste et pod, **sans rien couper** : `docs/triggers-en-echec.md`. `last_refusal` effacé au succès, `last_refusal_detail` garde la cause | `triggers.mjs` |
| W7 | Documentation : 53 outils (il en manquait deux dans les listes : `project_state`, `list_threads`), 6 ressources réelles (`wikichat://routines`, `routine/{id}` et `triggers` n'ont jamais existé), `what_is` retiré. **Bogue trouvé** : `resources/list` échouait entièrement (« result.resources is not iterable ») — les modèles de ressources rendaient un tableau au lieu de `{ resources }` | `README.md`, `CLAUDE.md`, `architecture.md`, `resources.mjs` |
| (a) | `~/.claude/settings.json` est écrit **à travers le lien** (`realpath`, lien pendant compris) : le lien vers `~/work/.claude/settings.json` survit | `overlay-installer.mjs` (`cibleReelle`) |
| (b) | **J-b** : `max_per_day` vaut 24 par défaut ; un trigger créé par `register_trigger` (outil MCP, donc par un agent) naît `enabled:false`, et la réponse dit où l'activer (Pilote). Le Pilote et le code du service ne passent pas par cet outil | `triggers.mjs`, `tools.mjs` |
| — | Pilote : la bascule d'un trigger renvoyait l'état inverse de l'état réel | `pilote.mjs` |

### 11.2 Tests

- `npm run test:lot-w` (nouveau, 17 cas) : chemins et migration (fusion,
  conflits, idempotence, retour arrière), lecteur unique, jobs (routine,
  trigger porte fermée, équipe, réparation), plafond 24, ponts de carte,
  prompt du Closer, absorption ; puis serveur isolé : reprise au démarrage,
  trois lecteurs sur les mêmes fiches, contrat `/api/cartographie`,
  `close_project` sur un projet à fichiers, trigger créé par un agent. Le cas
  du lien `settings.json` est **sauté sous Windows** (liens symboliques
  interdits sans mode développeur) : il tourne sous Linux.
- `npm test` (e2e, 36 cas : naissance désactivée d'un trigger créé par un
  agent ; un agent désactive mais ne peut pas activer ; le Pilote active), `npm run test:hooks` (16),
  `npm run test:lancement` (32), `npm run test:site` (3).

### 11.3 Mettre le pod à jour

**Prérequis : rendre `~/.wikichat` durable.** Sur le pod, `~/.wikichat` est un
dossier de la couche éphémère du conteneur, pas le lien vers `~/work/wikichat`
que prévoit l'Atelier (`ensure_wikichat_data_link` ne remplace pas un dossier
non vide). Aujourd'hui la mémoire et les messages sont sur le volume, dans
`~/work/wikichat/src/.wikichat/` ; W2 les met sous `~/.wikichat`. Sans ce
prérequis, W2 **déplacerait des données du volume vers la couche éphémère**.

Service arrêté (c'est le seul moment où `~/.wikichat` ne bouge pas) :

1. Sauvegarde :
   ```sh
   cd ~ && tar czf ~/work/wikichat/archives-pod/avant-lot-w.tgz .wikichat \
     -C ~/work/wikichat/src .wikichat sessions projects agents spawn_registry.json
   ```
2. Lien durable. `~/work/wikichat` contient des copies anciennes (27/08) :
   les ranger, puis y verser `~/.wikichat` et poser le lien :
   ```sh
   mkdir -p ~/work/wikichat/archives-pod/avant-lien-lot-w
   cd ~/work/wikichat && mv triggers.json identity-bindings.json hook-cursors process-tokens projects archives-pod/avant-lien-lot-w/
   cp -a ~/.wikichat/. ~/work/wikichat/
   mv ~/.wikichat ~/.wikichat.avant-lien && ln -s ~/work/wikichat ~/.wikichat
   ```
   Le dépôt (`~/work/wikichat/src`) et `archives-pod/` restent à côté des
   données ; aucun chemin de wikichat ne les vise.
3. Code : `cd ~/work/wikichat/src && git fetch origin && git checkout lot-w`
   (une fois poussée) ; aucune dépendance ajoutée.
4. Redémarrer wikichat **depuis `~/work/wikichat/src`**. Au démarrage :
   - migration W2 : `~/work/wikichat/src/{.wikichat/*.json,sessions,projects,agents,spawn_registry.json}`
     sont **copiés et fusionnés** dans `~/.wikichat/` (journal :
     `[migration W2] données reprises de …`) ; la source reste intacte ; le
     témoin `~/.wikichat/migration-w2.json` empêche une seconde reprise ; un
     fichier présent des deux côtés garde le plus récent, l'autre va dans
     `~/.wikichat/migration-w2/conflits/` ;
   - routines d'équipe existantes réparées (pas d'équipe sur le pod : rien).
5. Vérifier :
   ```sh
   cat ~/.wikichat/migration-w2.json
   curl -s 127.0.0.1:3777/api/knowledge | jq .total
   curl -s 127.0.0.1:3777/api/cartographie | jq '{n: (.noeuds|length), a: (.aretes|length), l: .limites}'
   jq 'keys|length' ~/.wikichat/memories.json
   ```
   Puis, depuis une conversation : `recall` d'une clé connue, `search_knowledge`,
   lecture de la ressource `wikichat://kb/<sujet>`.
6. Après quelques jours sans retour arrière : supprimer `~/.wikichat.avant-lien`
   et, dans `~/work/wikichat/src`, les anciens `.wikichat/*.json`, `sessions/`,
   `projects/`, `agents/`, `spawn_registry.json` (ils ne sont plus lus).

**Retour arrière** (service arrêté), **avant** de changer de code :

1. `cd ~/work/wikichat/src && node scripts/migrer-donnees.mjs --retour --source ~/work/wikichat/src`
   recopie l'état courant de `~/.wikichat` vers le dossier de lancement ; ce qui
   y est remplacé est gardé dans `~/work/wikichat/src/.avant-retour-w2/`.
2. `git checkout 7eefe34` et redémarrer depuis `~/work/wikichat/src`.
3. Le lien `~/.wikichat → ~/work/wikichat` peut rester : l'ancienne version
   y lit ce qu'elle lisait (registre, triggers, routines, connaissance).
4. Les routines réparées (`team:job-*`) portent une étape `job` que
   l'ancienne version ne connaît pas : les réenregistrer avec l'ancienne
   définition si l'équipe tourne (ce n'est pas le cas sur le pod).

**Sur le poste**, le service tourne depuis le dépôt `Github Repositories/wikichat` :
au premier démarrage, ses `.wikichat/*.json`, `sessions/`, `projects/`, `agents/`
et `spawn_registry.json` sont repris dans `C:\Users\Omen\.wikichat` (où
`sessions/Librarian.json` existe déjà : le plus récent gagne). Les routines
`team:job-cartography` et `team:job-clustering` sont réparées au même démarrage.

### 11.4 Ce qui reste

- Vérifier en réel sur le pod (§11.3) : non fait, pod en lecture seule.
- Le cas « lien `settings.json` » est sauté sous Windows ; à lancer sous Linux
  (CI ou pod) avant de s'y fier.
- Décidé (coordinateur, J-b) et fait : par `set_trigger_enabled`, un agent
  peut **désactiver** un trigger, jamais l'**activer** (refus, avec l'adresse du
  Pilote) ; le Pilote et son API gardent le droit d'activer. Testé en e2e.
- Question ouverte, sans changement dans ce lot : faut-il la même règle pour
  `register_routine` et `run_routine` quand la routine consomme du modèle ?
- L'interface du Pilote ne montre que les agents planifiés (`cron` +
  `spawn_session`) : un autre trigger créé par un agent s'active par
  `POST /pilote/api/agent/<id>/toggle`, en attendant l'onglet Automates.
- Connecteurs par projet : lus dans `<projet>/.mcp.json` (noms seulement).
  L'Atelier complète `noeud.atelier` à l'assemblage.
- W8 (capitalisation des conversations) : hors de ce lot.

## 12. Profils

Branche `lot-profils` (depuis `82a06ce`), 26/09/2026. Contrat :
`Claude Code sspcloud/docs/vision/profils-acces.md`, qui fait foi. Un profil
se filtre à la source : c'est le serveur wikichat qui décide de ce qu'une
connexion voit et peut appeler, pas une consigne au modèle.

### 12.1 Annonce et mécanique

- L'entrée wikichat reçoit `WIKICHAT_PROFIL=code|assistant` et
  `WIKICHAT_PROJET=<slug>` dans son environnement. Le pont stdio
  (`scripts/wikichat-mcp-stdio.mjs`) les transmet en `?profil=` et `?projet=`
  sur l'URL `/sse` ; un client SSE direct peut passer les en-têtes
  `x-wikichat-profil` et `x-wikichat-projet`. Une variable non développée
  (`${…}`) compte comme absente.
- Le serveur lit l'annonce à la connexion (`src/profils.mjs`, `lireAnnonce`)
  et la garde sur la session (`profil`, `projet`, visibles dans `/status`).
  Chaque connexion a son propre serveur MCP : un outil hors profil n'y est
  **jamais enregistré**. Il n'apparaît pas dans `tools/list`, et `tools/call`
  le refuse (« Tool … not found », `isError`), même appelé directement.
- **Sans profil annoncé** : comportement d'avant, tous les outils, et une
  ligne au journal : `profil non annoncé — <nom> garde tous les outils`.
- **Profil inconnu** (`WIKICHAT_PROFIL=admin`…) : traité comme `code`, le
  plus restreint, avec un avertissement au journal.
- **Profil `code` sans projet** : le projet de la conversation déclarée par
  son hook `SessionStart` sert de repli ; à défaut, les outils liés au projet
  refusent (« défaut de configuration de l'entrée wikichat »), et
  `search_knowledge` ne lit que la connaissance centrale.

### 12.2 Outils par profil

**`assistant`** : le noyau de dix outils (§12.8, vague 3). **Connexion sans profil** (la
passerelle de l'Atelier, `passerelle-atelier`) : les 53 outils.

**`code`** : 26 outils, liste fermée (`OUTILS_CODE` dans `src/profils.mjs`).
Un outil ajouté à wikichat n'est donné à un agent code qu'en l'ajoutant à
cette liste.

| Outil | Borne en profil code |
|---|---|
| `project_state`, `add_project_note` | son projet |
| `claim_task`, `release_task` | son projet |
| `set_project_meta` | son projet |
| `close_project` | son projet, **`auto=false` seulement** : l'agent écrit lui-même la clôture ; `auto=true` (qui lance le Closer) est réservé à l'Assistant et refusé ; `repo_path` refusé |
| `audit_project` | la santé du dépôt de son projet ; un projet connu par son dossier mais non déclaré est audité sans rien persister |
| `list_project_agents` | son projet |
| `set_status`, `declare_delay` | inchangés (protocole over/standby) |
| `share_artifact`, `list_channels` | inchangés |
| `list_ideas`, `get_idea` | lecture du pool d'idées |
| `remember`, `recall`, `forget` | sa mémoire (déjà liée à son nom) |
| `search_knowledge` | connaissance centrale + `<son projet>/.wikichat/knowledge/` (registre, ou `<racine des projets de l'Atelier>/<slug>`) |
| `send_message`, `read_messages`, `poll`, `list_threads` | inchangés |
| `contact_agent` | refuse `wake=true` et `repo_path` (ils lancent un agent) ; avec `also_invite`, un invité hors ligne reçoit l'invitation dans sa maison au lieu d'être lancé |
| `list_sessions` | réduit aux agents nommés présents, avec leur projet ; ni tâche, ni statut, ni compétences, ni roster hors ligne |
| `get_briefing` | son projet, les présents utiles, ses DM, ses @mentions, les diffusions et les canaux de son projet ; ni la liste des projets, ni le flux des autres canaux |
| `add_idea` | inchangé |

**Le projet est celui du profil, jamais un argument.** Pour les huit outils liés
au projet, l'argument `project` devient facultatif et vaut, s'il est omis, le
projet du profil (sous le nom que wikichat lui connaît : « Nouveau Projet 4 »
pour `nouveau-projet-4`). Un argument qui désigne un autre projet est refusé :

> ⛔ Refusé : profil code, limité au projet "alpha". "beta" est un autre projet.
> 👉 Pour voir ou faire agir un autre projet, passe par ses agents :
> contact_agent(target="<agent de ce projet>", message=…), ou send_message.

**Non exposés en profil `code`** (27) : `register`, `declare_capabilities`,
`poll_messages`, `create_channel`, `declare_project`, `list_projects`,
`respawn_project_agents`, `purge_registry`, `update_idea`,
`harmonize_ideas`, `audit_all_projects`, `spawn_session`, `kill_spawn`,
`list_spawned`, `poll_ticket`, `register_routine`, `list_routines`,
`run_routine`, `delete_routine`, `register_trigger`, `list_triggers`,
`fire_trigger`, `set_trigger_enabled`, `delete_trigger`, `run_cartography`,
`run_clustering`, `scan_projects`.

**Décisions du coordinateur (26/09)**, pour les outils que le contrat ne
nommait pas :
1. Rendus au profil `code`, bornés à son projet quand ils en prennent un :
   `audit_project`, `list_project_agents`, `set_status`, `declare_delay`,
   `share_artifact`, `list_channels`, `list_ideas`, `get_idea`. Restent
   exclus : `register`, `create_channel`, `declare_project`, `update_idea`,
   `harmonize_ideas`, `list_spawned`, `poll_ticket`, `poll_messages` (et
   `declare_capabilities`, non cité, reste hors liste).
2. `close_project` en profil `code` : `auto=false` seulement. `auto=true`
   lance un agent (le Closer) : il est réservé à l'Assistant, et le refus dit
   comment écrire la clôture soi-même.

### 12.3 Ressources

| Ressource | `code` |
|---|---|
| `wikichat://briefing` | bornée comme `get_briefing` |
| `wikichat://role/{name}` | inchangée |
| `wikichat://identity/{name}` | sa seule identité (liste et lecture) |
| `wikichat://kb/{topic}` | centrale + son projet ; une fiche d'un autre projet est introuvable |
| `wikichat://principal`, `wikichat://decisions` | non exposées |

### 12.4 Hooks

Le briefing `SessionStart` était déjà borné : identité, fichiers de **son**
projet (la racine de la conversation), **son** courrier, **ses** fils, les
présents de **son** projet. Il ne dépend pas du profil. Vérifié par un test :
une conversation dans `alpha` reçoit son `ETAT.md` et un DM qui lui est
adressé, rien de `beta` (ni `ETAT.md`, ni message du canal de `beta`).

### 12.5 Tests

- `npm run test:profils` (nouveau, 14 cas) : lecture de l'annonce ; contre un
  serveur isolé à deux projets (`alpha`, `beta`) : `tools/list` exact en
  profil `code`, complet pour l'Assistant et sans profil ; `tools/call` d'un
  outil hors profil refusé et sans effet (`spawn_session`, `list_projects`,
  `register_trigger`, `purge_registry`, `run_routine`) ; les huit outils liés
  au projet refusés sur `beta`, acceptés sur `alpha` ou sans argument ; les
  outils rendus le 26/09 appelables ; `close_project` refusé en `auto=true`
  (explicite ou par défaut), accepté en `auto=false` ;
  `repo_path` et `wake` refusés ; connaissance ; `contact_agent` vers un
  agent de `beta` ; `list_sessions` et briefing bornés ; ressources ; hook
  `SessionStart` ; **bout en bout par le vrai pont stdio** avec
  `WIKICHAT_PROFIL` et `WIKICHAT_PROJET`. Neutraliser le filtre fait échouer
  6 cas.
- `npm test` (36, serveur isolé), `test:hooks` (16), `test:lot-w` (16, plus 1
  sauté sous Windows), `test:lancement` (32), `test:site` (3) : passent.
  `test:lot-w` : le cas J-b lisait `triggers.json` avant son écriture
  différée d'une seconde (échec une fois sur trois déjà sur `82a06ce`) ; il
  attend maintenant le fichier.

### 12.6 Mettre le pod à jour

Aucune dépendance ajoutée ; aucune donnée migrée.

1. `cd ~/work/wikichat/src && git fetch origin && git checkout lot-profils`
   (une fois poussée ; la branche part de `82a06ce`, déjà déployé).
2. Redémarrer wikichat **depuis `~/work/wikichat/src`**. Tant que l'Atelier
   n'annonce rien, rien ne change : chaque connexion journalise
   `profil non annoncé`.
3. Côté Atelier (équipe S) : poser `WIKICHAT_PROFIL` et `WIKICHAT_PROJET`
   dans l'`env` de l'entrée `wikichat` (pont stdio) : `code` et le slug du
   projet pour une conversation de projet, `assistant` pour l'Assistant.
4. Vérifier :
   ```sh
   curl -s 127.0.0.1:3777/status | jq '.sessions[] | {name, profil, projet}'
   grep -E 'profil (code|assistant|non annoncé|inconnu)' <journal du service>
   ```
   Puis, dans une conversation de projet : `/mcp` montre 26 outils wikichat ;
   `project_state(project="<autre projet>")` est refusé avec l'adresse de
   `contact_agent` ; dans l'Assistant, 53 outils.
5. Retour arrière : `git checkout 82a06ce` et redémarrer. Les variables
   posées par l'Atelier sont alors ignorées (tous les outils).

### 12.7 Ce qui reste

- Le profil est une **annonce** de l'entrée wikichat : une connexion SSE sur
  le port local sans annonce garde tous les outils (c'est le comportement
  demandé « sans profil »). Quand toutes les entrées annonceront un profil,
  faire de l'absence un refus ou un profil `code`.
- La passerelle de l'Atelier (identité `passerelle-atelier`, audit M8)
  n'annonce pas de profil : elle garde tout. Le lot F doit retirer wikichat de
  son catalogue proposé aux agents.
- `read_messages` reste libre sur tous les canaux publics : c'est la
  messagerie que le contrat garde ; seuls briefing et ressources sont bornés.
- Non vérifié en réel : `/mcp` d'une vraie conversation Claude Code, sur le
  pod, avec les variables posées par l'Atelier.

### 12.8 Noyau de l'Assistant (vague 3)

Décision du coordinateur (26/09), adoptée par défaut, sur une mesure de l'équipe A : le pont
wikichat natif coûtait environ 10 000 jetons à chaque requête de l'Assistant, qui recevait
les 53 outils. En profil `assistant`, la connexion n'enregistre plus que le **noyau**
(`OUTILS_ASSISTANT_NOYAU` dans `src/profils.mjs`) :

`get_briefing`, `send_message`, `poll`, `read_messages`, `list_threads`, `contact_agent`,
`search_knowledge`, `recall`, `remember`, `project_state`.

- Mécanique : celle du profil `code` (§12.1) ; un outil hors noyau n'est jamais enregistré
  sur la connexion, `tools/call` le refuse comme inconnu. Aucune borne de projet : l'Assistant
  lit tout projet (`project_state` de n'importe lequel). Les ressources restent toutes.
- Le reste (déclarer un projet, lancer, triggers, routines, clôture avec le Closer…) passe par
  le catalogue de la passerelle de l'Atelier (`gateway_find_tools` / `gateway_call_tool`),
  dont l'entrée SSE `passerelle-atelier` n'annonce pas de profil et garde les 53 outils.
- La capitalisation des conversations (§14) n'ajoute aucun outil wikichat : le rappel passe
  par `atelier_rappel` et `atelier_fiche` de l'Atelier, et `search_knowledge` (du noyau)
  trouve aussi les fiches.

**Mesure** (`npm run test:profils`, poids du JSON de `tools/list`, caractères / 3,4) :

| Connexion | Outils | Schémas | Jetons estimés |
|---|---|---|---|
| sans profil (passerelle) | 53 | 37 770 car. | ≈ 11 100 |
| `assistant` (noyau) | 10 | 8 402 car. | ≈ 2 470 |

Soit 78 % de moins, environ 8 600 jetons par requête de l'Assistant.

**Tests** : `test:profils` passe à 15 cas : `tools/list` de l'Assistant égal au noyau ; un outil
hors noyau (`spawn_session`, `list_projects`, `declare_project`) refusé ; `project_state`
d'un autre projet lu ; le poids des schémas mesuré et borné (moins de 40 % du total) ; le vrai
pont stdio avec `WIKICHAT_PROFIL=assistant` ne reçoit que le noyau. Le cas du briefing
déclare ses projets par une connexion sans profil, comme le ferait la passerelle.

**Pod** : rien de plus que le déploiement de `v3-memoire` ; l'Atelier pose déjà
`WIKICHAT_PROFIL=assistant` pour l'Assistant (§12.6, équipe S). Vérifier dans une
conversation de l'Assistant : `/mcp` montre 10 outils wikichat ; le journal du service porte
`profil assistant — 43 outil(s) non exposé(s)` (53 moins les 10 du noyau). Retour arrière : vider la liste (tout
redevient visible) ou revenir au commit d'avant.

## 13. Lot D actif : les lancements passent par l'Atelier

Branche `v2-lancements` (depuis `687fa9c`), 26/09/2026. Contrat côté Atelier :
`Claude Code sspcloud/docs/coherence-projet.md`, « Vague 2, équipe L ». Remplace le
lanceur préparé du §4 (MCP `atelier_ouvrir` / `atelier_envoyer` / `atelier_suivre`,
clé du propriétaire).

### 13.1 Ce qui a changé

- **Tout passe par un seul point.** `spawnHeadless` et `spawnDaemon` sont empruntés
  par :
  - le réveil sur mention (`evt-wake-any`) ;
  - les triggers et les routines ;
  - `spawn_session` (headless et daemon), `contact_agent` avec `wake` ;
  - le Pilote et l'API `/api/spawn/*`.

  Chacun **demande** désormais le lancement à l'Atelier (`src/lanceur-atelier.mjs`) :
  `POST /v1/lancements`, en-tête `X-Atelier-Lanceur`, clé
  `~/work/.secrets/atelier_lanceur_key` posée par l'Atelier. Ce n'est plus la clé du
  propriétaire.
- **Ce que wikichat transmet** :

  | Champ | Contenu |
  |---|---|
  | `origine` | `wikichat:<spawnedBy>` : `trigger:<id>:<source>`, `routine:<id>`, le nom d'un agent |
  | `projet` | le slug, tiré du dossier |
  | `nom` | l'identité wikichat de l'agent |
  | `message` | le prompt |
  | `plafonds.duree_s` | le délai du headless, ou 30 min pour un daemon |
  | `mode` | le mode déjà résolu (`resoudreModePermission`) |
  | `mode_de_la_definition: true` | seulement si le mode vient d'une définition de routine ou de trigger |
  | `outils` | la liste fixée par l'appelant (Pilote) |
  | `conversation` | la conversation Atelier retenue pour cet agent (`__atelier_conversation`), pour garder une seule identité d'un réveil à l'autre |

  Le **`permission_mode` des routines est donc transmis** (§3, §9). C'est l'Atelier qui
  décide du mode final : il applique le mode du projet, et n'accorde bypass que si le
  projet l'accorde.
- **Suivi** : un headless suit `GET /v1/lancements/<id>` jusqu'à un état final (`fini`,
  `echec`, `delai`, `arrete`, `interrompu`). Un daemon rend la main après la demande. Le
  registre (`spawn_registry`) note `mode: atelier`, `atelier_lancement`,
  `atelier_conversation` et le mode retenu, avec le statut `done`, `failed`, `refused` ou
  `delegated`.
- **Repli** :
  - si l'Atelier **ne répond pas** (connexion refusée, délai, 502/503/504, clé absente),
    wikichat relance `claude -p` lui-même, comme avant. Le registre note
    `mode: headless-repli` et `repli: <cause>` ; pour un daemon, `repli` sur l'entrée du
    daemon local ;
  - `WIKICHAT_LANCEUR_REPLI=0` interdit ce repli ;
  - un **refus** de l'Atelier (plafond, projet inconnu, 401) n'est **jamais** contourné
    par le repli.
- **Activation** : `WIKICHAT_LANCEUR` vaut `auto` par défaut. L'Atelier est utilisé dès
  que la clé du lanceur existe (le pod), `claude` sinon (un poste sans Atelier).
  `atelier` et `claude` forcent l'un ou l'autre.
- `kill_spawn` d'un agent lancé par l'Atelier appelle `POST /v1/lancements/<id>/arreter`.
- Les routines nomment leur origine (`routine:<id>` et non plus `routine:?`) : l'Atelier
  plafonne par origine.

| Variable | Défaut | Rôle |
|---|---|---|
| `WIKICHAT_LANCEUR` | `auto` | `auto`, `atelier` ou `claude` |
| `WIKICHAT_LANCEUR_REPLI` | `1` | `0` : pas de `claude -p` si l'Atelier ne répond pas |
| `WIKICHAT_ATELIER_URL` | `http://127.0.0.1:8787` | base de l'Atelier |
| `WIKICHAT_ATELIER_LANCEUR_CLE_FICHIER` | `~/work/.secrets/atelier_lanceur_key` | clé du lanceur, lue à chaque lancement, jamais journalisée |
| `WIKICHAT_ATELIER_PROJETS` | `~/work/projects` | racine des projets |
| `WIKICHAT_ATELIER_DELAI_MS` | `20000` | délai d'un appel HTTP |
| `WIKICHAT_ATELIER_SUIVI_MS` | `2000` | pas du suivi d'un headless |

`WIKICHAT_ATELIER_CLE_FICHIER` (clé du propriétaire) n'est plus lue.

**Branche (décision J-b3).**
- Une routine, une étape ou un trigger déclare `branche: auto|toujours|jamais`. Le défaut
  est `auto`, validé à l'enregistrement, et les outils `register_routine` et
  `register_trigger` l'exposent.
- `auto` : un agent lancé par une routine ou par un trigger `cron` travaille sur une
  branche `agent/<origine>/<AAAA-MM-JJ>-<sujet>`, dans une copie tenue par l'Atelier. Sa
  fin de travail attend la fusion dans « À valider ». Un réveil (`evt-wake-any`, mention)
  ou un appel ad hoc travaille dans le projet.
- Un agent sur branche ne reprend pas de conversation.
- Il n'a pas de repli `claude -p` : sans l'Atelier, il n'a pas ses gardes.
- Le registre note `branche`.

### 13.2 Tests

`npm run test:lancement` compte 47 cas :

- `src/lanceur-atelier.test.mjs` (12), contre un faux Atelier :
  - le contrat de la demande ;
  - le suivi jusqu'à la fin ;
  - un échec ;
  - un daemon ;
  - un refus sans repli ;
  - une clé refusée ;
  - un Atelier injoignable ;
  - l'arrêt.
- `src/lancement-atelier.test.mjs` (14, nouveau), contre un faux Atelier HTTP réel et un
  faux `claude` dans le PATH :
  - un réveil passe par l'Atelier sans `claude` local, et la conversation est reprise ;
  - le mode de la définition d'une routine (`plan`, `bypassPermissions`) est transmis
    avec `mode_de_la_definition` ;
  - un bypass ad hoc devient `acceptEdits` ;
  - les outils du Pilote sont transmis ;
  - un refus pour plafond ne se replie pas ;
  - si l'Atelier est injoignable, le repli passe par `claude -p`, noté au registre ;
  - avec le repli interdit, l'échec est remonté ;
  - un daemon est demandé à l'Atelier avec une durée de 1 800 s ;
  - si l'Atelier est injoignable, le daemon se replie en local ;
  - la politique de branche : une routine et un trigger `cron` en `auto` travaillent sur
    une branche, un réveil non, et `jamais` et `toujours` sont respectés ;
  - un agent sur branche ne se replie pas en local.

Les autres suites passent : `npm test` (36 cas, contre un serveur de la branche isolé
sur `PORT=3791`, avec un `HOME` temporaire), `test:hooks` (16), `test:lot-w` (16, plus
1 sauté sous Windows), `test:profils` (14) et `test:site` (3).

### 13.3 Mettre le pod à jour

1. Déployer d'abord l'Atelier de la vague 2 et le redémarrer : il pose la clé du lanceur.
2. `cd ~/work/wikichat/src && git fetch origin && git checkout v2-lancements` (une fois
   poussée), puis redémarrer wikichat. Aucune dépendance ajoutée, aucune donnée migrée.
3. Vérifier :
   - `grep -E '\[spawn\].*repli' <journal du service>` doit rester vide ;
   - un `@agent` dans un canal fait apparaître une conversation dans l'Atelier ;
   - `jq '.[-1] | {name, mode, status, atelier_lancement}' ~/.wikichat/spawn_registry.json`.
4. Retour arrière : poser `WIKICHAT_LANCEUR=claude` et redémarrer, ou revenir à `687fa9c`.

### 13.4 Ce qui reste

- Le mode `interactive` de `spawn_session` (un terminal ouvert pour une personne) lance
  toujours `claude` lui-même : c'est une fenêtre humaine, pas un agent lancé.

## 14. W8 : capitalisation des conversations et mémoire de la personne

Branche `v3-memoire` (depuis `098460c`), 26/09/2026, équipe M de la vague 3. Contrat
côté Atelier : `Claude Code sspcloud/docs/vision/architecture-transverse.md` §1.6 bis
(« État, vague 3 »), décisions A-7, S3 et S6. Tout est dans `src/memoire/`, sur les
briques existantes : même stockage et même lecteur que la connaissance, jobs et
triggers du lot W3, lancements du lot D.

### 14.1 Ce qui a changé

| Étape | Qui | Code |
|---|---|---|
| **(a) Faits** | le code, sans modèle, depuis le transcript **filtré** fourni par l'Atelier (`GET /v1/memoire/conversations/{id}`, clé du lanceur). Dates, surfaces, projet créé, créations, agents lancés, décisions (note `decision`, fichier `docs/decisions/`), fichiers touchés, commits, erreurs par outil, jetons, trois premiers messages de la personne. Une création en échec n'est pas un fait | `memoire/extraction.mjs`, `memoire/capitalisation.mjs` |
| Quand | toutes les 15 min (trigger `memoire-faits`, job `capitaliser_faits`) pour les conversations **au repos** (30 min sans écriture, ou rangées) dont l'empreinte a changé ; tout de suite à la fin d'une conversation (hook `SessionEnd`, regroupé 15 s). 30 fiches par passage au plus | `memoire/triggers.mjs`, `hooks-serveur.mjs` (une ligne) |
| **(b) Sens** | routine de nuit (trigger `memoire-nuit`, 03:30, job `capitaliser_nuit`), **née désactivée** (J-b2). Depuis le 26/09 (§14.6), chaque conversation est résumée par **un appel direct de l'Atelier** (`POST /v1/memoire/resumer`, identifiant seulement) : plus de lancement d'agent, plus de conversation ouverte dans `default`. Le modèle (`qwen3-8-27b`) rend un objet JSON (résumé de 5 lignes, sujets, décisions, questions, 3 candidats au plus) | `memoire/nuit.mjs` |
| Plafonds (A-7) | 20 conversations par nuit ; une nuit par jour ; deux échecs sur une fiche et elle n'est plus retentée seule ; un refus de l'Atelier (clé, un à la fois, plafond du jour) ou un modèle indisponible arrête la nuit. L'Atelier borne l'entrée à 58 000 caractères consigne comprise et la sortie à 1 200 jetons (la consigne en demande 600), et compte 20 résumés par jour tous appelants. Bilan de chaque nuit dans `~/.wikichat/memoire/nuits.jsonl` (jetons réels d'entrée et de sortie rendus par l'Atelier) | `memoire/nuit.mjs` |
| **(c) Rangement** | le code : `~/.wikichat/knowledge/conversations/<projet>/<id>.md` (une fiche par `session_id` de l'Atelier, l'identifiant du CLI noté à côté) et `conversations/index.jsonl`. Le sens ne remplace pas les faits : une conversation qui grandit garde son sens, marqué antérieur, jusqu'à la nuit suivante | `memoire/fiches.mjs` |
| Recherche | `connaissance.mjs` lit les fiches (sujet `conversation:<id>`) : `search_knowledge` et `/api/knowledge` les trouvent. Elles ne sont pas centrales : **profil `code` = les fiches de son projet**, l'Assistant toutes. Le rappel (`chercherConversations`) lit l'index, sans accents, pondéré comme `chercher`. Depuis le 26/09, le rappel et `search_knowledge` sont **complétés par le sens** (§14.6), dans la même portée | `connaissance.mjs`, `memoire/vecteurs.mjs` |
| **Mémoire de la personne** | `~/.wikichat/memoire/personne.json` : `profil`, `preference`, `interpretation` n'entrent que par la personne (route écrite avec la clé, appelée par les commandes réservées de l'Atelier) ; les **faits** extraits par le code (projet créé, création, agent, décision) sont enregistrés **d'office**. Doublons ignorés ; un fait oublié n'est plus réenregistré ; profil ≤ 1 500 caractères, préférences ≤ 1 200 ; 200 faits au plus ; « Corriger » garde l'historique | `memoire/personne.mjs` |
| Candidats | les candidats de la nuit partent dans « À valider » de l'Atelier (`POST /v1/memoire/propositions`, source `memoire`) : rien n'est retenu sans la personne | `memoire/nuit.mjs`, `memoire/atelier.mjs` |
| **Publication (S6)** | `export-memory` exporte les fiches (`conversations/<projet>/<id>.md`, `conversations-index.json`), chemins retirés ; chaque fiche passe le scan anti-secret (un motif bloque l'export, le rapport ne recopie pas le secret) ; les fiches entrent dans l'empreinte du manifeste. `publish-memory` gère ces deux chemins. Ni le transcript, ni `memoire/` ne sont publiés | `scripts/export-memory.mjs`, `scripts/publish-memory.mjs` |

**Routes** (`memoire/routes.mjs`, branchées par une ligne dans `server.mjs`) :

| Route | Rôle |
|---|---|
| `GET /api/memoire/rappel?q&projet&depuis&limite` | les fiches proches : `{ total, fiches, resultats: [{ id, projet, genre, debut, fin, titre, resume, objets, statut, score, similarite? }], sens }` ; `sens` vaut `fait` ou `indisponible` (lexical seul) |
| `GET /api/memoire/fiches?projet&limite`, `GET /api/memoire/fiches/:id?projet` | l'index ; une fiche (identifiant ou préfixe unique de 8 caractères), 404 hors du projet demandé |
| `GET /api/memoire/personne`, `GET /api/memoire/personne.md?partie=` | la mémoire de la personne ; une partie en markdown, pour un import `@` du contexte de l'Assistant (C1, équipe A) |
| `GET /api/memoire/etat` | fiches par statut, éléments, dernières nuits |
| `POST /api/memoire/personne`, `PATCH`, `DELETE /api/memoire/personne/:id` | **clé du lanceur** (`X-Atelier-Lanceur`) : 401 sans elle |
| `POST /api/memoire/capitaliser` `{ ids? }` | un passage des faits, tout de suite (clé) |
| `POST /api/memoire/vecteurs` `{ ids? }` | (re)calcul des vecteurs des fiches, tout de suite (clé) |
| `POST /api/memoire/nuit?limite=N` `{ ids? }` | **essai de la nuit à la main** (clé) : N conversations (3 par défaut, 20 au plus) ou celles choisies ; marqué `essai`, il ne compte pas pour la nuit du jour ; les plafonds de l'Atelier tiennent |

| Variable | Défaut | Rôle |
|---|---|---|
| `WIKICHAT_MEMOIRE` | (vide) | `0` : ni triggers de la mémoire, ni passage à la fin d'une conversation |
| `WIKICHAT_MEMOIRE_NUIT` | (vide) | `1` : le trigger de nuit naît actif (sinon la personne l'active) |
| `WIKICHAT_MEMOIRE_SENS` | (vide) | `0` : ni calcul de vecteurs, ni recherche par le sens |
| `WIKICHAT_MEMOIRE_SEUIL_SENS` | `0.35` | similarité cosinus minimale d'une fiche trouvée par le seul sens |

Le modèle de la nuit se règle côté Atelier (`ATELIER_MEMOIRE_MODELE`, défaut `qwen3-8-27b`) ;
`WIKICHAT_MEMOIRE_MODELE` et `WIKICHAT_MEMOIRE_PROJET` n'existent plus (26/09).

La clé du lanceur (`WIKICHAT_ATELIER_LANCEUR_CLE_FICHIER`) et l'adresse de l'Atelier
(`WIKICHAT_ATELIER_URL`) sont celles du §13.

### 14.2 Tests

`npm run test:memoire` (nouveau, 14 cas) : extraction sur un transcript fixe ; entrée
de la nuit (jamais un résultat d'outil, début et fin gardés sous plafond) ; fiche,
index et même recherche que la connaissance, profil `code` borné ; faits d'office et
oubli qui tient ; passage borné, repos, fin signalée ; doublons, plafonds, historique ;
**routine de nuit** : 25 candidats → 20 lancements, chaque message ≤ 30 000 jetons et
≤ 58 000 caractères, `qwen3-8-27b`, `dontAsk`, aucune autorisation d'outil, 60
propositions (3 par conversation), une nuit par jour, les 5 restantes la nuit
suivante ; refus de l'Atelier qui arrête la nuit ; réponse illisible notée et non
retentée sans fin ; lecture de la sortie ; puis contre un serveur isolé : rappel et
fiche bornés, écriture de la mémoire refusée sans la clé, `search_knowledge` en profil
`code` sans les fiches d'un autre projet, triggers (nuit désactivée), export qui
publie les fiches et qui **bloque** une fiche porteuse d'un jeton.

Les autres suites passent : `npm test` (36, serveur isolé sur `PORT=3791` avec un
`HOME` temporaire), `test:hooks` (16), `test:lot-w` (16, plus 1 sauté sous Windows),
`test:profils` (14), `test:lancement` (47), `test:site` (3).

Essai de bout en bout, hors suites (Atelier de la branche `v3-memoire` servi par
uvicorn, wikichat isolé lisant sa clé) : une conversation dont le transcript porte un
secret est fichée sans le secret ; `atelier_rappel` et `atelier_fiche` la rendent ;
une proposition acceptée par la personne arrive dans `personne.json`.

### 14.3 Mesures sur le pod (lecture seule, 26/09)

| Objet | Mesure |
|---|---|
| Conversations de l'Atelier (`~/work/sessions/*.json`) | 54, toutes `kind=code` ; 44 d'au moins 3 échanges |
| Registres par conversation (journal de l'Atelier + transcript du CLI) | moyenne 3,4 Mo, médiane 2,4 Mo, maximum 14,7 Mo (184 Mo en tout) ; 502 entrées en moyenne, 2 965 au plus |
| Paroles de la personne | moyenne 16, médiane 11, maximum 74 |
| Entrée préparée (paroles et textes du modèle, sans résultats d'outils) | moyenne 47 000 caractères (≈ 13 800 jetons), médiane 24 400 (≈ 7 200), maximum 209 000 (≈ 61 600) ; 9 conversations sur 44 dépassent 30 000 jetons, 15 dépassent 58 000 caractères |
| Rythme | 1 à 10 conversations modifiées par jour sur les dix derniers jours (≈ 4,5) |
| Conversations « Assistant » d'avant (`~/.claude/projects/-home-onyxia-work-wikichat-memory`) | 56 transcripts du CLI, 247 Ko en moyenne, une parole chacun : hors de l'Atelier, donc hors capitalisation |

**Coût estimé de la nuit** : entrée ≤ 17 000 jetons par conversation (plafond du
message), plus le plancher du harnais mesuré au relais (21 695 jetons) : ≈ 35 000
jetons par conversation. Rattrapage : 44 conversations, trois nuits (20, 20, 4), ≈
0,7 M jetons les deux premières. Régime : ≈ 3 à 4 conversations éligibles par jour, ≈
120 000 jetons par nuit ; pire cas 20 × (17 000 + 21 700 + 800) ≈ 0,8 M. La durée sur
`qwen3-8-27b` n'est pas mesurée (lancement réel interdit : pod en lecture seule).

### 14.4 Mettre le pod à jour

1. Déployer d'abord l'Atelier de la branche `v3-memoire` (routes `/v1/memoire/*`,
   commandes, filtre T10), et le redémarrer.
2. `cd ~/work/wikichat/src && git fetch origin && git checkout v3-memoire` (une fois
   poussée), puis redémarrer wikichat. Aucune dépendance, aucune migration : les
   dossiers `knowledge/conversations/` et `memoire/` naissent au premier passage.
3. Vérifier, dans l'ordre :
   ```sh
   jq '.[] | select(.id|startswith("memoire-")) | {id, enabled}' ~/.wikichat/triggers.json
   curl -s -X POST 127.0.0.1:3777/api/memoire/capitaliser -H "X-Atelier-Lanceur: $(cat ~/work/.secrets/atelier_lanceur_key)" -H 'Content-Type: application/json' -d '{}'
   curl -s 127.0.0.1:3777/api/memoire/etat | jq '{fiches, par_statut, faits}'
   grep -rlE 'ghp_|github_pat_|sk-' ~/.wikichat/knowledge/conversations | wc -l   # 0 attendu
   ```
   Le premier passage fiche au plus 30 conversations ; les suivantes au quart d'heure.
4. La nuit consomme du modèle : c'est la personne qui l'active, dans le Pilote
   (`POST /pilote/api/agent/memoire-nuit/toggle`). La première nuit traite le
   rattrapage (20 conversations au plus). Pour un essai de jour, depuis une
   conversation de l'Assistant : `fire_trigger(id="memoire-nuit", force=true)` (une
   nuit entière, dans les mêmes plafonds). Puis :
   ```sh
   tail -1 ~/.wikichat/memoire/nuits.jsonl | jq '{essai, traitees, reussies, echecs, propositions, jetons_entree, jetons_sortie, plus_grande_entree, secondes, arret}'
   ```
   Les propositions arrivent dans « À valider » (source Mémoire).
5. Publication (S6) : le seul éditeur est le pod, par la brique existante. Poser
   `WIKICHAT_MEMORY_REPO` (un clone de `wikichat-memory` sous `~/work/`, avec un jeton
   d'écriture limité à ce dépôt dans `~/work/.secrets/`) dans l'environnement du service,
   puis `node scripts/publish-memory.mjs --no-push` une fois et relire le commit. Ensuite
   la publication repart après chaque clôture de projet et après chaque nuit qui a
   enrichi des fiches (`triggerMemoryPublish`). La tâche planifiée du poste n'est pas
   modifiée ici : voir « Poste » ci-dessous.
6. Retour arrière : `WIKICHAT_MEMOIRE=0` et redémarrer, ou revenir à `098460c`. Les
   fiches restent sur le disque, lisibles par `search_knowledge` tant que le code de
   `v3-memoire` tourne ; supprimer `~/.wikichat/knowledge/conversations/` les retire.

**Poste** (à faire par Nicolas, rien n'a été changé) : la tâche planifiée qui lance
`sync-memory.mjs` toutes les 15 min depuis `Github Repositories/wikichat` publie une
mémoire que le poste seul voit, sans les fiches du pod, et a divergé (T12 : 28 commits
d'avance, 3 de retard). Dans l'ordre : (1) réconcilier une fois le dépôt
`wikichat-memory` (garder la branche du pod, reprendre à la main ce qui n'existe que sur le
poste, retirer les 19 axes en double `omen__*.md`) ; (2) désactiver la tâche planifiée
(`node scripts/install-memory-refresh.mjs --uninstall` depuis ce dépôt, ou le
Planificateur de tâches) ; elle faisait aussi l'ingestion des idées de la boîte
d'arrivée du dépôt : à reprendre sur le pod (`scripts/ingest-inbox.mjs`) si elle sert ;
(3) sur le poste, ne plus que lire le dépôt (`git pull`) ; (4) laisser le pod publier
(étape 5 ci-dessus).

### 14.5 Ce qui reste

- Les conversations tenues hors de l'Atelier (terminal, anciennes sessions de
  l'Assistant) ne sont pas fichées : l'Atelier ne les connaît pas.
- La routine hebdomadaire de consolidation (diff du profil, `assistant-contexte.md`
  §3.4) n'est pas écrite.
- Les trois points ouverts au 26/09 (plafond d'entrée du lot D, coût du harnais, sens
  par `qwen3-embedding-8b`) sont tranchés par Nicolas et traités au §14.6. Reste à
  décider : activer la nuit, après l'essai sur trois conversations.

### 14.6 Révision du 26/09 : résumé direct par l'Atelier, recherche par le sens

Branche `v3-resume` (depuis `43f029d`), équipe R. Décisions de Nicolas : A-7 révisée et
A-9 (`Claude Code sspcloud/docs/vision/decisions.md`).

**Résumé direct.** `capitaliserNuit` appelle `POST /v1/memoire/resumer` de l'Atelier
(`atelier.resumer(id)`, clé du lanceur, délai 330 s) avec le seul identifiant de la
conversation. L'Atelier (`mcp_gateway/atelier/memoire_modele.py`) lit le transcript, le
filtre (T10), prépare l'entrée avec la règle qui était ici (paroles de la personne,
1 500 caractères chacune, et réponse finale de chaque tour, 1 000 ; début et fin gardés
au-delà), la borne à **58 000 caractères consigne comprise**, appelle `qwen3-8-27b` une
fois par son relais (non streamé, 1 200 jetons de sortie au plus), et écrit l'appel au journal
unique avec ses jetons. wikichat ne fait plus que lire la réponse (`lireSortie`) et
ranger. Retirés d'ici : `promptDeNuit`, `preparerEntree`, `echanges`, le lanceur, le
projet `default`, le surcoût du harnais.

| Réponse de l'Atelier | La nuit |
|---|---|
| 200 `fait` | sens rangé, jetons réels ajoutés au bilan, candidats vers « À valider » |
| 401, 403 (clé), 409 (un à la fois), 429 (20 par jour) | s'arrête, sans contournement |
| 502 (modèle indisponible) | s'arrête |
| 404 (conversation inconnue), 422 (rien à résumer), réponse illisible | tentative notée, la nuit continue |
| Atelier injoignable | s'arrête ; la nuit peut se rejouer le même jour |

**Mesure sur le pod** (lecture seule, 26/09, sans appel de modèle : la préparation de la
route appliquée aux 44 conversations d'au moins 3 échanges, jetons = caractères / 3,4) :

| Par conversation | Avant (lancement d'agent) | Après (résumé direct) |
|---|---|---|
| médiane | ≈ 24 900 jetons | ≈ 3 100 jetons |
| moyenne | ≈ 26 400 | ≈ 4 600 |
| maximum | ≈ 38 800 | ≈ 17 000 (57 950 caractères) |

Plus la sortie (≤ 800) dans les deux cas. La différence est le harnais d'un agent code
(21 695 jetons). Une nuit de 20 conversations : ≈ 530 000 → ≈ 92 000 jetons d'entrée.
2 conversations sur 44 sont raccourcies au milieu. L'usage réel rendu par le modèle n'est
pas mesuré (aucun appel sur le pod).

**Recherche par le sens** (`memoire/vecteurs.mjs`) :

- quoi : le texte de la fiche, sans son en-tête, 6 000 caractères au plus ; il vient du
  transcript filtré par l'Atelier et passe `masquerJetons`. Jamais le transcript brut ;
- quand : après chaque passage des faits (fiches écrites, puis rattrapage de 32 fiches au
  plus) et après la nuit (fiches résumées) ; une fiche dont le texte a changé est
  recalculée (empreinte du texte) ; `POST /api/memoire/vecteurs` à la main ;
- où : `~/.wikichat/knowledge/conversations/vecteurs.jsonl`, une ligne par fiche
  (`id`, `projet`, `empreinte`, `modele`, `dim`, `v` en Float32 normalisé, base64). L'export
  assaini (S6) ne publie que les `.md` : les vecteurs restent sur le pod ;
- recherche : `rappelFusionne` (route du rappel, donc `atelier_rappel`) et
  `completerParLeSens` (`search_knowledge`, portée `all`) fusionnent les deux classements
  par rang réciproque (k = 60) ; une fiche trouvée par le seul sens doit dépasser le seuil
  (0,35, `WIKICHAT_MEMOIRE_SEUIL_SENS`, non calibré) ; la requête part avec l'instruction
  de requête de Qwen3-Embedding (posée par l'Atelier) ;
- portée : un projet donné (profil `code`, `projet` du rappel) ne compare que les vecteurs
  de ce projet ; profil `code` sans projet : la connaissance centrale seule, sans sens ;
- repli : point d'accès absent, refus, aucun vecteur : la recherche reste lexicale, sans
  erreur (`sens: "indisponible"`).

**Pourquoi par l'Atelier** et pas par la même configuration dans wikichat : S5 (l'Atelier
porte l'état opérationnel). Le point d'accès du modèle, sa clé (`llm_api_key`), le relais,
le filtre des secrets et le journal unique y sont déjà ; les faire passer par wikichat
aurait mis une seconde copie de la clé et un second chemin de sortie du texte, sans filtre
commun ni journal. Le prix : un saut local de plus par requête (délai de 4 s, puis repli
lexical).

**Tests** : `test:memoire` passe de 14 à 18 cas. Nuit : 20 résumés par identifiant (jamais
un texte), jetons réels, candidats, vecteurs des fiches résumées, une nuit par jour ;
refus 401, 409, 429 et modèle indisponible qui arrêtent la nuit ; 404 et réponse illisible
notées sans arrêter ; essai de N conversations ou de celles choisies, qui ne prend pas la
place de la nuit. Sens : vecteurs depuis le texte de la fiche (jamais un résultat d'outil,
sans en-tête), normalisés, rangés à côté de l'index, recalculés quand la fiche change ;
rappel fusionné qui trouve sans mot commun, borné au projet, lexical seul si le point
d'accès échoue ou manque. Serveur isolé avec un faux Atelier : `POST /api/memoire/nuit` et
`/api/memoire/vecteurs` refusés sans clé ; `search_knowledge` en profil `code` qui trouve
par le sens sans jamais rendre une fiche d'un autre projet, l'Assistant qui les voit
toutes ; repli lexical quand le point d'accès tombe. Autres suites inchangées et vertes :
`npm test` (36, **contre un serveur isolé** : `SERVER_URL=http://localhost:3791`, sinon la
suite vise le service qui écoute sur 3777), `test:profils` (15), `test:hooks` (16),
`test:lot-w` (16, 1 sauté sous Windows), `test:lancement` (47).

**Mettre le pod à jour** (après intégration, dans l'ordre) :

1. Déployer l'Atelier de la branche `v3-resume` (routes `/v1/memoire/resumer` et
   `/v1/memoire/vecteurs`), le redémarrer, puis vérifier la route sans rien consommer :
   ```sh
   curl -s -o /dev/null -w '%{http_code}
' -X POST 127.0.0.1:8787/v1/memoire/resumer -H 'Content-Type: application/json' -d '{}'   # 401 attendu
   ```
2. Déployer wikichat de la branche `v3-resume`, le redémarrer.
3. Vecteurs (quelques fiches, peu coûteux) ; si le bilan dit `HTTP 404` ou `405`, poser
   `ATELIER_EMBEDDINGS_URL` (adresse complète du point d'accès des embeddings) dans
   l'environnement de l'Atelier et recommencer :
   ```sh
   curl -s -X POST 127.0.0.1:3777/api/memoire/vecteurs -H "X-Atelier-Lanceur: $(cat ~/work/.secrets/atelier_lanceur_key)" -H 'Content-Type: application/json' -d '{}' | jq
   ```
4. **Essai de la nuit sur 3 conversations**, sans activer le trigger :
   ```sh
   curl -s -X POST '127.0.0.1:3777/api/memoire/nuit?limite=3' -H "X-Atelier-Lanceur: $(cat ~/work/.secrets/atelier_lanceur_key)" -H 'Content-Type: application/json' -d '{}' | jq '{essai, candidats, traitees, reussies, echecs, propositions, jetons_entree, jetons_sortie, plus_grande_entree, secondes, arret, vecteurs}'
   ```
   Pour des conversations choisies : `-d '{"ids": ["<id1>", "<id2>", "<id3>"]}'`. Puis
   relire les trois fiches (`GET /api/memoire/fiches/<id>`), les propositions dans « À
   valider », et les lignes `memoire_resumer` du journal unique
   (`~/work/.atelier-etat/journal/2026-09.jsonl`, champs `cout.entree`, `cout.sortie`).
5. Aucune conversation ne doit être apparue dans le projet `default` ; la nuit reste
   désactivée tant que la personne ne l'active pas.
