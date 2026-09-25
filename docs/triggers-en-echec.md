# Triggers et routines en échec : inventaire (lot W6)

Relevé du 25/09/2026, en **lecture seule** : `~/.wikichat/triggers.json`,
`routines.json`, `routine-runs.jsonl` et le registre des lancements
(`spawn_registry.json`), sur le poste et sur le pod (connecteur Onyxia, session
`proj-claude-code`). **Rien n'a été désactivé ni supprimé.** Chaque ligne donne
la cause constatée et une recommandation ; la décision revient à Nicolas.

## 0. Lire les compteurs

- `fire_count` compte les **tirs**, `success_count` les actions **abouties** sur
  la fenêtre de 24 h (remis à zéro ensuite) : « 55 tirs, 1 abouti » ne veut pas
  dire 54 échecs.
- Une routine est « completed » dès que ses étapes ont été **lancées** : une
  étape `spawn` réussit quand le processus démarre, pas quand l'agent a fait
  son travail. D'où des routines vertes dont l'effet n'arrive jamais
  (cartographie, clustering).
- `last_refusal` n'était **jamais effacé** après un succès : « dernier refus :
  inconnue » restait affiché sur des triggers sains. Corrigé par le lot W
  (effacé au succès ; `last_refusal_detail` garde désormais la cause :
  sortie d'erreur du lancement, erreur de la routine).

## 1. Poste (Windows, `C:\Users\Omen\.wikichat`)

14 triggers, 572 exécutions de routines depuis le 01/05.

| Trigger | Ce qu'il fait | Constat | Cause | Recommandation |
|---|---|---|---|---|
| `2574facf` **Agent Finances** | cron 08:00 (Paris), agent Sonnet dans `C:/Users/Omen/finances`, plafond 3 | 46 tirs ; dernier lancement 25/09 06:00 terminé (code 0, 3 min 43) ; « dernier refus : inconnue » | refus **périmé** (voir §0) ; les échecs anciens n'ont pas laissé de cause. Au journal : deux connexions SSE sous le nom « Agent Finances » (« identité occupée — reste anonyme ») : l'agent se connecte deux fois à wikichat (entrée `--mcp-config` et entrée héritée) | Garder. Après déploiement, lire `last_refusal_detail` au prochain échec. Vérifier qu'aucun `.mcp.json` du dossier `finances` ne déclare aussi `wikichat` |
| `53b8e43d` **Synthèses-colaig** | cron 08:00, agent dans `~/synthese-colaig` | 27 tirs, **aucun abouti** | `repo_path` vaut littéralement `~/synthese-colaig` : le `~` n'est pas développé (`Project path not found`) ; et `C:\Users\Omen\synthese-colaig` n'existe pas | Corriger le dossier (chemin absolu d'un dossier existant) depuis le Pilote, ou désactiver. Décision de Nicolas |
| `evt-wake-any` | réveille un agent nommé hors ligne mentionné avec `expects_reply` | 175 tirs, 7 réveils ; dernier refus `repo_inconnu` | la cible n'a pas de `__cwd` mémorisé (identités de conversation `<slug>-<id6>` créées par les hooks, noms venus du pod) : rien à relancer. Refus voulu, sans coût | Garder. Plus tard (lot C) : prendre le dossier dans `conversations.json` (`racine`) quand `__cwd` manque |
| `team-cron-digest` | 22:00 : message « @Librarian — heure du digest » sur #library | 60 exécutions « completed » | **personne n'écoute** : le Librarian résident a été retiré et `team-lifecycle-librarian` est désactivé. Le message part, rien ne suit | Désactiver, ou remplacer par la routine d'absorption (job `absorb_closures`, sans agent). Décision de Nicolas |
| `team-cron-health-check` | 17:00, routine `team:health-check` : agent « HealthChecker » (bash + un message) | 53 exécutions « completed » ; au registre des lancements, HealthChecker en échec (code 1) les 22/09 et 23/09 (×3), réussi le 25/09 | code de sortie 1 sans journal conservé sur le poste ; rôle qui revient à l'exécuteur des gardiens (J-a, santé) | Garder jusqu'au gardien G1, puis désactiver. Limite : une étape `spawn` de routine est lancée sans attendre sa fin, et la sortie d'un agent headless n'est pas gardée (seuls les daemons ont `~/.wikichat/spawn-logs/`) : la cause de ces codes 1 reste inconnue |
| `team-cron-cartography` | toutes les 6 h, routine `team:job-cartography` | agents « Cartographer » en échec (code 1) les 22, 23 et 24/09 ; carte du 25/09 produite | l'agent n'était là que pour appeler `run_cartography` ; quand il échoue, la carte ne bouge plus et la routine reste verte | **Réglé par W3** : la routine appelle la fonction directement (réparée au démarrage, stats gardées) |
| `team-cron-clustering` | dimanche 03:00, routine `team:job-clustering` | 14 exécutions « completed », dernier fichier `clusters/` du **30/08** | l'agent « Matchmaker » n'appelait plus `run_clustering` ; échec invisible | **Réglé par W3** (job direct) |
| `team-channel-library-closure` | clôture sur #library → Librarian-Absorber | 1 tir (01/05) : une seule absorption en 5 mois | le Closer lisait des chemins faux et ne rappelait pas `close_project(auto=false)` : aucune clôture n'arrivait sur #library | **Réglé par W5** (chemins du Closer ; la clôture devient une fiche par le code, avant tout agent) |
| `evt-artifact-to-kb` | événement `artifact` → agent LibrarianAbsorber (Sonnet), plafond 12 | 9 tirs, 4 aboutis, refus « inconnue » | échecs de lancement sans cause gardée | Garder ; lire `last_refusal_detail` après déploiement |
| `evt-claude-md-changed` | CLAUDE.md modifié → ProjectMetaUpdater (Haiku), plafond 8 | 15 tirs, 5 aboutis | idem | Garder |
| `team-cron-axis-discovery` | lundi 08:00, AxisDiscoverer | 11 exécutions, plafond 1 | sain | Garder |
| `team-lifecycle-{orchestrator,sentinel,librarian}` | lancement des résidents au démarrage | désactivés depuis le 10/08 ; 20 échecs anciens « Budget atteint : 11 à 20/10 sessions » | résidents retirés (coût) | Laisser désactivés ; suppression possible |

## 2. Pod (`/home/onyxia/.wikichat`)

14 triggers ; pas d'équipe (`WIKICHAT_AUTONOMOUS_TEAM` absent) ; **porte dormante
active** (`WIKICHAT_DORMANT_DISABLED` absent : les crons de la nuit ne tirent
qu'au réveil, par rattrapage — vu le 25/09 à 11:48-11:51).

| Trigger | Ce qu'il fait | Constat | Cause | Recommandation |
|---|---|---|---|---|
| `85539555` Veille des dépôts Git | 08:00, agent dans `~/work/wikichat-memory` | 53 tirs ; dernier lancement terminé (code 0) | sain | Garder |
| `2007ca6b` Mémoire des projets | 06:00, `entretien-savoir` | refus `already_running` | rattrapage au réveil pendant que le lancement précédent tournait encore ; sans conséquence | Garder |
| `94219a5f` Descriptions des connecteurs | 05:00, `atelier-connecteurs` | refus `already_running` | idem | Garder |
| `cron-routine-4h` → `paradox-research` | toutes les 4 h, 14 étapes, 8 agents, plafond 6 | derniers passages « completed » (≈ 11 min) ; 35 échecs anciens « unknown action: send_message / spawn_session » | ancienne définition avec des actions inexistantes (refusées désormais à l'enregistrement) ; le trigger ne passe pas les paramètres `{paradoxe}` et `{domaine}` : les prompts les contiennent tels quels | **Question déjà ouverte** (`decisions.md`, « en attente ») : le couper comme les cinq autres. S'il reste : fournir `params` dans l'action |
| `veille-depots-cron` | « cron » d'un message | 0 tir | **aucun `schedule`** (`config: {}`) : jamais armé | Supprimer (reste d'essai) |
| `mention-supervisor` | mention `@Supervisor-Physicist` → agent dans `nouveau-projet-4`, plafond 100 | 0 tir | latent, rattaché à la recherche arrêtée | Désactiver avec `paradox-research` |
| `channel-insights` | #insights, motif « paradoxe, breakthrough, anoma » → agent, plafond 100 | 0 tir | idem ; motif large | Désactiver avec `paradox-research` |
| `evt-wake-any` | réveil générique | 1 tir (06/09), `aucune_cible_eligible` | sain | Garder |
| `c73d7f08` Savoir commun, `b5538f7c` Agent Qgis complet | agents planifiés | désactivés (03/09 ; jamais tiré) | — | Laisser |
| `physics-research-cron`, `cron-research-30min`, `cron-cleanup-weekly`, `weekly-research-report` | recherche `nouveau-projet-4` | désactivés le 25/09 | — | Laisser |

### Risque de données sur le pod (hors triggers, mais bloquant pour W2)

`~/.wikichat` sur le pod est un **dossier ordinaire sur la couche éphémère du
conteneur** (`/`, overlay), pas un lien vers le volume `~/work`. L'Atelier prévoit
ce lien (`wikichat_ensure.ensure_wikichat_data_link` : `~/.wikichat → ~/work/wikichat`),
mais ne remplace jamais un dossier non vide : le lien n'a donc jamais été posé.
`triggers.json`, `routines.json`, `registry.json`, `knowledge/`, `ideas/`,
`conversations.json`… disparaîtraient avec le conteneur (en place depuis
139 jours). `~/work/wikichat/triggers.json` (27/08, 504 octets) est une copie
ancienne, pas la vraie. **À régler avant de déployer W2**, sinon la mémoire et
les messages, aujourd'hui sur le volume (`~/work/wikichat/src/.wikichat/`),
passeraient eux aussi sur la couche éphémère : voir `atelier-coherence.md`,
section « Lot W », étape 2.

## 3. Ce que le lot W change pour ces triggers

- `last_refusal` effacé au succès ; `last_refusal_detail` garde la cause d'un
  échec de lancement ou de routine.
- Étape `job` et action `job` : cartographie, clustering, audits, harmonisation,
  instantanés et absorption des clôtures tournent sans agent, et même porte
  fermée (J-c).
- Une routine dont une étape a une action inconnue est refusée à
  l'enregistrement (cause des 35 échecs de `paradox-research`).
- Plafond par défaut : 24 ; un trigger créé par un agent naît désactivé (J-b).
