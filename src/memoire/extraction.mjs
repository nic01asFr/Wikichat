/**
 * memoire/extraction.mjs — Étape 1 de la capitalisation (W8) : les faits, par le code.
 *
 * L'entrée est le transcript **filtré** que fournit l'Atelier
 * (`GET /v1/memoire/conversations/{id}`, T10) : une liste d'événements
 * `{ quand, role: personne|modele|outil|resultat|fin, texte?, outil?, entree?, erreur?, jetons? }`.
 * Aucun modèle ici : dates, surfaces, projet créé, créations, agents lancés,
 * décisions, fichiers touchés, commits, erreurs, jetons, et les trois premiers
 * messages de la personne cités mot pour mot.
 *
 * Le même module prépare l'entrée de la routine de nuit (étape 2) : les
 * paroles de la personne et la réponse finale de chaque tour, jamais un
 * résultat d'outil, sous un plafond de caractères.
 *
 * Fonctions pures : elles ne lisent ni n'écrivent rien.
 */

// Estimation des jetons, comme l'Atelier (relais, carte) : caractères / 3,4.
export const CARACTERES_PAR_JETON = 3.4;
export const CITATIONS = 3;
export const CITATION_MAX = 280;

/** `mcp__atelier__atelier_projet_creer` → `atelier_projet_creer`. */
export function nomDeBase(outil) {
  const s = String(outil || "");
  const m = s.match(/^mcp__[^_].*?__(.+)$/);
  return m ? m[1] : s;
}

const COURT = (s, n) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + "…";
};

/** JJ/MM HH:MM, en UTC (les fiches disent l'heure du pod). */
export function dateCourte(iso) {
  const s = String(iso || "");
  if (s.length < 16) return s.slice(0, 10);
  return `${s.slice(8, 10)}/${s.slice(5, 7)} ${s.slice(11, 16)}`;
}

