/**
 * connaissance.mjs — Le seul lecteur de la connaissance (lot W1).
 *
 * La connaissance est faite de fichiers markdown **à plat** :
 *   - `~/.wikichat/knowledge/*.md` : axes transverses (`<sujet>-axis.md`,
 *     brouillons `*.draft.md`, fiches de clôture `closure-<projet>.md`) ;
 *   - `<projet>/.wikichat/knowledge/*.md` pour chaque projet du registre.
 *
 * Trois lecteurs la lisaient chacun à leur façon : `search_knowledge` (à plat,
 * correct), `GET /api/knowledge` (qui attendait des sous-dossiers
 * `<sujet>/kb.md` et renvoyait donc une liste vide) et la ressource
 * `wikichat://kb/{topic}` (qui lisait `<cwd>/.wikichat/knowledge`). Ils passent
 * tous par ce module.
 *
 * Identifiant d'une fiche (`sujet`) : le nom du fichier sans `.md`, préfixé du
 * slug du projet pour une fiche de projet (`<slug>/<nom>`).
 *
 * W8 : les fiches de conversation (`knowledge/conversations/<projet>/<id>.md`,
 * écrites par `memoire/fiches.mjs`) sont lues ici aussi, sous le sujet
 * `conversation:<id>`. Elles ne sont pas « centrales » : un profil `code` ne
 * voit que celles de son projet, l'Assistant toutes. Leur index
 * (`conversations/index.jsonl`) sert au rappel (`chercherConversations`).
 */

import fs from "fs";
import path from "path";
import { CHEMINS } from "./chemins.mjs";
import { loadRegistry } from "./registry.mjs";
import { racineProjetsAtelier, slugifier } from "./projet-fichiers.mjs";

export const PREFIXE_CONVERSATION = "conversation:";

/** Dossier central (calculé à l'appel : les tests changent de HOME par processus). */
export function dossierCentral() { return CHEMINS.connaissance; }

function reel(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

/**
 * Liste des fiches.
 * @param {{ portee?: "central"|"projects"|"conversations"|"all", projet?: string|null }} o
 *   `projet` (slug) : seule la connaissance de ce projet est lue côté projets
 *   (profil code) — le projet du registre qui porte ce slug, et le dossier
 *   `<racine des projets de l'Atelier>/<slug>`.
 * @returns {{ sujet: string, source: string, chemin: string, nom: string }[]}
 */
export function listerFiches({ portee = "all", projet = null } = {}) {
  const fiches = [];
  const vus = new Set(); // un projet enregistré sur ~ recouvrirait le dossier central
  const ajouter = (source, dossier, prefixe) => {
    let entrees;
    try { entrees = fs.readdirSync(dossier, { withFileTypes: true }); } catch { return; }
    for (const e of entrees) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
      const chemin = path.join(dossier, e.name);
      const cle = reel(chemin).toLowerCase();
      if (vus.has(cle)) continue;
      vus.add(cle);
      const nom = e.name.slice(0, -3);
      fiches.push({ sujet: prefixe ? `${prefixe}/${nom}` : nom, source, chemin, nom });
    }
  };
  if (portee === "central" || portee === "all") ajouter("central", dossierCentral(), "");
  if (portee === "projects" || portee === "all") {
    let projets = [];
    try { projets = loadRegistry().projects || []; } catch { /* registre absent */ }
    const borne = projet ? slugifier(projet) : null;
    for (const p of projets) {
      if (!p?.path || p.status === "missing") continue;
      const slug = p.slug || p.name;
      if (borne && slugifier(slug) !== borne && slugifier(p.name) !== borne) continue;
      ajouter(slug, path.join(p.path, ".wikichat", "knowledge"), slug);
    }
    if (borne) ajouter(borne, path.join(racineProjetsAtelier(), borne, ".wikichat", "knowledge"), borne);
  }
  if (portee === "all" || portee === "conversations") {
    for (const f of listerFichesConversations({ projet })) fiches.push(f);
  }
  return fiches;
}

// ── Fiches de conversation (W8) ──────────────────────────────────────────────

/** `knowledge/conversations/` : un dossier par projet, une fiche par conversation. */
export function dossierConversations() { return CHEMINS.conversations; }

const _ID_FICHE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

/** Le nom du dossier d'un projet dans les fiches de conversation (`_` pour aucun projet). */
export function nomDuDossierProjet(projet) {
  return slugifier(projet) || "_";
}

