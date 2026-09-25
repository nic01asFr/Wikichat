/**
 * lanceur-atelier.mjs — Lancer un agent PAR l'Atelier plutôt que par `claude -p`.
 *
 * Lot D de la cohérence de projet (docs/atelier-coherence.md). Préparé, pas
 * activé : tant que `WIKICHAT_LANCEUR` ne vaut pas `atelier`, rien ici n'est
 * appelé et wikichat lance `claude -p` comme avant.
 *
 * Pourquoi : un réveil wikichat reprenait la conversation HORS de l'Atelier —
 * sans fiche, sans les secrets ni les connecteurs du harnais, avec un mode de
 * permission à part. En passant par l'Atelier, le tour est joué par le même
 * harnais que tous les autres, s'affiche dans l'interface, et un humain peut
 * reprendre la main.
 *
 * Comment : l'Atelier expose ses verbes en MCP (streamable HTTP, `POST /mcp`,
 * porteur = clé propriétaire). On en utilise deux, plus un troisième pour
 * savoir quand le tour a fini :
 *   - atelier_ouvrir  { projet, titre?, modele? }     → { id, projet, dossier, … }
 *   - atelier_envoyer { conversation, message }        → { etat: "parti", curseur }
 *   - atelier_suivre  { conversation, curseur?, attendre_s? (≤ 30) }
 *                                                      → { blocs, curseur, fini?, texte?, erreur?,
 *                                                          autorisations_attendues? }
 * Schémas lus dans atelier-src/mcp_gateway/atelier/outils_conversation.py.
 */

import fs from "fs";
import path from "path";
import os from "os";

// ── Configuration ────────────────────────────────────────────────────────────

/** `claude` (défaut) ou `atelier`. */
export function lanceurActif() {
  const v = String(process.env.WIKICHAT_LANCEUR || "claude").trim().toLowerCase();
  return v === "atelier" ? "atelier" : "claude";
}

