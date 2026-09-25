# Hooks, suivi de projet et dialogue direct

Conception du 25/09/2026, branche `atelier-coherence`. Complète
`docs/atelier-coherence.md` (lots A, C, D côté wikichat) et, côté Atelier,
`Claude Code sspcloud/docs/coherence-projet.md` (lots B « contexte par hook
SessionStart », C « une identité par conversation », D « lancements par
l'Atelier ») et `docs/structure-projet.md` (ETAT.md, projet.json, décisions).

Objectif : que wikichat serve (1) le **suivi des projets** et (2) le
**dialogue direct entre agents** par les seuls mécanismes natifs de Claude
Code, identiques sur toutes les surfaces — tour de l'Atelier (`claude -p`
stream-json), extension VS Code, terminal, agents lancés par wikichat — sans
consommer de modèle quand il n'y a rien à dire.

## 1. Ce qui existe et ce qui ne va pas

| Élément | Aujourd'hui | Défaut |
|---|---|---|
| Hook `Stop` (`wikichat-mailbox-hook.mjs`) | à chaque fin de tour : relève la boîte ; **attend jusqu'à 45 s** si la conversation est « chaude », puis jusqu'à l'ETA annoncé (5 min max) ; bloque l'arrêt pour tout message reçu ; 12 relances | prolonge un tour de l'Atelier sans signal ; attend même quand rien n'est attendu ; relance pour un simple « pour info » |
| Identité du hook | `WIKICHAT_AGENT`, sinon dernier `register` lu dans le transcrit | sans `register`, VS Code et terminal n'ont aucune identité (le hook se tait) ; l'Atelier et VS Code n'ont pas le même nom pour la même conversation |
| Identité MCP | `?agent=` de l'URL ; `atelier` commun dans 20 `.mcp.json` du pod ; `${WIKICHAT_AGENT:-}` vide hors Atelier | toutes les fenêtres parlent sous `atelier` |
| Contexte | l'agent doit appeler `get_briefing` (coût : un appel d'outil, ~3 000 caractères) | rien n'arrive sans demande ; la consigne a été retirée |
| Projet | `project-state.json` tenu à part (`add_project_note`, `declare_project`) | double de `ETAT.md` et `docs/decisions/`, périme (« Projet sans nom », D8) |
| Fils | `reply_to`, `expects_reply`, `status`, `eta_seconds` portés par message | aucun fil : impossible de savoir ce qui est ouvert, qui doit répondre, si c'est lu |

## 2. Faits natifs retenus (documentation officielle, lue le 25/09)

