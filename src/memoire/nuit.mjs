/**
 * memoire/nuit.mjs — Étape 2 de la capitalisation (W8) : le sens, par une routine plafonnée.
 *
 * Décision A-7, révisée par Nicolas le 26/09 : 20 conversations par nuit au
 * plus, sur `qwen3-8-27b`. Chaque conversation est résumée par **un appel
 * direct de l'Atelier** (`POST /v1/memoire/resumer`, clé du lanceur), qui
 * prend son **identifiant**, jamais un texte : l'Atelier lit lui-même le
 * transcript, le filtre (T10), prépare l'entrée (paroles de la personne et
 * réponse finale de chaque tour, jamais un résultat d'outil), la borne à
 * 58 000 caractères consigne comprise, et appelle le modèle par son relais,
 * sortie plafonnée à 1 200 jetons. Plus de lancement d'agent (lot D) : ni
 * harnais (≈ 21 700 jetons par conversation), ni conversation ouverte dans le
 * projet `default`. Le modèle rend un objet JSON ; c'est le code qui range
 * (étape 3).
 *
 * Plafonds tenus ici, par le code :
 *   - nombre : `conversations` fiches au plus par passage (`limite` peut
 *     réduire, jamais augmenter) ;
 *   - une nuit : un passage par jour (témoin `nuits.jsonl`), sauf `force` ;
 *     un essai (`essai`) ne compte pas pour la nuit du jour ;
 *   - un échec deux fois de suite : la fiche n'est plus retentée seule.
 * L'Atelier ajoute les siens (20 résumés par jour tous appelants, un à la
 * fois, entrée et sortie bornées) ; un refus de sa part (clé, plafond, un à
 * la fois) ou un modèle indisponible arrête la nuit, sans contournement.
 *
 * Les candidats à la mémoire (préférences, profil, interprétations) partent
 * dans « À valider » (source `memoire`) : rien n'est retenu sans la personne.
 */

import fs from "fs";
import path from "path";
import { CHEMINS } from "../chemins.mjs";
import { lireIndexConversations } from "../connaissance.mjs";
import { clientAtelier } from "./atelier.mjs";
import { dateCourte, masquerJetons } from "./extraction.mjs";
import { noterTentative, rangerSens } from "./fiches.mjs";
import { indexerVecteurs } from "./vecteurs.mjs";
import { triggerMemoryPublish } from "../memory-publish-hook.mjs";

export const PLAFONDS_NUIT = Object.freeze({
  conversations: 20,
  jetons_sortie: 1200,
  echanges_min: 3,
  tentatives_max: 2,
});
// Tenu par l'Atelier (`memoire_modele.ENTREE_MAX_CAR`), noté dans le bilan.
export const ENTREE_MAX_CAR = 58_000;
export const ORIGINE = "memoire:nuit";

/** Le modèle est choisi par l'Atelier (`ATELIER_MEMOIRE_MODELE`) ; celui-ci est le défaut attendu. */
export function modeleDeNuit() { return "qwen3-8-27b"; }

export function cheminDesNuits() { return path.join(CHEMINS.memoire, "nuits.jsonl"); }

