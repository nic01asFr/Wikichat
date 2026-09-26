/**
 * memoire/atelier.mjs — Ce que la capitalisation demande à l'Atelier.
 *
 * Contrat (Atelier, `mcp_gateway/atelier/memoire.py`), clé du lanceur
 * (`~/work/.secrets/atelier_lanceur_key`, en-tête `X-Atelier-Lanceur`) :
 *   GET  /v1/memoire/conversations?repos_min=30
 *        → { conversations: [{ id, cli_id, projet, genre, titre, etat, cree_le,
 *            modifie_le, tours, lance_par, au_repos, close, empreinte }] }
 *   GET  /v1/memoire/conversations/<id>      (id de l'Atelier ou du CLI)
 *        → { conversation, evenements, nombre, tronque }   transcript filtré (T10)
 *   POST /v1/memoire/propositions  { type, texte, conversation, projet, raison, fiche }
 *        → { statut: "fait", proposition }  (« À valider », source memoire)
 *
 * Sans clé (un poste sans Atelier) : `{ absent: true }`, sans appel.
 */

import { configAtelier, lireCleAtelier } from "../lanceur-atelier.mjs";

export function clientAtelier({ cfg = configAtelier(), fetchImpl = globalThis.fetch } = {}) {
  async function appeler(methode, chemin, corps) {
    const cle = lireCleAtelier(cfg);
    if (!cle) return { absent: true, raison: "clé du lanceur introuvable" };
    let r;
    try {
      r = await fetchImpl(`${cfg.url}${chemin}`, {
        method: methode,
        headers: { "Content-Type": "application/json", "X-Atelier-Lanceur": cle },
        body: corps === undefined ? undefined : JSON.stringify(corps),
        signal: AbortSignal.timeout(Math.max(cfg.delaiMs, 30_000)),
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
  };
}