- Entrée commune de tout hook : `session_id`, `transcript_path`, `cwd`,
  `permission_mode`, `hook_event_name`. `CLAUDE_CODE_SESSION_ID` est posé dans
  l'environnement des hooks, des commandes Bash **et des serveurs MCP stdio**
  (un serveur stdio garde l'identifiant de son lancement).
- `SessionStart` (sources `startup`, `resume`, `clear`, `compact`, `fork`) :
  `hookSpecificOutput.additionalContext` est placé au début de la conversation ;
  `sessionTitle` possible ; seuls `command`/`mcp_tool` ; il tourne **avant** la
  connexion des serveurs MCP ; en interactif il tourne en arrière-plan mais la
  première réponse l'attend.
- `UserPromptSubmit` : `additionalContext` joint au message ; délai par défaut
  30 s (un hook trop long est annulé, le message passe sans contexte).
- `Stop` : `decision: "block"` + `reason` (relance), ou
  `hookSpecificOutput.additionalContext` (relance « feedback », sans erreur
  affichée) ; `stop_hook_active` ; **Claude Code force l'arrêt après 8 blocages
  consécutifs** ; `last_assistant_message`, `background_tasks`.
- `systemMessage` (tout événement) : avertissement montré à la personne ; en
  `--output-format stream-json`, arrive comme message informatif — c'est le
  **signal visible** pour l'Atelier.
- `SessionEnd` (raison `clear`, `resume`, `logout`, `prompt_input_exit`,
  `other`) : pas de décision, **budget commun de 1,5 s** (relevé seulement si un
  hook déclare un `timeout` plus long).
- Hooks `async` / `asyncRewake` : `asyncRewake: true` lance le hook en
  arrière-plan ; **s'il sort en code 2, Claude est réveillé même si la session
  est inactive**, avec la sortie d'erreur en rappel système. En `-p`, un hook
  asynchrone encore en cours est tué à la fin du processus. Le `timeout` est
  appliqué aux hooks `asyncRewake`.
- Plafond : `additionalContext`, `systemMessage` et sortie brute sont coupés à
  10 000 caractères (le surplus part dans un fichier que Claude ne lit pas).
- Rédiger le contexte comme des faits (« l'identité wikichat de cette
  conversation est… ») et non comme des ordres système : sinon les défenses
  contre l'injection le signalent à la personne au lieu de s'en servir.
- Mêmes hooks dans VS Code et au terminal ; ils tournent en `-p`.
- Deux hooks identiques dans deux fichiers de réglages ne tournent qu'une fois.

## 3. Principe

**Un seul script de hook, mince ; toute la décision côté serveur.** Chaque
événement lance `node scripts/wikichat-hook.mjs <événement>`, qui transmet
l'entrée JSON du hook (plus `WIKICHAT_AGENT`, `ATELIER_SESSION`,
`CLAUDE_CODE_ENTRYPOINT` pris dans son environnement) à
`POST http://127.0.0.1:3777/api/hooks/<événement>` et imprime ce que le serveur
répond — déjà au format de sortie de Claude Code. Conséquences :

- même comportement sur toutes les surfaces, puisque la logique est au même
  endroit ;
- testable sans Claude Code (entrées JSON réelles → sorties) ;
- **échec silencieux** : serveur absent, délai dépassé, JSON illisible → sortie
  vide, code 0. Un hook ne casse jamais un tour ;
- délais courts côté client (session-start 2 s, prompt/stop 1,5 s,
  session-end 0,8 s), `127.0.0.1` et non `localhost` (évite la résolution IPv6
  sous Windows) ;
- **aucune injection si rien de neuf** : le serveur répond `{}`, le script
  n'imprime rien.

## 4. Les hooks, un par un

| Hook | Fait | Injecte | Coût visé | Surfaces |
|---|---|---|---|---|
| `SessionStart` (tous) | établit l'identité de la conversation, la présence, rattache la connexion MCP ; au besoin, briefing court | `additionalContext` ≤ 2 500 car. ; rien au `resume` si rien n'a changé | < 150 ms | toutes |
| `UserPromptSubmit` | remet le courrier arrivé depuis le dernier tour ; signale un `ETAT.md` modifié par un autre ; fils en retard | ≤ 2 000 car., **rien** s'il n'y a rien | < 120 ms | toutes |
| `Stop` (synchrone) | ne relance **que** si un message avec `expects_reply` est arrivé pour cet agent ; plafond 3 relances par tour humain ; `systemMessage` visible à chaque relance | `reason` ≤ 3 000 car. | < 120 ms, aucune attente | toutes |
| `Stop` (`asyncRewake`, « guetteur natif ») | attend en arrière-plan, sans modèle, qu'une réponse attendue arrive ; sort en code 2 → réveille la session inactive | le message, au réveil seulement | 0 jeton en attente ; un processus node (~40 Mo) par session inactive, 30 min au plus | VS Code, terminal ; **pas** dans un tour de l'Atelier (voir §6) ; en `-p` tué à la fin |
| `SessionEnd` | présence hors ligne, guetteur arrêté | rien | < 100 ms (budget 1,5 s partagé avec `atelier-figer-le-travail.sh`) | toutes |

