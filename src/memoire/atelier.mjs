/**
 * memoire/atelier.mjs — Ce que la capitalisation demande à l'Atelier.
 *
 * Contrat (Atelier, `mcp_gateway/atelier/memoire.py` et `memoire_modele.py`),
 * clé du lanceur (`~/work/.secrets/atelier_lanceur_key`, en-tête `X-Atelier-Lanceur`) :
 *   GET  /v1/memoire/conversations?repos_min=30
 *        → { conversations: [{ id, cli_id, projet, genre, titre, etat, cree_le,
 *            modifie_le, tours, lance_par, au_repos, close, empreinte }] }
 *   GET  /v1/memoire/conversations/<id>      (id de l'Atelier ou du CLI)
 *        → { conversation, evenements, nombre, tronque }   transcript filtré (T10)
 *   POST /v1/memoire/propositions  { type, texte, conversation, projet, raison, fiche }
 *        → { statut: "fait", proposition }  (« À valider », source memoire)
 *   POST /v1/memoire/resumer  { conversation, origine? }          (décision du 26/09)
 *        → 200 { statut: "fait", texte, modele, jetons: { entree, sortie, estimes },
 *                entree_car, echanges, omis, arret, secondes }
 *        → 401 clé ; 404 inconnue ; 422 rien à résumer ; 409 un à la fois ;
 *          429 plafond du jour (20) ; 502 modèle indisponible
 *   POST /v1/memoire/vecteurs  { textes: [≤ 16], usage: "fiche"|"requete" }
 *        → 200 { statut: "fait", modele, dimension, vecteurs, jetons } ; 429 ; 502
 *
 * L'Atelier lit lui-même la conversation, la filtre, la borne (58 000
 * caractères) et appelle le modèle par son relais : wikichat n'envoie jamais
 * de texte libre à résumer, et ne lit jamais la clé du modèle.
 *
 * Sans clé (un poste sans Atelier) : `{ absent: true }`, sans appel.
 */

import { configAtelier, lireCleAtelier } from "../lanceur-atelier.mjs";

// Un résumé sur `qwen3-8-27b` peut prendre plusieurs minutes (l'Atelier
// coupe à 300 s) ; une requête de recherche, elle, ne doit pas faire attendre.
export const DELAI_RESUME_MS = 330_000;
export const DELAI_VECTEURS_FICHES_MS = 60_000;
export const DELAI_VECTEUR_REQUETE_MS = 4_000;
export const ORIGINE_NUIT = "wikichat:memoire:nuit";

export function clientAtelier({ cfg = configAtelier(), fetchImpl = globalThis.fetch } = {}) {
  async function appeler(methode, chemin, corps, delaiMs = Math.max(cfg.delaiMs, 30_000)) {
    const cle = lireCleAtelier(cfg);
    if (!cle) return { absent: true, raison: "clé du lanceur introuvable" };
    let r;
    try {
      r = await fetchImpl(`${cfg.url}${chemin}`, {
        method: methode,
        headers: { "Content-Type": "application/json", "X-Atelier-Lanceur": cle },
        body: corps === undefined ? undefined : JSON.stringify(corps),
        signal: AbortSignal.timeout(delaiMs),
      });
    } catch (err) {
      return { absent: true, raison: `Atelier injoignable : ${err.message}` };
    }
    let json = null;
    try { json = await r.json(); } catch { json = null; }
    return { statut: r.status, json };
  }
  return {
    lister: ({ reposMin = 30 } = {}) => appeler("GET", `/v1/memoire/conversations?repos_min=${encodeURIComponent(reposMin)}`),
    transcript: (id) => appeler("GET", `/v1/memoire/conversations/${encodeURIComponent(id)}`),
    proposer: (p) => appeler("POST", "/v1/memoire/propositions", p),
    resumer: (id, { origine = ORIGINE_NUIT } = {}) =>
      appeler("POST", "/v1/memoire/resumer", { conversation: String(id), origine }, DELAI_RESUME_MS),
    vecteurs: (textes, usage = "fiche") =>
      appeler("POST", "/v1/memoire/vecteurs", { textes, usage },
        usage === "requete" ? DELAI_VECTEUR_REQUETE_MS : DELAI_VECTEURS_FICHES_MS),
  };
}