// Motifs de jetons : la seconde barrière. L'Atelier a déjà filtré les
// valeurs connues ; ce qui sort d'un modèle repasse ici avant d'être écrit.
const MOTIFS_JETONS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /glpat-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(?:bearer|token|basic)\s+(?!\$\{)[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/gi,
];

export function masquerJetons(texte) {
  let t = String(texte ?? "");
  for (const m of MOTIFS_JETONS) t = t.replace(m, "<jeton masqué>");
  return t;
}

const CREATIONS = {
  atelier_projet_creer: { genre: "projet", verbe: "projet créé", nom: e => e.titre || e.slug || e.title },
  atelier_artefact_creer: { genre: "creation", verbe: "création fabriquée", nom: e => e.nom || e.name || e.titre },
  atelier_agent_creer: { genre: "agent", verbe: "agent créé", nom: e => e.nom || e.name || e.titre },
  atelier_connecteur_ajouter: { genre: "connecteur", verbe: "connecteur ajouté", nom: e => e.nom || e.name },
  declare_project: { genre: "projet", verbe: "projet déclaré", nom: e => e.name || e.project || e.nom },
  add_idea: { genre: "idee", verbe: "idée notée", nom: e => e.title || e.titre },
};
const LANCEMENTS = new Set(["atelier_lancer_agent", "atelier_ouvrir", "spawn_session", "Task", "Agent", "contact_agent"]);
const ECRITURES = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * Les faits d'une conversation.
 *
 * @param {{ conversation: object, evenements: object[] }} t — la réponse de l'Atelier
 * @returns {object} faits : dates, compteurs, objets, faits datés, citations
 */
export function extraireFaits(t) {
  const conv = t?.conversation || {};
  const evs = Array.isArray(t?.evenements) ? t.evenements : [];
  const echecs = new Set(evs.filter(e => e.role === "resultat" && e.erreur).map(e => e.outil_id).filter(Boolean));
  const faits = [];
  const fichiers = [];
  const commits = [];
  const erreursParOutil = {};
  const outilsParNom = {};
  const surfaces = new Set();
  const citations = [];
  let personne = 0, modele = 0, outils = 0, erreurs = 0;
  let jetonsEntree = 0, jetonsSortie = 0, avecJetons = false;
  const nomDUnOutil = new Map();
  let debut = "", fin = "";

  for (const e of evs) {
    if (e.quand) {
      if (!debut || e.quand < debut) debut = e.quand;
      if (!fin || e.quand > fin) fin = e.quand;
    }
    if (e.surface) surfaces.add(e.surface);
    if (e.role === "personne") {
      personne++;
      if (citations.length < CITATIONS) citations.push(COURT(e.texte, CITATION_MAX));
    } else if (e.role === "modele") {
      modele++;
    } else if (e.role === "outil") {
      outils++;
      const base = nomDeBase(e.outil);
      nomDUnOutil.set(e.outil_id, base);
      outilsParNom[base] = (outilsParNom[base] || 0) + 1;
      const entree = e.entree || {};
      const reussi = !echecs.has(e.outil_id);
      const c = CREATIONS[base];
      if (c && reussi) {
        const nom = COURT(c.nom(entree) || "", 80);
        faits.push({ quand: e.quand, genre: c.genre, texte: nom ? `${c.verbe} : ${nom}` : c.verbe });
      } else if (LANCEMENTS.has(base) && reussi) {
        const qui = entree.subagent_type || entree.nom || entree.name || entree.target || entree.description || entree.projet || "";
        faits.push({ quand: e.quand, genre: "agent", texte: `agent lancé${qui ? ` : ${COURT(qui, 60)}` : ""}` });
      } else if (base === "add_project_note" && /decision/i.test(String(entree.type || "")) && reussi) {
        faits.push({ quand: e.quand, genre: "decision", texte: `décision : ${COURT(entree.content || entree.message || "", 160)}` });
      } else if (base === "close_project" && reussi) {
        faits.push({ quand: e.quand, genre: "projet", texte: `projet clôturé : ${COURT(entree.project || "", 60)}` });
      }
      if (ECRITURES.has(base)) {
        const f = entree.file_path || entree.notebook_path || entree.path;
        if (f && reussi) {
          if (!fichiers.includes(f)) fichiers.push(f);
          if (/(^|\/)docs\/decisions\//.test(f) && base === "Write") {
            faits.push({ quand: e.quand, genre: "decision", texte: `décision écrite : ${COURT(f, 100)}` });
          }
        }
      }
      if (base === "Bash" && reussi) {
        const m = String(entree.command || "").match(/git\s+commit[^\n]*?-m\s+(["'])([\s\S]*?)\1/);
        if (m) commits.push(COURT(m[2], 120));
      }
    } else if (e.role === "resultat" && e.erreur) {
      erreurs++;
      const nom = nomDUnOutil.get(e.outil_id) || "outil";
      erreursParOutil[nom] = (erreursParOutil[nom] || 0) + 1;
    } else if (e.role === "fin") {
      if (e.erreur) { erreurs++; erreursParOutil["tour"] = (erreursParOutil["tour"] || 0) + 1; }
      if (e.jetons) { avecJetons = true; jetonsEntree += e.jetons.entree || 0; jetonsSortie += e.jetons.sortie || 0; }
    }
  }
  // Les agents : faits d'office (A-7) ; les fichiers et commits restent dans la fiche.
  return {
    id: conv.id || "",
    cli_id: conv.cli_id || conv.id || "",
    projet: conv.projet || "",
    genre: conv.genre || "code",
    titre: COURT(conv.titre || "", 120),
    lance_par: conv.lance_par || "",
    empreinte_source: conv.empreinte || "",
    debut: debut || conv.cree_le || "",
    fin: fin || conv.modifie_le || "",
    surfaces: [...surfaces],
    messages: personne,
    reponses: modele,
    outils,
    outils_par_nom: outilsParNom,
    erreurs,
    erreurs_par_outil: erreursParOutil,
    jetons: avecJetons ? { entree: jetonsEntree, sortie: jetonsSortie } : null,
    fichiers,
    commits,
    faits,
    citations,
    tronque: !!t?.tronque,
  };
}

/** Les objets d'une fiche, pour l'index et le rappel : ce qui a été créé, puis les fichiers. */
export function objetsDe(f) {
  const objets = f.faits.filter(x => ["projet", "creation", "agent", "connecteur"].includes(x.genre))
    .map(x => x.texte.split(" : ").slice(1).join(" : ")).filter(Boolean);
  return [...new Set([...objets, ...f.fichiers.slice(0, 5)])].slice(0, 12);
}

/**
 * Les faits retenus d'office dans la mémoire de la personne (A-7) : ce
 * qu'elle a fait et qui se date. Ni fichiers, ni commits (bruit).
 */
export function faitsDOffice(f) {
  return f.faits
    .filter(x => ["projet", "creation", "agent", "connecteur", "decision"].includes(x.genre))
    .map(x => ({
      texte: `${String(x.quand || f.fin || "").slice(8, 10)}/${String(x.quand || f.fin || "").slice(5, 7)} : ${x.texte}${f.projet ? ` (projet ${f.projet})` : ""}`,
      source: { conversation: f.id, projet: f.projet, quand: x.quand || f.fin },
    }));
}

// ── Entrée de la routine de nuit ─────────────────────────────────────────────

/**
 * Les échanges : chaque parole de la personne, suivie de la dernière réponse
 * du modèle avant la parole suivante (sa réponse finale au tour).
 */
export function echanges(evenements) {
  const sortie = [];
  let courant = null;
  for (const e of evenements || []) {
    if (e.role === "personne") {
      courant = { quand: e.quand, personne: String(e.texte || ""), reponse: "" };
      sortie.push(courant);
    } else if (e.role === "modele" && courant) {
      courant.reponse = String(e.texte || "");
    }
  }
  return sortie;
}

/**
 * L'entrée préparée par le code (§3.4 : messages de la personne et réponses
 * finales, sans résultats d'outils), sous `maxCar` caractères.
 * Trop longue : le début (deux échanges) et la fin, avec la marque de ce qui
 * est omis au milieu.
 */
export function preparerEntree(evenements, { maxCar = 100_000, parPersonne = 1500, parReponse = 1000 } = {}) {
  const ech = echanges(evenements);
  const bloc = (x) => `[Personne ${dateCourte(x.quand)}] ${COURT(x.personne, parPersonne)}` +
    (x.reponse ? `\n[Réponse] ${COURT(x.reponse, parReponse)}` : "");
  const blocs = ech.map(bloc);
  const total = blocs.join("\n\n");
  if (total.length <= maxCar) return { texte: total, echanges: ech.length, omis: 0 };
  const tete = blocs.slice(0, 2);
  let taille = tete.join("\n\n").length + 80;
  const queue = [];
  for (let i = blocs.length - 1; i >= 2; i--) {
    if (taille + blocs[i].length + 2 > maxCar) break;
    queue.unshift(blocs[i]);
    taille += blocs[i].length + 2;
  }
  const omis = blocs.length - tete.length - queue.length;
  const texte = [...tete, `[… ${omis} échange(s) omis au milieu …]`, ...queue].join("\n\n");
  return { texte: texte.slice(0, maxCar), echanges: ech.length, omis };
}

export function jetonsEstimes(texte) {
  return Math.ceil(String(texte || "").length / CARACTERES_PAR_JETON);
}