Non retenus : `PreCompact` (rien à faire avant), `PostCompact` (le
`SessionStart` de source `compact` suffit), `Notification` (affichage seulement),
`PreToolUse` sur les chemins protégés (relève de l'Atelier, lot B/E),
`SubagentStop` (un sous-agent n'a pas d'identité propre : il parle au nom du
parent).

### 4.1 SessionStart — identité et briefing

**Identité** (serveur, `src/conversations.mjs`), dans l'ordre :

1. `WIKICHAT_AGENT` présent et non générique → ce nom fait foi (tour de
   l'Atelier : `<slug>-<id6>` ; agent lancé par wikichat : son nom) ;
2. la conversation (`session_id`) est déjà connue → son nom ;
3. un agent a déclaré ce `session_id` par le passé (`__claude_session_id`) →
   son nom ;
4. `ATELIER_SESSION` présent → `<slug>-<ATELIER_SESSION[:6]>` ;
5. sinon → `<slug>-<session_id[:6]>`, où `slug` est le dossier du projet sous
   `~/work/projects` (`WIKICHAT_ATELIER_PROJETS`), le `slug` de
   `.atelier/projet.json`, ou le nom du dossier racine.

C'est **la formule de l'Atelier** (`sessions.py:_nom_wikichat` =
`<slug>-<session_id[:6]>`, et l'identifiant Atelier vaut celui de Claude pour
une conversation née dans l'Atelier). Une même conversation porte donc le même
nom dans l'Atelier, dans VS Code (qui la reprend par son identifiant) et au
terminal. Plus d'identité commune `atelier` : ce nom (et `session-…`, les `${…}`
non développés) est **générique** (`WIKICHAT_NOMS_GENERIQUES`, défaut
`atelier`) et ne fait jamais foi.

Si le nom d'une conversation change (l'Atelier adopte une conversation née dans
VS Code et lui donne son propre nom), l'ancien devient un **alias** du nouveau :
un message adressé à l'ancien arrive au nouveau.

**Connexion MCP.** Le serveur retient `session_id → nom`. Une connexion SSE qui
porte l'identifiant de conversation (`?claude_session=` posé par le pont stdio
`wikichat-mcp-stdio.mjs` à partir de `CLAUDE_CODE_SESSION_ID`, ou en-tête
`x-wikichat-claude-session` du `headersHelper`) prend ce nom, même si son URL dit
`?agent=atelier`. Si la connexion est arrivée avant le hook, elle est renommée
quand le hook déclare la conversation. Sans identifiant de conversation dans la
connexion (entrées `?agent=atelier` actuelles), le serveur ne peut pas savoir
quelle fenêtre parle : c'est le point 1 du contrat avec l'Atelier (§8).

