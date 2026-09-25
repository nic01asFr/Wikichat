# Contrat de `GET /api/cartographie` (couche wikichat de la carte)

Lot W4, 25/09/2026. Ce document est le contrat que l'Atelier consomme pour
assembler la carte (`GET /api/carte`, `atelier_carte`, transverse §1.3). Il est
recopié dans `architecture-transverse.md`. Toute évolution incompatible passe
par un nouveau numéro de `version`.

## 1. Rôle

wikichat publie **le graphe des projets** : les projets qu'il connaît, leur état
tiré de ses briques (registre, instantanés, audits, fichiers d'état, méta de
régie, clôtures) et les liens entre eux (relations déclarées, proximité par
dépendances, connecteurs partagés). L'Atelier l'assemble avec sa couche
opérationnelle (conversations, connecteurs du pool, créations, accords). Rien
n'est saisi à la main : le graphe est **calculé** à partir des fichiers (environ
0,6 s pour 160 projets sous Windows), puis gardé 15 s
(`WIKICHAT_CARTOGRAPHIE_CACHE_MS`).

## 2. Requête

```
GET http://127.0.0.1:3777/api/cartographie
```

| Paramètre | Défaut | Effet |
|---|---|---|
| `absents=1` | exclus | inclut les projets du registre dont le dossier a disparu (`statut: "missing"`) |
| `liens=relation,proximite,meme_connecteur` | tous | ne garde que ces types d'arêtes |
| `seuil=0.4` | `0.2` | poids minimal d'une arête `proximite` |

Réponse `200 application/json`. Erreur : `500 {"error": "…"}`.

## 3. Schéma

```ts
type Cartographie = {
  version: 1;
  calcule_le: string;                 // ISO 8601
  sources: {
    registre: string | null;          // registry.json : lastScan
    clustering: string | null;        // date du fichier ~/.wikichat/clusters/<date>.json lu
    audits: string | null;            // ~/.wikichat/audits.json : calcule_le
    racine_projets_atelier: string;   // WIKICHAT_ATELIER_PROJETS (défaut ~/work/projects)
  };
  noeuds: Noeud[];
  aretes: Arete[];
  groupes: Groupe[];
  limites: {
    absents_exclus: number;           // projets du registre au dossier disparu, non listés
    relations_sans_cible: number;     // relations vers un projet inconnu, ignorées
    connecteurs_communs: string[];    // connecteurs trop partagés pour faire un lien (voir §4.3)
  };
};

type Noeud = {
  id: string;                         // slug, unique dans le graphe (doublon : "<slug>~2")
  nom: string;                        // nom au registre (ou slug)
  titre: string | null;               // .atelier/projet.json > titre d'ETAT.md
  description: string | null;         // projet.json > méta déclarée > registre
  chemin: string | null;              // dossier du projet
  origine: ("registre" | "atelier" | "declare")[];
  statut: string;                     // statut au registre : "discovered" | "missing" | … ; "atelier" hors registre
  cycle_de_vie: "ideation" | "mvp" | "active" | "maintenance" | "archived" | "closed" | null;
  but: string | null;                 // set_project_meta.purpose
  axes: string[];                     // set_project_meta.axes
  pile: string[];                     // stack détectée
  github: { url: string; visibilite: string | null } | null;
  instantane: {                       // dernier instantané (snapshot.mjs, toutes les 5 min)
    le: string;
    branche: string | null;
    dernier_commit: { hash: string | null; date: string | null; message: string | null } | null;
    commits_5j: number;
    modifs_non_commitees: boolean;
  } | null;
  sante: {                            // dernier audit (audit_project / job audit_all_projects)
    score: number;                    // 0-100
    le: string;
    alertes: string[];
  } | null;
  etat: {                             // ETAT.md du projet, s'il en a un
    fichier: string;                  // chemin relatif
    modifie: string | null;
    tete: string[];                   // 3 premières lignes utiles
    a_decider: number;
  } | null;
  decisions: number;                  // fichiers docs/decisions/NNNN-*.md
  cloture: { le: string; fiche: string | null } | null;   // fiche = sujet de connaissance
  connecteurs: string[] | null;       // noms des serveurs de <projet>/.mcp.json ; null si inconnu
  atelier: null;                      // RÉSERVÉ : couche opérationnelle, remplie par l'Atelier
};

type Arete =
  | { id: string; type: "relation"; de: string; vers: string; oriente: true;
      sous_type: "depends-on" | "provides-to" | "sibling-of" | "superseded-by" | "fork-of";
      note: string | null; source: "set_project_meta" }
  | { id: string; type: "proximite"; de: string; vers: string; oriente: false;
      poids: number;                  // score de clustering (Jaccard pondéré)
      dependances_communes: string[]; // 8 au plus
      source: string }                // "clustering:<date>"
  | { id: string; type: "meme_connecteur"; de: string; vers: string; oriente: false;
      connecteurs: string[]; source: ".mcp.json" };

type Groupe = { id: string; type: "clustering"; membres: string[] };
```