/**
 * Les fiches de conversation, bornées à un projet quand `projet` est donné
 * (profil code) ; toutes sinon (l'Assistant).
 */
export function listerFichesConversations({ projet = null } = {}) {
  const racine = dossierConversations();
  let dossiers;
  try { dossiers = fs.readdirSync(racine, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
  if (projet) dossiers = dossiers.filter(d => d === nomDuDossierProjet(projet));
  const sortie = [];
  for (const d of dossiers) {
    let noms;
    try { noms = fs.readdirSync(path.join(racine, d)); } catch { continue; }
    for (const n of noms) {
      if (!n.endsWith(".md")) continue;
      const id = n.slice(0, -3);
      sortie.push({ sujet: `${PREFIXE_CONVERSATION}${id}`, source: `${PREFIXE_CONVERSATION}${d}`, chemin: path.join(racine, d, n), nom: id, projet: d });
    }
  }
  return sortie;
}

/**
 * Une fiche de conversation par son identifiant, ou un préfixe unique d'au
 * moins 8 caractères (l'identifiant court que rend le rappel). `projet` borne
 * la recherche : une fiche d'un autre projet est introuvable.
 */
export function lireFicheConversation(id, { projet = null } = {}) {
  const brut = String(id || "").trim().replace(/^conversation:/, "");
  if (!_ID_FICHE.test(brut) || brut.includes("..")) return null;
  const candidates = listerFichesConversations({ projet }).filter(f => f.nom === brut || (brut.length >= 8 && f.nom.startsWith(brut)));
  const exacte = candidates.find(f => f.nom === brut);
  const f = exacte || (candidates.length === 1 ? candidates[0] : null);
  if (!f) return null;
  try {
    const texte = fs.readFileSync(f.chemin, "utf8");
    const st = fs.statSync(f.chemin);
    return { ...f, id: f.nom, titre: titreDe(texte, f.nom), texte, modifie: new Date(st.mtimeMs).toISOString(), taille: st.size };
  } catch { return null; }
}

/** Les lignes de l'index des fiches (`conversations/index.jsonl`). */
export function lireIndexConversations() {
  let brut;
  try { brut = fs.readFileSync(path.join(dossierConversations(), "index.jsonl"), "utf8"); } catch { return []; }
  const sortie = [];
  for (const l of brut.split("\n")) {
    if (!l.trim()) continue;
    try { const o = JSON.parse(l); if (o && o.id) sortie.push(o); } catch { /* ligne abîmée : ignorée */ }
  }
  return sortie;
}

/** Minuscules, sans accents : « décision » et « decision » se retrouvent. */
export function plier(s) {
  return String(s || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

const MOTS_VIDES = new Set(["les", "des", "une", "dans", "pour", "par", "sur", "avec", "est", "que", "qui", "pas", "plus", "mon", "mes", "notre", "nos", "the", "and", "for", "dont", "cette", "ces", "aux"]);

/** Les termes d'une requête : pliés, sans mots vides ni mots de deux lettres. */
export function termesDe(requete) {
  return [...new Set(plier(requete).split(/[^a-z0-9]+/).filter(t => t.length > 2 && !MOTS_VIDES.has(t)))];
}

/**
 * Rappel : recherche dans l'index des fiches, avec la pondération de
 * `chercher` (titre ×3, sujets et objets ×2, résumé, décisions et citations
 * ×1, occurrences plafonnées), sans accents. Les plus récentes départagent.
 */
export function chercherConversations(requete, { projet = null, depuis = null, limite = 5 } = {}) {
  const termes = termesDe(requete);
  let index = lireIndexConversations();
  if (projet) index = index.filter(e => e.projet === nomDuDossierProjet(projet));
  if (depuis) index = index.filter(e => String(e.fin || e.debut || "") >= String(depuis));
  if (!termes.length) return { total: 0, fiches: index.length, resultats: [] };
  const compter = (texte, t) => Math.min(texte.split(t).length - 1, 10);
  const resultats = [];
  for (const e of index) {
    const titre = plier(e.titre);
    const etiquettes = plier([...(e.sujets || []), ...(e.objets || []), e.projet].join(" "));
    const corps = plier([e.resume, ...(e.decisions || []), ...(e.citations || [])].join(" "));
    let score = 0;
    for (const t of termes) score += 3 * Math.min(compter(titre, t), 3) + 2 * Math.min(compter(etiquettes, t), 5) + compter(corps, t);
    if (score) resultats.push({ ...e, score });
  }
  resultats.sort((a, b) => b.score - a.score || String(b.fin || "").localeCompare(String(a.fin || "")));
  return {
    total: resultats.length,
    fiches: index.length,
    resultats: resultats.slice(0, limite).map(e => ({
      id: e.id, projet: e.projet, genre: e.genre, debut: e.debut, fin: e.fin,
      titre: e.titre, resume: e.resume || "", objets: (e.objets || []).slice(0, 5), statut: e.statut, score: e.score,
    })),
  };
}

/** Titre d'une fiche : premier `# `, sinon son nom. */
export function titreDe(texte, nom) {
  const m = String(texte || "").match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : nom;
}

/**
 * Lit une fiche par son sujet (`grist-axis`, `grist` pour `grist-axis`,
 * `<slug>/<nom>`). Refuse tout chemin qui sortirait des dossiers de
 * connaissance.
 * @returns {{ sujet, source, chemin, titre, texte, modifie }|null}
 */
export function lireFiche(sujet, { projet = null } = {}) {
  const s = String(sujet || "").trim().replace(/\.md$/i, "");
  if (s.startsWith(PREFIXE_CONVERSATION)) return lireFicheConversation(s.slice(PREFIXE_CONVERSATION.length), { projet });
  if (!s || s.includes("..") || s.includes("\\")) return null;
  if (projet && s.includes("/") && slugifier(s.split("/")[0]) !== slugifier(projet)) return null;
  const fiches = listerFiches({ portee: s.includes("/") ? "projects" : "central", projet });
  const f = fiches.find(x => x.sujet === s) || fiches.find(x => x.sujet === `${s}-axis`)
    || fiches.find(x => x.sujet.toLowerCase() === s.toLowerCase());
  if (!f) return null;
  try {
    const texte = fs.readFileSync(f.chemin, "utf8");
    const st = fs.statSync(f.chemin);
    return { ...f, titre: titreDe(texte, f.nom), texte, modifie: new Date(st.mtimeMs).toISOString(), taille: st.size };
  } catch { return null; }
}

/**
 * Index des fiches (sans le texte) : sujet, source, titre, résumé, date.
 */
export function indexFiches({ portee = "all" } = {}) {
  return listerFiches({ portee }).map(f => {
    let texte = "";
    let st = null;
    try { texte = fs.readFileSync(f.chemin, "utf8"); st = fs.statSync(f.chemin); } catch { /* */ }
    const corps = texte.replace(/^---[\s\S]*?\n---\n/, "").split("\n").filter(l => l.trim() && !/^#/.test(l)).slice(0, 3).join(" ");
    return {
      sujet: f.sujet, source: f.source, titre: titreDe(texte, f.nom),
      resume: corps.replace(/\s+/g, " ").slice(0, 200),
      modifie: st ? new Date(st.mtimeMs).toISOString() : null,
      taille: st ? st.size : 0,
    };
  });
}

/**
 * Recherche plein texte. Score : terme dans le titre ×3, dans un intertitre ×2,
 * occurrences dans le corps ×1 (10 au plus par terme).
 * @returns {{ total: number, fichiers: number, resultats: object[] }}
 */
export function chercher(requete, { portee = "all", limite = 5, projet = null } = {}) {
  const termes = String(requete || "").toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const fiches = listerFiches({ portee, projet });
  if (!termes.length) return { total: 0, fichiers: fiches.length, resultats: [] };
  const resultats = [];
  for (const f of fiches) {
    let texte;
    try { texte = fs.readFileSync(f.chemin, "utf8"); } catch { continue; }
    const bas = texte.toLowerCase();
    const titre = titreDe(texte, f.nom);
    const intertitres = [...texte.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].toLowerCase());
    let score = 0;
    for (const t of termes) {
      if (titre.toLowerCase().includes(t)) score += 3;
      for (const h of intertitres) if (h.includes(t)) score += 2;
      score += Math.min(bas.split(t).length - 1, 10);
    }
    if (!score) continue;
    let debut = -1;
    for (const t of termes) {
      const i = bas.indexOf(t);
      if (i >= 0 && (debut < 0 || i < debut)) debut = i;
    }
    const de = Math.max(0, debut - 80);
    resultats.push({
      sujet: f.sujet, source: f.source, chemin: f.chemin, titre, score,
      extrait: texte.slice(de, de + 280).replace(/\s+/g, " ").trim(),
    });
  }
  resultats.sort((a, b) => b.score - a.score);
  return { total: resultats.length, fichiers: fiches.length, resultats: resultats.slice(0, limite) };
}