export function configAtelier() {
  const secrets = path.join(os.homedir(), "work", ".secrets");
  return {
    url: String(process.env.WIKICHAT_ATELIER_URL || "http://127.0.0.1:8787").replace(/\/+$/, ""),
    fichierCle: process.env.WIKICHAT_ATELIER_CLE_FICHIER || path.join(secrets, "atelier_owner_key"),
    racineProjets: process.env.WIKICHAT_ATELIER_PROJETS || path.join(os.homedir(), "work", "projects"),
    projetDefaut: process.env.WIKICHAT_ATELIER_PROJET_DEFAUT || "default",
    delaiMs: parseInt(process.env.WIKICHAT_ATELIER_DELAI_MS || "45000", 10),
  };
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

// ── Client MCP minimal (streamable HTTP, réponses JSON) ──────────────────────

export class ClientMcpAtelier {
  constructor({ url, cle, fetchImpl = globalThis.fetch, delaiMs = 45000 }) {
    this.url = `${url}/mcp`;
    this.cle = cle;
    this.fetch = fetchImpl;
    this.delaiMs = delaiMs;
    this.session = null;
    this.suivant = 1;
  }

  async _poster(corps) {
    const entetes = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.cle}`,
    };
    if (this.session) entetes["Mcp-Session-Id"] = this.session;
    const r = await this.fetch(this.url, {
      method: "POST",
      headers: entetes,
      body: JSON.stringify(corps),
      signal: AbortSignal.timeout(this.delaiMs),
    });
    if (r.status === 401) throw new Error("Atelier : clé refusée (401)");
    if (!r.ok) throw new Error(`Atelier : HTTP ${r.status}`);
    const sid = r.headers?.get?.("mcp-session-id");
    if (sid) this.session = sid;
    const texte = await r.text();
    return texte ? JSON.parse(texte) : {};
  }

  async _ouvrirSession() {
    if (this.session) return;
    const rep = await this._poster({
      jsonrpc: "2.0", id: this.suivant++, method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "wikichat", version: "2.0.0" },
      },
    });
    if (rep.error) throw new Error(`Atelier : initialize — ${rep.error.message || "erreur"}`);
    await this._poster({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  /** Appelle un outil `atelier_*` et rend sa charge JSON décodée. */
  async appeler(nom, args = {}) {
    await this._ouvrirSession();
    const rep = await this._poster({
      jsonrpc: "2.0", id: this.suivant++, method: "tools/call",
      params: { name: nom, arguments: args },
    });
    if (rep.error) throw new Error(`Atelier : ${nom} — ${rep.error.message || "erreur"}`);
    const res = rep.result || {};
    const texte = (res.content || []).filter((c) => c && c.type === "text").map((c) => c.text).join("");
    let charge = {};
    try { charge = texte ? JSON.parse(texte) : {}; } catch { charge = { texte }; }
    if (res.isError) throw new Error(`Atelier : ${nom} — ${charge.erreur || texte || "refus"}`);
    return charge;
  }
}

// ── Lancement ────────────────────────────────────────────────────────────────

/**
 * Ouvre (ou reprend) la conversation Atelier d'un agent et y envoie un tour.
 *
 * @param {object} p
 *   @param {string}  p.projectPath
 *   @param {string}  p.prompt
 *   @param {string}  p.name            titre de la conversation à l'ouverture
 *   @param {string}  [p.model]
 *   @param {string}  [p.conversation]  conversation Atelier déjà connue de l'agent
 *   @param {boolean} [p.attendreFin=true]  suivre le tour jusqu'à sa fin
 *   @param {number}  [p.timeoutMs]
 *   @param {object}  [p.cfg]  configuration (tests)
 *   @param {Function}[p.fetchImpl]  (tests)
 * @returns {Promise<{ success, stdout, stderr, exitCode, conversationId, bloque? }>}
 */
export async function lancerParAtelier(p) {
  const cfg = p.cfg || configAtelier();
  const cle = lireCleAtelier(cfg);
  if (!cle) {
    return { success: false, stdout: "", stderr: `clé Atelier introuvable (${cfg.fichierCle})`, exitCode: -5, conversationId: null };
  }
  const client = new ClientMcpAtelier({ url: cfg.url, cle, fetchImpl: p.fetchImpl, delaiMs: cfg.delaiMs });
  let conversationId = p.conversation || null;
  try {
    if (!conversationId) {
      const ouverte = await client.appeler("atelier_ouvrir", {
        projet: slugProjetAtelier(p.projectPath, cfg),
        titre: p.name || "",
        ...(p.model ? { modele: p.model } : {}),
      });
      conversationId = ouverte.id;
      if (!conversationId) throw new Error("Atelier : atelier_ouvrir n'a pas rendu d'identifiant");
    }
    const envoi = await client.appeler("atelier_envoyer", { conversation: conversationId, message: p.prompt });
    if (p.attendreFin === false) {
      return { success: true, stdout: "", stderr: "", exitCode: 0, conversationId };
    }

    const limite = Date.now() + (p.timeoutMs || 5 * 60 * 1000);
    let curseur = Number(envoi.curseur || 0);
    while (Date.now() < limite) {
      const reste = Math.max(1, Math.min(25, Math.floor((limite - Date.now()) / 1000)));
      const s = await client.appeler("atelier_suivre", { conversation: conversationId, curseur, attendre_s: reste });
      curseur = Number(s.curseur ?? curseur);
      if (s.fini) {
        const ok = !s.erreur;
        return { success: ok, stdout: s.texte || "", stderr: s.erreur || "", exitCode: ok ? 0 : 1, conversationId };
      }
      if (Array.isArray(s.autorisations_attendues) && s.autorisations_attendues.length) {
        // Personne ne répondra d'ici : le tour reste visible dans l'Atelier,
        // où un humain peut décider. On rend la main plutôt que d'attendre.
        return {
          success: false, stdout: "", exitCode: 2, conversationId, bloque: true,
          stderr: `tour en attente d'autorisation dans l'Atelier (${s.autorisations_attendues.length})`,
        };
      }
    }
    return { success: false, stdout: "", stderr: "[timeout] tour Atelier toujours en cours", exitCode: -1, conversationId };
  } catch (err) {
    return { success: false, stdout: "", stderr: err.message, exitCode: -1, conversationId };
  }
}
