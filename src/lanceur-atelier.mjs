/**
 * lanceur-atelier.mjs — Demander le lancement d'un agent à l'Atelier (lot D).
 *
 * Jusqu'ici wikichat lançait `claude -p` lui-même : un réveil sur mention, une
 * routine, un trigger tournaient HORS de l'Atelier — sans fiche, sans le profil
 * du projet, avec un mode à part, et personne ne les voyait. Désormais il
 * DEMANDE le lancement à l'Atelier, qui :
 *   - crée (ou reprend) une conversation : une fiche, donc une identité, visible
 *     dans l'interface ;
 *   - lui applique le profil `code` du projet visé et le mode du projet ;
 *   - tient les plafonds : durée, nombre simultané, nombre par jour et par
 *     origine (J-b).
 *
 * Contrat (Atelier, `mcp_gateway/atelier/lancements.py`) :
 *   POST /v1/lancements          en-tête X-Atelier-Lanceur: <clé>
 *     { origine, projet, dossier?, nom?, titre?, message, mode?,
 *       mode_de_la_definition?, plafonds: { duree_s, jetons? }, modele?,
 *       conversation?, outils? }
 *     → 202 { statut: "fait", lancement: { id, conversation, etat, mode, … } }
 *     → 403 { statut: "refus", erreur }  (plafond, projet inconnu, …)
 *   GET  /v1/lancements/<id>     → { lancement: { etat, texte, erreur, … } }
 *     etat ∈ en_cours | fini | echec | delai | arrete | interrompu
 *   POST /v1/lancements/<id>/arreter
 *
 * La clé est celle du LANCEUR (`~/work/.secrets/atelier_lanceur_key`), posée par
 * l'Atelier à son démarrage : distincte de la clé du propriétaire, elle ne sert
 * qu'à demander un lancement, dans les plafonds.
 *
 * REPLI : si l'Atelier ne répond pas (connexion refusée, délai, 502/503/504),
 * l'appelant retombe sur `claude -p` comme avant (`WIKICHAT_LANCEUR_REPLI=0`
 * l'interdit). Un REFUS de l'Atelier (plafond, projet inconnu) n'est jamais
 * contourné par le repli : ce serait sauter les plafonds.
 */

import fs from "fs";
import path from "path";
import os from "os";

// ── Configuration ────────────────────────────────────────────────────────────

export function configAtelier() {
  const secrets = path.join(os.homedir(), "work", ".secrets");
  return {
    url: String(process.env.WIKICHAT_ATELIER_URL || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    fichierCle: process.env.WIKICHAT_ATELIER_LANCEUR_CLE_FICHIER || path.join(secrets, "atelier_lanceur_key"),
    racineProjets: process.env.WIKICHAT_ATELIER_PROJETS || path.join(os.homedir(), "work", "projects"),
    projetDefaut: process.env.WIKICHAT_ATELIER_PROJET_DEFAUT || "default",
    delaiMs: parseInt(process.env.WIKICHAT_ATELIER_DELAI_MS || "20000", 10),
    pasSuiviMs: parseInt(process.env.WIKICHAT_ATELIER_SUIVI_MS || "2000", 10),
    repli: String(process.env.WIKICHAT_LANCEUR_REPLI ?? "1").trim() !== "0",
  };
}

/**
 * `atelier` ou `claude`. `WIKICHAT_LANCEUR` vaut `auto` par défaut : l'Atelier
 * dès que sa clé de lanceur existe (le pod), `claude` sinon (un poste sans
 * Atelier). `claude` et `atelier` forcent l'un ou l'autre.
 */
export function lanceurActif(cfg = configAtelier()) {
  const v = String(process.env.WIKICHAT_LANCEUR || "auto").trim().toLowerCase();
  if (v === "atelier") return "atelier";
  if (v === "claude") return "claude";
  return lireCleAtelier(cfg) ? "atelier" : "claude";
}

/**
 * Le projet Atelier d'un dossier : `<racine>/<slug>/…` → `slug`. Un dossier
 * hors de la racine des projets retombe sur le projet par défaut — l'Atelier
 * refuse d'ouvrir un fil dans un projet qu'il ne connaît pas.
 */
export function slugProjetAtelier(projectPath, cfg = configAtelier()) {
  if (projectPath) {
    const rel = path.relative(path.resolve(cfg.racineProjets), path.resolve(projectPath));
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      const premier = rel.split(/[\\/]/)[0];
      if (premier) return premier;
    }
  }
  return cfg.projetDefaut;
}

export function lireCleAtelier(cfg = configAtelier()) {
  try {
    const cle = fs.readFileSync(cfg.fichierCle, "utf8").trim();
    return cle || null;
  } catch { return null; }
}

// ── La demande ───────────────────────────────────────────────────────────────

/**
 * Le corps de `POST /v1/lancements` pour un lancement de wikichat.
 *
 * @param {object} p
 *   @param {string}  p.projectPath
 *   @param {string}  p.prompt
 *   @param {string}  [p.name]           nom de l'agent : son identité wikichat
 *   @param {string}  [p.spawnedBy]      qui demande (trigger:…, routine:…, un agent)
 *   @param {string}  [p.mode]           mode déjà résolu par `resoudreModePermission`
 *   @param {boolean} [p.bypassAutorise] vrai si le mode vient d'une DÉFINITION
 *   @param {number}  [p.timeoutMs]      durée maximale du tour
 *   @param {string}  [p.model]
 *   @param {string}  [p.conversation]   conversation Atelier déjà tenue par l'agent
 *   @param {string[]}[p.allowedTools]   liste fixée par l'appelant (Pilote)
 */
