/**
 * memoire/routes.mjs — Les routes HTTP de la mémoire (W8, A-7).
 *
 * Lues par l'Atelier (`mcp_gateway/atelier/memoire.py`, `commandes/rappel.py`) :
 *   GET    /api/memoire/etat                      fiches, faits, dernières nuits
 *   GET    /api/memoire/rappel?q&projet&depuis&limite   { total, fiches, resultats, sens }
 *          (lexical et sens fusionnés ; lexical seul si le sens est indisponible)
 *   GET    /api/memoire/fiches?projet&limite      l'index (sans le détail)
 *   GET    /api/memoire/fiches/:id?projet         { id, projet, genre, titre, texte }
 *   GET    /api/memoire/personne                  { elements, plafonds, fiches }
 *   GET    /api/memoire/personne.md?partie=profil|preference|interpretation|fait
 * Écritures, avec la clé du lanceur (`X-Atelier-Lanceur`) ; l'Atelier ne les
 * appelle que par ses commandes réservées à la personne :
 *   POST   /api/memoire/personne         { type, texte, source?, par? }
 *   PATCH  /api/memoire/personne/:id     { texte, par? }
 *   DELETE /api/memoire/personne/:id
 *   POST   /api/memoire/capitaliser      { ids? }   un passage des faits, tout de suite
 *   POST   /api/memoire/vecteurs         { ids? }   (re)calcul des vecteurs des fiches
 *   POST   /api/memoire/nuit?limite=N    { ids? }   essai de la nuit à la main (N ≤ 20),
 *          qui ne compte pas pour la nuit du jour ; l'Atelier tient ses plafonds
 *
 * Le service n'écoute que la boucle locale (garde `Host`). La clé ne protège
 * pas d'un agent du pod qui la lirait sur le disque : elle ferme la porte à
 * un appel écrit au hasard, et dit qui a le droit d'écrire.
 */

import crypto from "crypto";
import { chercherConversations, lireFicheConversation, lireIndexConversations } from "../connaissance.mjs";
import { lireCleAtelier } from "../lanceur-atelier.mjs";
import { capitaliserFaits } from "./capitalisation.mjs";
import { indexPublic } from "./fiches.mjs";
import { capitaliserNuit, lireNuits } from "./nuit.mjs";
import { indexerVecteurs, rappelFusionne } from "./vecteurs.mjs";
import { PLAFONDS, RefusMemoire, corriger, lirePersonne, oublier, rendrePartie, retenir } from "./personne.mjs";

function cleValide(req) {
  const attendue = lireCleAtelier();
  const donnee = String(req.headers["x-atelier-lanceur"] || "");
  if (!attendue || !donnee) return false;
  const a = Buffer.from(attendue), b = Buffer.from(donnee.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function exigerCle(req, res) {
  if (cleValide(req)) return true;
  res.status(401).json({ erreur: "clé du lanceur requise (X-Atelier-Lanceur) : seule l'Atelier écrit la mémoire" });
  return false;
}

function repondreRefus(res, err) {
  if (err instanceof RefusMemoire) return res.status(err.statut).json({ erreur: err.message });
  return res.status(500).json({ erreur: err.message });
}

const entier = (v, defaut, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : defaut;
};

export function enregistrerRoutesMemoire(app) {
  app.get("/api/memoire/etat", (_req, res) => {
    const index = lireIndexConversations();
    const d = lirePersonne();
    const parStatut = {};
    for (const e of index) parStatut[e.statut] = (parStatut[e.statut] || 0) + 1;
    res.json({
      fiches: index.length,
      par_statut: parStatut,
      elements: d.elements.length,
      faits: d.elements.filter(e => e.type === "fait").length,
      nuits: lireNuits().slice(-7),
    });
  });

  app.get("/api/memoire/rappel", async (req, res) => {
    const q = String(req.query.q || "").slice(0, 300);
    const r = await rappelFusionne(q, {
      projet: req.query.projet ? String(req.query.projet) : null,
      depuis: req.query.depuis ? String(req.query.depuis) : null,
      limite: entier(req.query.limite, 5, 1, 10),
      lexical: chercherConversations,
    });
    res.json({ requete: q, ...r });
  });

  app.get("/api/memoire/fiches", (req, res) => {
    const projet = req.query.projet ? String(req.query.projet) : null;
    const fiches = indexPublic({ projet, limite: entier(req.query.limite, 50, 1, 500) });
    res.json({ total: fiches.length, fiches });
  });

  app.get("/api/memoire/fiches/:id", (req, res) => {
    const projet = req.query.projet ? String(req.query.projet) : null;
    const f = lireFicheConversation(req.params.id, { projet });
    if (!f) return res.status(404).json({ erreur: `fiche introuvable : ${String(req.params.id).slice(0, 60)}` });
    const genre = (f.texte.match(/^genre: (\S+)$/m) || [])[1] || "code";
    res.json({ id: f.id, projet: f.projet, genre, titre: f.titre, modifie: f.modifie, texte: f.texte });
  });

  app.get("/api/memoire/personne", (_req, res) => {
    const d = lirePersonne();
    res.json({
      elements: d.elements.map(({ empreinte, ...e }) => e),
      oublies: d.oublies.length,
      plafonds: PLAFONDS,
      fiches: lireIndexConversations().length,
    });
  });

  app.get("/api/memoire/personne.md", (req, res) => {
    try { res.type("text/markdown").send(rendrePartie(String(req.query.partie || "profil"))); }
    catch (err) { repondreRefus(res, err); }
  });

  app.post("/api/memoire/personne", (req, res) => {
    if (!exigerCle(req, res)) return;
    // Un fait n'arrive ici que pour annuler un oubli (« Annuler » de la personne) :
    // les faits d'office passent par la capitalisation, sans route.
    const { type, texte, source, par } = req.body || {};
    try {
      const r = retenir({ type: String(type || ""), texte, source, par: par || "personne" });
      res.status(r.cree ? 201 : 200).json({ element: r.element, cree: r.cree });
    } catch (err) { repondreRefus(res, err); }
  });

  app.patch("/api/memoire/personne/:id", (req, res) => {
    if (!exigerCle(req, res)) return;
    try { res.json(corriger(req.params.id, (req.body || {}).texte, { par: (req.body || {}).par })); }
    catch (err) { repondreRefus(res, err); }
  });

  app.delete("/api/memoire/personne/:id", (req, res) => {
    if (!exigerCle(req, res)) return;
    try { res.json(oublier(req.params.id)); }
    catch (err) { repondreRefus(res, err); }
  });

  app.post("/api/memoire/capitaliser", async (req, res) => {
    if (!exigerCle(req, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 50) : null;
    try { res.json(await capitaliserFaits({ ids, reposMin: ids ? 0 : undefined })); }
    catch (err) { res.status(500).json({ erreur: err.message }); }
  });

  app.post("/api/memoire/vecteurs", async (req, res) => {
    if (!exigerCle(req, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : null;
    try { res.json(await indexerVecteurs({ ids, max: ids ? ids.length : undefined })); }
    catch (err) { res.status(500).json({ erreur: err.message }); }
  });

  // Essai de la nuit à la main : la nuit elle-même, sur N conversations (ou
  // celles choisies), dans les mêmes plafonds. Consomme du modèle : clé.
  app.post("/api/memoire/nuit", async (req, res) => {
    if (!exigerCle(req, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 20) : null;
    const limite = entier(req.query.limite ?? req.body?.limite, 3, 1, 20);
    try { res.json(await capitaliserNuit({ essai: true, limite, ids })); }
    catch (err) { res.status(500).json({ erreur: err.message }); }
  });
}
