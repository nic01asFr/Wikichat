/**
 * memoire/capitalisation.mjs — Le passage des faits (W8, étapes 1 et 3), sans modèle.
 *
 * Toutes les 15 minutes (trigger `memoire-faits`, action `job`), et à la fin
 * d'une conversation (hook `SessionEnd`) :
 *   1. demander à l'Atelier ses conversations (`GET /v1/memoire/conversations`) ;
 *   2. pour chacune au repos (30 min sans écriture, ou close) dont l'empreinte a
 *      changé depuis la dernière fiche : lire son transcript filtré, en
 *      extraire les faits (`extraction.mjs`), ranger la fiche (`fiches.mjs`) ;
 *   3. enregistrer d'office les faits datés dans la mémoire de la personne
 *      (A-7 : projet créé, création, agent lancé, décision) ;
 *   4. (re)calculer les vecteurs des fiches écrites, et rattraper ceux qui
 *      manquent (`vecteurs.mjs`, par l'Atelier). Sans point d'accès, rien ne
 *      casse : la recherche reste lexicale.
 *
 * Borné : `limite` conversations par passage (30), le reste au suivant.
 */

import { clientAtelier } from "./atelier.mjs";
import { extraireFaits, faitsDOffice } from "./extraction.mjs";
import { entreeDeLIndex, rangerFaits } from "./fiches.mjs";
import { enregistrerFaitsDOffice } from "./personne.mjs";
import { indexerVecteurs } from "./vecteurs.mjs";

export const LIMITE_PAR_PASSAGE = 30;
export const REPOS_MIN = 30;

/**
 * Un passage. `ids` : seulement ces conversations (id de l'Atelier ou du CLI),
 * au repos ou non (fin signalée par le hook).
 */
export async function capitaliserFaits({ atelier = clientAtelier(), limite = LIMITE_PAR_PASSAGE, ids = null, reposMin = REPOS_MIN } = {}) {
  const liste = await atelier.lister({ reposMin });
  if (liste.absent) return { atelier: "absent", raison: liste.raison };
  if (liste.statut !== 200 || !Array.isArray(liste.json?.conversations)) return { atelier: "erreur", statut: liste.statut };
  const voulues = ids ? new Set(ids) : null;
  const bilan = { conversations: liste.json.conversations.length, fichees: 0, inchangees: 0, en_cours: 0, erreurs: 0, faits_d_office: 0, reste: 0 };
  for (const c of liste.json.conversations) {
    if (voulues && !voulues.has(c.id) && !voulues.has(c.cli_id)) continue;
    if (!voulues && !c.au_repos) { bilan.en_cours++; continue; }
    const avant = entreeDeLIndex(c.id);
    if (avant && avant.empreinte_source === c.empreinte) { bilan.inchangees++; continue; }
    if (bilan.fichees + bilan.erreurs >= limite) { bilan.reste++; continue; }
    const t = await atelier.transcript(c.id);
    if (t.absent) return { ...bilan, atelier: "absent", raison: t.raison };
    if (t.statut !== 200 || !t.json) { bilan.erreurs++; continue; }
    try {
      const f = extraireFaits(t.json);
      if (!f.id) f.id = c.id;
      rangerFaits(f);
      bilan.faits_d_office += enregistrerFaitsDOffice(faitsDOffice(f));
      bilan.fichees++;
    } catch (err) {
      console.warn(`[memoire] fiche de ${String(c.id).slice(0, 8)} non écrite : ${err.message}`);
      bilan.erreurs++;
    }
  }
  // Les vecteurs suivent les fiches : celles écrites à l'instant, puis le rattrapage.
  const v = await indexerVecteurs({ atelier });
  bilan.vecteurs = { calcules: v.calcules, a_jour: v.a_jour, erreur: v.erreur };
  return bilan;
}

// ── Fin de conversation (hook SessionEnd) ────────────────────────────────────

const _enAttente = new Set();
let _minuterie = null;

/**
 * Une conversation vient de se terminer : sa fiche est écrite sans attendre
 * les 30 minutes de repos. Regroupé (15 s) pour ne faire qu'un passage quand
 * plusieurs finissent ensemble. Sans clé du lanceur, rien ne part.
 */
export function signalerFinDeConversation(sessionId, { delaiMs = 15_000, capitaliser = capitaliserFaits } = {}) {
  if (!sessionId || process.env.WIKICHAT_MEMOIRE === "0") return false;
  _enAttente.add(String(sessionId));
  if (_minuterie) return true;
  _minuterie = setTimeout(async () => {
    const ids = [..._enAttente];
    _enAttente.clear();
    _minuterie = null;
    try { await capitaliser({ ids, reposMin: 0 }); }
    catch (err) { console.warn(`[memoire] passage de fin de conversation : ${err.message}`); }
  }, delaiMs);
  _minuterie.unref?.();
  return true;
}