export function demandeDeLancement(p, cfg = configAtelier()) {
  const corps = {
    origine: `wikichat:${p.spawnedBy || "wikichat-service"}`,
    projet: slugProjetAtelier(p.projectPath, cfg),
    dossier: p.projectPath || undefined,
    nom: p.name || undefined,
    titre: p.name || undefined,
    message: p.prompt,
    plafonds: { duree_s: Math.max(1, Math.ceil((p.timeoutMs || 5 * 60 * 1000) / 1000)) },
  };
  if (p.mode) corps.mode = p.mode;
  if (p.bypassAutorise === true) corps.mode_de_la_definition = true;
  if (p.model) corps.modele = p.model;
  if (p.conversation) corps.conversation = p.conversation;
  if (p.branche) corps.branche = p.branche;
  if (Array.isArray(p.allowedTools) && p.allowedTools.length) corps.outils = p.allowedTools.map(String);
  return corps;
}

const INJOIGNABLE = new Set([502, 503, 504]);
const ETATS_FINAUX = new Set(["fini", "echec", "delai", "arrete", "interrompu"]);

async function appeler(cfg, cle, fetchImpl, methode, chemin, corps) {
  const r = await fetchImpl(`${cfg.url}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", "X-Atelier-Lanceur": cle },
    body: corps === undefined ? undefined : JSON.stringify(corps),
    signal: AbortSignal.timeout(cfg.delaiMs),
  });
  const texte = await r.text();
  let json = {};
  try { json = texte ? JSON.parse(texte) : {}; } catch { json = { erreur: texte.slice(0, 300) }; }
  return { status: r.status, json };
}

/**
 * Demande un lancement à l'Atelier ; suit le tour jusqu'à sa fin si demandé.
 *
 * @returns {Promise<{ success, stdout, stderr, exitCode, conversationId,
 *   lancementId?, injoignable?, refus?, mode? }>}
 *   `injoignable` : l'Atelier n'a pas répondu — l'appelant peut se replier.
 *   `refus` : l'Atelier a répondu non — jamais de repli.
 */
export async function lancerParAtelier(p) {
  const cfg = p.cfg || configAtelier();
  const fetchImpl = p.fetchImpl || globalThis.fetch;
  const cle = lireCleAtelier(cfg);
  if (!cle) {
    return { success: false, stdout: "", stderr: `clé du lanceur introuvable (${cfg.fichierCle})`, exitCode: -5, conversationId: null, injoignable: true };
  }
  let reponse;
  try {
    reponse = await appeler(cfg, cle, fetchImpl, "POST", "/v1/lancements", demandeDeLancement(p, cfg));
  } catch (err) {
    return { success: false, stdout: "", stderr: `Atelier injoignable : ${err.message}`, exitCode: -1, conversationId: null, injoignable: true };
  }
  if (INJOIGNABLE.has(reponse.status)) {
    return { success: false, stdout: "", stderr: `Atelier injoignable (HTTP ${reponse.status})`, exitCode: -1, conversationId: null, injoignable: true };
  }
  if (reponse.status === 401) {
    return { success: false, stdout: "", stderr: "Atelier : clé du lanceur refusée (401)", exitCode: -5, conversationId: null, refus: true };
  }
  const lancement = reponse.json?.lancement;
  if (reponse.status !== 202 || !lancement?.id) {
    const motif = reponse.json?.erreur || reponse.json?.detail || `HTTP ${reponse.status}`;
    return { success: false, stdout: "", stderr: `Atelier : refusé — ${motif}`, exitCode: -4, conversationId: null, refus: true };
  }
  const base = {
    conversationId: lancement.conversation || null,
    lancementId: lancement.id,
    mode: lancement.mode,
    avertissements: lancement.avertissements || [],
  };
  if (p.attendreFin === false) {
    return { success: true, stdout: "", stderr: "", exitCode: 0, ...base };
  }

  // Le tour tourne dans l'Atelier ; on le suit jusqu'à sa fin, avec une marge
  // sur la durée plafonnée (c'est l'Atelier qui coupe, pas nous).
  const limite = Date.now() + (p.timeoutMs || 5 * 60 * 1000) + 60_000;
  let dernier = lancement;
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, cfg.pasSuiviMs));
    try {
      const suivi = await appeler(cfg, cle, fetchImpl, "GET", `/v1/lancements/${encodeURIComponent(lancement.id)}`);
      if (suivi.status === 200 && suivi.json?.lancement) dernier = suivi.json.lancement;
    } catch { /* un suivi raté n'arrête rien : on réessaie au pas suivant */ }
    if (ETATS_FINAUX.has(dernier.etat)) {
      const ok = dernier.etat === "fini";
      return {
        success: ok, stdout: dernier.texte || "", stderr: ok ? "" : (dernier.erreur || dernier.etat),
        exitCode: ok ? 0 : 1, ...base, etat: dernier.etat,
      };
    }
  }
  return { success: false, stdout: "", stderr: "[timeout] tour Atelier toujours en cours", exitCode: -1, ...base };
}

/** Demande à l'Atelier d'arrêter un lancement (kill_spawn). */
export async function arreterParAtelier(lancementId, { cfg = configAtelier(), fetchImpl = globalThis.fetch } = {}) {
  const cle = lireCleAtelier(cfg);
  if (!cle) return { ok: false, erreur: "clé du lanceur introuvable" };
  try {
    const r = await appeler(cfg, cle, fetchImpl, "POST", `/v1/lancements/${encodeURIComponent(lancementId)}/arreter`, {});
    return { ok: r.status === 200, etat: r.json?.lancement?.etat, erreur: r.json?.detail };
  } catch (err) {
    return { ok: false, erreur: err.message };
  }
}