export function lireNuits() {
  try {
    return fs.readFileSync(cheminDesNuits(), "utf8").split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function noterNuit(ligne) {
  fs.mkdirSync(CHEMINS.memoire, { recursive: true });
  fs.appendFileSync(cheminDesNuits(), JSON.stringify(ligne) + "\n", "utf8");
}

/**
 * Les fiches à sens : sans sens (ou sens antérieur), assez longues, pas en
 * échec répété ; les plus récentes d'abord. `ids` (essai à la main) : ces
 * fiches-là, quel que soit leur statut, dans le même plafond.
 */
export function candidatsDeNuit(index = lireIndexConversations(), plafonds = PLAFONDS_NUIT, { ids = null, limite = null } = {}) {
  const n = Math.max(0, Math.min(plafonds.conversations, limite ?? plafonds.conversations));
  if (ids) {
    const voulus = new Set(ids.map(String));
    return index.filter(e => voulus.has(e.id) || voulus.has(e.cli_id)).slice(0, n);
  }
  return index
    .filter(e => (e.statut === "faits" || e.statut === "sens_anterieur")
      && (e.messages || 0) >= plafonds.echanges_min
      && (e.tentatives_nuit || 0) < plafonds.tentatives_max)
    .sort((a, b) => String(b.fin || "").localeCompare(String(a.fin || "")))
    .slice(0, n);
}

const liste = (v, n, max) => (Array.isArray(v) ? v : (typeof v === "string" ? v.split(/\n+/) : []))
  .map(x => masquerJetons(String(x ?? "").replace(/^\s*[-*•]\s*/, "").replace(/\s+/g, " ").trim()))
  .filter(Boolean).slice(0, n).map(x => (x.length > max ? x.slice(0, max - 1) + "…" : x));

/** Le sens, lu dans la réponse du modèle ; null si elle n'est pas lisible. */
export function lireSortie(texte) {
  const s = String(texte || "");
  const debut = s.indexOf("{");
  const fin = s.lastIndexOf("}");
  if (debut < 0 || fin <= debut) return null;
  let o;
  try { o = JSON.parse(s.slice(debut, fin + 1)); } catch { return null; }
  if (!o || typeof o !== "object") return null;
  const resume = liste(o.resume, 5, 200);
  if (!resume.length) return null;
  const candidats = (Array.isArray(o.candidats) ? o.candidats : [])
    .filter(c => c && ["preference", "profil", "interpretation"].includes(String(c.type)))
    .map(c => ({ type: String(c.type), texte: liste([c.texte], 1, 300)[0] }))
    .filter(c => c.texte && c.texte.length >= 3)
    .slice(0, 3);
  return {
    resume,
    resume_court: resume[0].length > 160 ? resume[0].slice(0, 159) + "…" : resume[0],
    sujets: liste(o.sujets, 6, 40),
    decisions: liste(o.decisions, 5, 200),
    questions: liste(o.questions, 5, 200),
    candidats,
  };
}

// Les réponses de l'Atelier qui arrêtent la nuit : la clé, un à la fois, le plafond.
const REFUS = new Set([401, 403, 409, 429]);

/**
 * Un passage de nuit. Rend le bilan, aussi noté dans `memoire/nuits.jsonl`.
 *
 * @param {object} o
 * @param {object} [o.atelier]  client de l'Atelier (`clientAtelier()`) ; remplacé par un faux en test
 * @param {boolean} [o.force]   passer outre « une fois par jour »
 * @param {boolean} [o.essai]   essai à la main : ne compte pas pour la nuit du jour
 * @param {number} [o.limite]   moins de conversations que le plafond (essai)
 * @param {string[]} [o.ids]    ces conversations-là (essai)
 */
export async function capitaliserNuit({
  atelier = clientAtelier(),
  force = false,
  essai = false,
  limite = null,
  ids = null,
  plafonds = PLAFONDS_NUIT,
  maintenant = () => new Date(),
} = {}) {
  const debut = maintenant().toISOString();
  const jour = debut.slice(0, 10);
  // Une nuit arrêtée avant tout résumé (Atelier absent) peut se rejouer le même jour.
  if (!force && !essai && lireNuits().some(n => !n.essai && String(n.debut || "").slice(0, 10) === jour && (n.traitees > 0 || !n.arret))) {
    return { deja: true, jour };
  }
  const candidats = candidatsDeNuit(lireIndexConversations(), plafonds, { ids, limite });
  const bilan = {
    debut, jour, modele: modeleDeNuit(), voie: "atelier:resumer",
    ...(essai ? { essai: true } : {}),
    plafonds: {
      conversations: plafonds.conversations, jetons_sortie: plafonds.jetons_sortie, entree_max_car: ENTREE_MAX_CAR,
      ...(limite != null ? { limite } : {}),
    },
    candidats: candidats.length, traitees: 0, reussies: 0, echecs: 0, propositions: 0,
    jetons_entree: 0, jetons_sortie: 0, jetons_estimes: false, sorties_coupees: 0,
    plus_grande_entree: 0, secondes: 0, arret: null,
  };
  const resumees = [];
  for (const c of candidats) {
    if (bilan.traitees >= plafonds.conversations) break;
    const r = await atelier.resumer(c.id);
    if (r.absent) { bilan.arret = `Atelier absent : ${r.raison}`; break; }
    const corps = r.json || {};
    if (REFUS.has(r.statut)) {
      bilan.arret = `refus de l'Atelier (HTTP ${r.statut}) : ${corps.erreur || corps.detail || "?"}`;
      break;
    }
    if (r.statut === 502) {
      bilan.traitees++;
      bilan.echecs++;
      bilan.arret = `modèle indisponible : ${corps.erreur || "?"}`;
      break;
    }
    if (r.statut !== 200 || corps.statut !== "fait") {
      // Conversation inconnue de l'Atelier, rien à résumer : notée, la nuit continue.
      noterTentative(c.id, `résumé HTTP ${r.statut} ${corps.erreur || corps.detail || ""}`.trim());
      bilan.echecs++;
      continue;
    }
    bilan.traitees++;
    const j = corps.jetons || {};
    bilan.jetons_entree += j.entree || 0;
    bilan.jetons_sortie += j.sortie || 0;
    if (j.estimes) bilan.jetons_estimes = true;
    bilan.plus_grande_entree = Math.max(bilan.plus_grande_entree, j.entree || 0);
    bilan.secondes += corps.secondes || 0;
    if (corps.arret === "max_tokens") bilan.sorties_coupees++;
    const sens = lireSortie(corps.texte);
    if (!sens) { noterTentative(c.id, "réponse illisible"); bilan.echecs++; continue; }
    sens.source = c.empreinte_source;
    sens.le = maintenant().toISOString();
    sens.modele = corps.modele || modeleDeNuit();
    sens.jetons = { entree: j.entree || 0, sortie: j.sortie || 0 };
    const { candidats: proposes, ...rangement } = sens;
    rangerSens(c.id, { ...rangement, candidats_proposes: proposes.length });
    resumees.push(c.id);
    bilan.reussies++;
    for (const p of proposes) {
      const d = await atelier.proposer({
        type: p.type, texte: p.texte, conversation: c.id, projet: c.projet, fiche: c.id,
        raison: `Tiré de la conversation du ${dateCourte(c.fin)} (projet ${c.projet}) par la routine de nuit.`,
      });
      if (d.statut === 200) bilan.propositions++;
    }
  }
  // Le texte des fiches a changé : leurs vecteurs aussi (sans effet si le point d'accès manque).
  if (resumees.length) {
    const v = await indexerVecteurs({ atelier, ids: resumees });
    bilan.vecteurs = { calcules: v.calcules, erreur: v.erreur };
  }
  bilan.secondes = Math.round(bilan.secondes * 10) / 10;
  bilan.fin = maintenant().toISOString();
  noterNuit(bilan);
  // S6 : la publication assainie (brique existante, sans effet sans
  // WIKICHAT_MEMORY_REPO) repart après une nuit qui a enrichi des fiches.
  if (bilan.reussies > 0) bilan.publication = triggerMemoryPublish("memoire:nuit");
  return bilan;
}