**Briefing** (faits, pas d'ordres), plafonné à 2 500 caractères :

```
Identité wikichat de cette conversation : lecteur-grist-72b08c (projet lecteur-grist, VS Code).
Projet « Lecteur Grist » — ETAT.md (modifié il y a 2 j) :
  Lot courant : L6 …  / Prochaine étape : …
  À décider : OIDC ; hôte des widgets
Décisions récentes : 0007 asm.js plutôt que wasm (acceptée) ; …
Courrier : 2 message(s) — lecteur-grist-a1b2c3 (réponse attendue) : « … »
Fils ouverts : f-3a9c avec atelier-savoir-99e1 — réponse attendue de ta part.
Présents sur ce projet : lecteur-grist-a1b2c3 (Atelier, il y a 3 min).
```

| Source | `startup`, `clear`, `fork` | `resume` | `compact` |
|---|---|---|---|
| Identité (1 ligne) | oui | seulement si elle a changé | oui |
| Projet (tête d'ETAT, À décider, décisions) | oui | seulement si l'empreinte des fichiers a changé depuis la dernière injection pour cette conversation | oui (le résumé a pu la perdre) |
| Courrier non lu | oui, remis (curseur avancé) | oui | oui |
| Fils ouverts | oui | oui s'il y en a | oui |
| Présents | oui | non | non |

Le `resume` compte : l'Atelier relance `claude --resume` à chaque reprise de
processus ; réinjecter le même briefing à chaque fois ferait grossir la
conversation pour rien.

`sessionTitle` n'est pas posé : le titre relève de l'Atelier (lot H).

### 4.2 UserPromptSubmit — le courrier au début du tour

Relève sans attendre ce qui est adressé à l'agent depuis le curseur (le même
que `poll` et le hook `Stop` : jamais de doublon). Au plus 8 messages de
300 caractères, 2 000 au total ; au-delà « N autres : `poll()` ». Ajoute une
ligne si `ETAT.md` du projet a changé depuis la dernière injection dans cette
conversation (« ETAT.md modifié il y a 4 min — lot courant : … »), et les fils
dont l'échéance de réponse est dépassée. Rien de tout cela → sortie vide.

C'est le canal normal du courrier « pour info » : il attend le prochain tour
au lieu d'en provoquer un.

### 4.3 Stop — non bloquant par défaut

- Relève **sans attente** (`WIKICHAT_HOOK_WAIT_MS` défaut 0 ; l'attente de
  45 s de l'ancien hook reste possible en la posant).
- Relance (`decision: "block"`) **seulement** si au moins un message arrivé
  porte `expects_reply=true`. Le lot entier est alors remis (curseur avancé).
  Sinon rien n'est remis : ces messages arrivent au prochain
  `UserPromptSubmit`.
- **Plafond clair** : 3 relances par tour humain (`WIKICHAT_HOOK_MAX_RELAYS`),
  en deçà du plafond natif de 8. Au-delà, rien n'est remis et la relance
  suivante attendra la personne.
- **Signal visible** : chaque relance porte un `systemMessage`
  (« wikichat : tour prolongé — réponse attendue par X (relance 1/3) »). Dans
  un tour de l'Atelier (`ATELIER_SESSION` présent), il arrive dans le flux
  stream-json comme message informatif : l'interface peut l'afficher.
  `WIKICHAT_STOP_ATELIER=jamais` interdit toute relance dans un tour de
  l'Atelier (le courrier attend alors le tour suivant).

### 4.4 Stop asyncRewake — le guetteur natif

Remplace le guetteur lancé à la main (`wikichat-attendre-courrier.mjs`) pour les
sessions interactives. À chaque fin de tour, un hook `asyncRewake` part en
arrière-plan : il attend (long-poll de 55 s par tranche, sans modèle) qu'un
message **avec `expects_reply`** arrive pour cet agent, le remet, et sort en
code 2 — Claude Code réveille la session et lui montre le message. Un seul
guetteur par conversation : le plus récent remplace les précédents (le serveur
libère l'ancien). `SessionEnd` l'arrête. Délai 30 min (`timeout: 1800`).

Garde-fous :
- **pas dans un tour de l'Atelier** (`ATELIER_SESSION`) : le processus y vit
  d'un tour à l'autre et un réveil spontané démarrerait un tour à l'insu de
  l'interface ; pour ces conversations, le réveil passe par l'Atelier (lot D,
  `atelier_envoyer`) ;
- pas dans un agent lancé par wikichat en `-p` (inutile : tué à la fin) ;
- installé seulement si le binaire connaît `asyncRewake`
  (`claude --version` ≥ 2.1.250, ou `WIKICHAT_HOOK_REVEIL=1`) : une version
  ancienne l'ignorerait ou refuserait le réglage. **À vérifier sur le pod
  (2.1.281) avant de s'y fier** ;
- désactivable : `WIKICHAT_HOOK_REVEIL=0`.

### 4.5 SessionEnd

Présence hors ligne (raison notée), guetteur libéré. Le curseur de boîte est
déjà tenu côté serveur : rien à sauver. Pas de `timeout` déclaré : le budget
de 1,5 s partagé avec `atelier-figer-le-travail.sh` n'est pas relevé. Pas de
note de fin automatique (bruit ; la fin de lot s'écrit dans `ETAT.md`).

## 5. Suivi de projet dérivé des fichiers

**Les fichiers du projet font foi ; wikichat les lit et n'y écrit pas** (contrat
de sûreté : wikichat n'écrit jamais hors de `.wikichat/` dans un projet).

`src/projet-fichiers.mjs` lit, à partir du dossier de travail (remonte jusqu'à
`.atelier/projet.json`, `ETAT.md` ou `.git`) :

| Donnée wikichat | Source | Lecture |
|---|---|---|
| titre, description, slug | `.atelier/projet.json` (`titre`/`title`, `description`, `slug`) | sinon nom du dossier |
| état | `ETAT.md` (ou `fichiers.etat` de `projet.json`) | tête : lignes avant la 2ᵉ section, 10 lignes au plus |
| questions ouvertes | `ETAT.md` § « À décider » | puces |
| demandes à l'Atelier | `ETAT.md` § « Demandé à l'Atelier » | puces |
| décisions | `docs/decisions/NNNN-*.md` | numéro, titre (`# …`), statut (`Statut : …`), date |
| empreinte | dates et tailles de ces fichiers | pour « rien de neuf » et le cache |

Lecture mise en cache par date de modification ; aucune écriture.

- **Outil MCP `project_state(project?)`** et **`GET /api/projets/etat?cwd=…`** :
  la même vue — fichiers + coordination du moment (présents, fils ouverts,
  notes éphémères). C'est l'équivalent wikichat d'`atelier_projet_etat`, lu aux
  mêmes sources.
- `list_projects`, `/api/projects/:slug` : titre, description, décisions et
  questions dérivées remplacent les valeurs tenues à part quand les fichiers
  existent (fin de « Projet sans nom »).
- `add_project_note` : dans un projet qui a ces fichiers, `decision`,
  `question`, `blocker` et `note` deviennent de la **coordination éphémère**
  (message sur le canal du projet, visible dans `project_state`) ; la réponse
  dit où écrire la trace durable (`docs/decisions/NNNN-….md`, `ETAT.md` § À
  décider). Rien n'est plus ajouté à `project-state.json` pour ces projets.
  Projets sans fichiers : comportement inchangé.

## 6. Dialogue direct

- **Adressage** : par nom de conversation (`<slug>-<id6>`), alias compris ;
  un nom partiel unique est résolu comme avant.
- **Fils** (`src/fils.mjs`) : tout DM (et tout message portant `thread`) appartient
  à un fil `f-xxxxxx` : participants, sujet, statut `ouvert`/`clos`, **qui doit
  répondre** (`attend`), échéance, messages, lectures. `reply_to` (identifiant
  complet ou 8 premiers caractères) rattache au fil du message cité. Un message
  `status="done"` clôt le fil ; `expects_reply=true` le rouvre et désigne le
  destinataire comme débiteur ; `reply_by_seconds` fixe une échéance.
- **Accusés de lecture** : un message remis par un hook, `poll` ou `/api/inbox`
  est marqué lu par son destinataire (`state.reads`) ; le fil l'affiche.
- **Livraison sans polling** : `SessionStart` et `UserPromptSubmit` (tout
  message), `Stop` (réponse attendue, sans attente), guetteur natif (réponse
  attendue, session inactive). `poll(timeout_seconds)` reste pour un
  rendez-vous explicite.
- **Réveil hors ligne** : `contact_agent(wake=true)` ; avec
  `WIKICHAT_LANCEUR=atelier`, la reprise passe par `atelier_ouvrir` /
  `atelier_envoyer` (déjà écrit, `src/lanceur-atelier.mjs`), donc visible dans
  l'Atelier.
- **Visibilité** : `GET /api/fils?agent=…|session=…` et
  `GET /api/conversations/:session_id` (§8), outil `list_threads`.

## 7. Coût

- Rien d'injecté quand rien n'est neuf (sortie vide).
- Plafonds : SessionStart 2 500 car., UserPromptSubmit 2 000, Stop 3 000,
  un message 300 car. — loin des 10 000 natifs.
- Tout en local (`127.0.0.1:3777`), délais courts, échec silencieux.
- Le modèle n'est sollicité que par un message qui attend une réponse (relance
  `Stop` ou réveil) ; le reste voyage avec un tour que la personne a lancé.
- Mesures : §10.

## 8. Contrat avec l'Atelier

### Ce que wikichat expose (local, `127.0.0.1:3777`)

| Endpoint | Rend |
|---|---|
| `GET /api/conversations/:session_id` | `{nom, alias, projet, surface, en_ligne, vu, fils_ouverts}` — correspondance session Claude → nom wikichat |
| `GET /api/conversations?projet=<slug>` | conversations connues d'un projet et leur présence |
| `GET /api/fils?session=<id>` ou `?agent=<nom>` (`&statut=ouvert\|clos\|tous`) | fils, débiteur, échéance, derniers messages, lectures — pour afficher les échanges d'une conversation |
| `GET /api/projets/etat?cwd=<chemin>` | vue projet (fichiers + coordination) |
| `POST /api/hooks/<événement>` | usage interne des hooks |

### Ce qui relève de l'Atelier (à transmettre à l'agent Atelier)

1. **Connexion wikichat portant la conversation** (lot C) : dans les
   `.mcp.json` écrits par la liaison de projet et dans la portée utilisateur,
   remplacer `?agent=atelier` par une entrée qui transmet
   `CLAUDE_CODE_SESSION_ID` : le pont stdio
   (`{"command":"node","args":["<wikichat>/scripts/wikichat-mcp-stdio.mjs"],"env":{"WIKICHAT_AGENT":"${WIKICHAT_AGENT:-}"}}`,
   documenté comme recevant la variable) ou l'entrée SSE avec
   `headersHelper` `wikichat-token-helper.mjs` (à vérifier : la documentation
   ne dit pas si le helper reçoit `CLAUDE_CODE_SESSION_ID`). Les tours de
   l'Atelier peuvent garder `?agent=<nom résolu>`.
2. **Ne plus écrire `atelier` comme nom** nulle part (20 `.mcp.json` du pod le
   portent).
3. **Même formule de nom** : garder `<slug>-<session_id[:6]>` ; pour une
   conversation adoptée depuis VS Code, prendre l'identifiant Claude (pas un
   nouvel identifiant Atelier) si possible — sinon wikichat pose un alias.
4. **Signal visible** : afficher dans la conversation les `systemMessage` du
   flux stream-json (relance `Stop` par wikichat) ; afficher les fils via
   `GET /api/fils?session=…`.
5. **Contexte `SessionStart` (lot B)** : le hook de l'Atelier et celui de
   wikichat tournent côte à côte (en parallèle, sorties cumulées). L'Atelier
   écrit `.atelier/contexte.md` et ne répète pas le briefing wikichat. Si
   l'Atelier préfère un seul hook, il peut appeler
   `POST /api/hooks/session-start` et recopier `additionalContext`.
6. **Réglages** : l'installation de l'Atelier qui réécrit
   `~/.claude/settings.json` doit **conserver** les entrées wikichat
   (`wikichat-hook.mjs`) ; wikichat conserve `atelier-figer-le-travail.sh`.
7. **Lot D** : pour activer `WIKICHAT_LANCEUR=atelier`, `atelier_envoyer`
   accepte désormais `mode` et `peut_attendre` (fait côté Atelier) ; wikichat
   doit transmettre le `permission_mode` des routines (reste à faire, §9).
8. **Structure de projet (lot G)** : noms de sections d'`ETAT.md`
   (« À décider », « Demandé à l'Atelier ») et ligne `Statut :` des décisions,
   que wikichat lit tels quels ; `projet.json` : `titre`, `description`, `slug`,
   `fichiers.etat`.

## 9. Hors de ce lot

- Transmission du `permission_mode` des routines au lanceur Atelier.
- Réveil automatique d'un destinataire hors ligne à l'échéance d'un fil
  (aujourd'hui : signalé à l'expéditeur seulement).
- `PreToolUse` sur chemins protégés (Atelier, lot E).

## 10. Implémentation et mesures

Voir `docs/atelier-coherence.md` §10 (implémentation, tests, mesures) et §8
(mise à jour du pod).
