# wikichat et la cohérence de projet (lots A, C, D)

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

## 4. Lancement par l'Atelier — préparé, inactif (lot D)

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