Règles :

- `de` et `vers` sont toujours des `id` de `noeuds`.
- Une arête non orientée a `de < vers` (ordre alphabétique) : une paire, une arête par type.
- Les champs absents d'une source valent `null` (jamais omis) ; les listes valent `[]`.
- Aucun secret : de `.mcp.json`, seuls les **noms** des serveurs sont lus.

## 4. Sources et calcul

### 4.1 Nœuds

- **Registre** (`~/.wikichat/registry.json`) : tous les projets, sauf ceux au dossier
  disparu (sauf `absents=1`).
- **Projets de l'Atelier** : chaque dossier de `WIKICHAT_ATELIER_PROJETS` qui n'est pas au
  registre (`origine: ["atelier"]`).
- **Méta déclarée** (`declare_project`, `set_project_meta`, `close_project`) : fusionnée dans
  le nœud de même nom ou de même slug. Un projet déclaré sans dossier n'est pas un nœud.

### 4.2 Arêtes

| Type | Source | Quand |
|---|---|---|
| `relation` | `set_project_meta.relations` | toute relation dont la cible est un nœud |
| `proximite` | dernier `~/.wikichat/clusters/<date>.json` (`run_clustering`) | poids ≥ `seuil` |
| `meme_connecteur` | `<projet>/.mcp.json` des deux projets | au moins un connecteur partagé hors connecteurs communs |

### 4.3 Connecteurs communs

Un connecteur présent partout (`wikichat`, `atelier`) relierait chaque projet à tous
les autres. Il reste dans `noeud.connecteurs`, mais ne crée pas d'arête. Liste :
`WIKICHAT_CONNECTEURS_COMMUNS` (défaut `wikichat,atelier`), plus tout connecteur
présent dans plus de la moitié des nœuds qui en déclarent (au-delà de 4 nœuds).

Sur le pod, les `.mcp.json` sont générés par l'Atelier depuis son pool : c'est bien
l'information « ce projet utilise ce connecteur ». Quand l'Atelier saura mieux
(connecteurs réellement appelés, accords), il complète `noeud.atelier` et peut
ajouter ses propres arêtes lors de l'assemblage ; wikichat ne lit pas le pool.

### 4.4 Fraîcheur

- Registre : scan au démarrage, `scan_projects`, job `run_cartography` (toutes les 6 h avec
  l'équipe).
- Instantanés : toutes les 5 min pendant l'activité (job `scan_changes`).
- Audits : job `audit_all_projects` (04:00 avec l'équipe), `audit_project`.
- Clustering : job `run_clustering` (dimanche 03:00 avec l'équipe).

## 5. Exemple

```json
{
  "version": 1,
  "calcule_le": "2026-09-25T20:14:03.512Z",
  "sources": {
    "registre": "2026-09-25T11:49:02.101Z",
    "clustering": "2026-09-21",
    "audits": "2026-09-25T02:00:04.880Z",
    "racine_projets_atelier": "/home/onyxia/work/projects"
  },
  "noeuds": [
    {
      "id": "lecteur-grist",
      "nom": "lecteur-grist",
      "titre": "Lecteur Grist",
      "description": "Lire un document Grist sans serveur Grist.",
      "chemin": "/home/onyxia/work/projects/lecteur-grist",
      "origine": ["registre"],
      "statut": "discovered",
      "cycle_de_vie": "active",
      "but": null,
      "axes": ["grist"],
      "pile": ["node"],
      "github": { "url": "https://github.com/nic01asFr/lecteur-grist", "visibilite": null },
      "instantane": {
        "le": "2026-09-25T20:10:00.000Z",
        "branche": "main",
        "dernier_commit": { "hash": "3f2a…", "date": "2026-09-24T18:02:11+02:00", "message": "Servir le lecteur par racine" },
        "commits_5j": 7,
        "modifs_non_commitees": false
      },
      "sante": { "score": 78, "le": "2026-09-25T02:00:03.100Z", "alertes": ["no LICENSE"] },
      "etat": { "fichier": "ETAT.md", "modifie": "2026-09-24T16:40:00.000Z", "tete": ["Lot courant : L6, lecteur servi par racine."], "a_decider": 2 },
      "decisions": 7,
      "cloture": null,
      "connecteurs": ["grist", "wikichat"],
      "atelier": null
    },
    {
      "id": "grist-appstore",
      "nom": "Grist-AppStore",
      "titre": null,
      "description": "Catalogue de widgets Grist.",
      "chemin": "/home/onyxia/work/projects/grist-appstore",
      "origine": ["registre"],
      "statut": "discovered",
      "cycle_de_vie": "maintenance",
      "but": null, "axes": ["grist"], "pile": ["node"], "github": null,
      "instantane": null, "sante": null, "etat": null, "decisions": 0, "cloture": null,
      "connecteurs": ["grist"],
      "atelier": null
    }
  ],
  "aretes": [
    { "id": "relation:lecteur-grist>grist-appstore:provides-to", "type": "relation", "de": "lecteur-grist", "vers": "grist-appstore", "oriente": true, "sous_type": "provides-to", "note": "widget de lecture", "source": "set_project_meta" },
    { "id": "proximite:grist-appstore~lecteur-grist", "type": "proximite", "de": "grist-appstore", "vers": "lecteur-grist", "oriente": false, "poids": 0.52, "dependances_communes": ["grist-plugin-api"], "source": "clustering:2026-09-21" },
    { "id": "meme_connecteur:grist-appstore~lecteur-grist", "type": "meme_connecteur", "de": "grist-appstore", "vers": "lecteur-grist", "oriente": false, "connecteurs": ["grist"], "source": ".mcp.json" }
  ],
  "groupes": [ { "id": "clustering-1", "type": "clustering", "membres": ["grist-appstore", "lecteur-grist"] } ],
  "limites": { "absents_exclus": 12, "relations_sans_cible": 0, "connecteurs_communs": ["atelier", "wikichat"] }
}
```

## 6. Ce que wikichat en fait lui-même

`run_cartography` passe les mêmes arêtes à `map-generator` : les ponts entre îles
thématiques sont désormais les vrais liens (une arête entre deux projets d'îles
différentes fait un pont, étiqueté par type et nombre), au lieu des trois paires
de thèmes codées en dur.

## 7. Test consommateur

L'Atelier écrit un test contre ce contrat (règle 5 du plan) : `version == 1`,
`de`/`vers` ∈ `noeuds[].id`, types d'arêtes connus, `atelier: null` à remplir.
Côté wikichat, `src/lot-w.test.mjs` vérifie la même chose sur un registre jetable.
