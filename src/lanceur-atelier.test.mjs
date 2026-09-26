/**
 * lanceur-atelier.test.mjs — Lot D : demander le lancement à l'Atelier.
 *
 * Un faux Atelier (fetch simulé) répond comme `POST /v1/lancements` et
 * `GET /v1/lancements/<id>` (mcp_gateway/atelier/lancements.py) : 202 avec le
 * lancement, 403 pour un refus (plafond, projet inconnu), 401 pour une clé
 * refusée, et l'état du tour au suivi.
 *
 * Usage : node --test src/lanceur-atelier.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  lanceurActif, slugProjetAtelier, lancerParAtelier, configAtelier, demandeDeLancement, arreterParAtelier,
} from "./lanceur-atelier.mjs";

const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), "wikichat-atelier-"));
const CLE = path.join(RACINE, "atelier_lanceur_key");
fs.writeFileSync(CLE, "cle-du-lanceur\n");
const PROJETS = path.join(RACINE, "projects");

function cfg(extra = {}) {
  return {
    url: "http://127.0.0.1:8787", fichierCle: CLE, racineProjets: PROJETS,
    projetDefaut: "default", delaiMs: 5000, pasSuiviMs: 5, repli: true, ...extra,
  };
}

/** Faux Atelier : consigne les appels, rejoue un scénario de suivi. */
function fauxAtelier({ etats = ["en_cours", "fini"], statut = 202, erreur = null, jeter = null } = {}) {
  const appels = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (jeter) throw jeter;
    const corps = init.body ? JSON.parse(init.body) : null;
    appels.push({ url, methode: init.method, entetes: init.headers, corps });
    const repondre = (status, obj) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
    if (init.headers["X-Atelier-Lanceur"] !== "cle-du-lanceur") return repondre(401, { detail: "clé du lanceur requise" });
    if (init.method === "POST" && url.endsWith("/v1/lancements")) {
      if (statut !== 202) return repondre(statut, { statut: "refus", erreur });
      return repondre(202, { statut: "fait", lancement: {
        id: "lc-20260926-0000abcd", conversation: corps.conversation || "conv-42", etat: "en_cours",
        mode: corps.mode || "acceptEdits", avertissements: [] } });
    }
    if (init.method === "GET") {
      const etat = etats[Math.min(n++, etats.length - 1)];
      return repondre(200, { lancement: { id: "lc-20260926-0000abcd", etat, texte: etat === "fini" ? "rapport" : "", erreur: etat === "echec" ? "code 1" : "" } });
    }
    if (url.endsWith("/arreter")) return repondre(200, { lancement: { etat: "arrete" } });
    return repondre(404, {});
  };
  return { appels, fetchImpl };
}

test("lanceur : auto par défaut — l'Atelier dès que sa clé existe, claude sinon", () => {
  const avant = process.env.WIKICHAT_LANCEUR;
  try {
    delete process.env.WIKICHAT_LANCEUR;
    assert.equal(lanceurActif(cfg()), "atelier");
    assert.equal(lanceurActif(cfg({ fichierCle: path.join(RACINE, "absente") })), "claude");
    process.env.WIKICHAT_LANCEUR = "claude";
    assert.equal(lanceurActif(cfg()), "claude");
    process.env.WIKICHAT_LANCEUR = "Atelier";
    assert.equal(lanceurActif(cfg({ fichierCle: path.join(RACINE, "absente") })), "atelier");
  } finally {
    if (avant === undefined) delete process.env.WIKICHAT_LANCEUR; else process.env.WIKICHAT_LANCEUR = avant;
  }
});

test("configuration par défaut : Atelier local, clé du lanceur dans ~/work/.secrets, repli permis", () => {
  const c = configAtelier();
  assert.equal(c.url, "http://127.0.0.1:8787");
  assert.match(c.fichierCle.replace(/\\/g, "/"), /work\/\.secrets\/atelier_lanceur_key$/);
  assert.equal(c.repli, true);
});

test("slug : premier dossier sous la racine des projets, sinon projet par défaut", () => {
  assert.equal(slugProjetAtelier(path.join(PROJETS, "lecteur-grist", "src"), cfg()), "lecteur-grist");
  assert.equal(slugProjetAtelier(path.join(PROJETS, "lecteur-grist"), cfg()), "lecteur-grist");
  assert.equal(slugProjetAtelier(path.join(RACINE, "ailleurs"), cfg()), "default");
});

test("demande : origine, projet, identité, mode, durée, outils", () => {
  const d = demandeDeLancement({
    projectPath: path.join(PROJETS, "lecteur-grist"), prompt: "fais ceci", name: "Agent-X",
    spawnedBy: "trigger:evt-wake-any:mention", mode: "plan", timeoutMs: 90_500, model: "sonnet",
    conversation: "conv-7", allowedTools: ["mcp__wikichat", "Read"],
  }, cfg());
  assert.equal(d.origine, "wikichat:trigger:evt-wake-any:mention");
  assert.equal(d.projet, "lecteur-grist");
  assert.equal(d.nom, "Agent-X");
  assert.equal(d.mode, "plan");
  assert.equal(d.mode_de_la_definition, undefined, "un mode ad hoc ne dit jamais venir d'une définition");
  assert.deepEqual(d.plafonds, { duree_s: 91 });
  assert.equal(d.modele, "sonnet");
  assert.equal(d.conversation, "conv-7");
  assert.deepEqual(d.outils, ["mcp__wikichat", "Read"]);
  const def = demandeDeLancement({ projectPath: RACINE, prompt: "p", mode: "bypassPermissions", bypassAutorise: true }, cfg());
  assert.equal(def.mode_de_la_definition, true);
  assert.equal(def.projet, "default");
});

test("tour suivi jusqu'à sa fin : succès, texte, conversation et mode rendus", async () => {
  const { appels, fetchImpl } = fauxAtelier({ etats: ["en_cours", "en_cours", "fini"] });
  const r = await lancerParAtelier({
    projectPath: path.join(PROJETS, "lecteur-grist"), prompt: "fais ceci", name: "Agent-X",
    cfg: cfg(), fetchImpl, timeoutMs: 10000,
  });
  assert.equal(r.success, true, r.stderr);
  assert.equal(r.stdout, "rapport");
  assert.equal(r.conversationId, "conv-42");
  assert.equal(r.lancementId, "lc-20260926-0000abcd");
  assert.equal(appels[0].methode, "POST");
  assert.ok(appels[0].url.endsWith("/v1/lancements"));
  assert.equal(appels.filter((a) => a.methode === "GET").length, 3);
  assert.ok(!("Authorization" in appels[0].entetes), "jamais la clé du propriétaire");
});

test("échec du tour dans l'Atelier : remonté tel quel", async () => {
  const { fetchImpl } = fauxAtelier({ etats: ["echec"] });
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", name: "Z", cfg: cfg(), fetchImpl });
  assert.equal(r.success, false);
  assert.equal(r.etat, "echec");
  assert.match(r.stderr, /code 1/);
});

test("sans attendre la fin (daemon) : rend la main après la demande", async () => {
  const { appels, fetchImpl } = fauxAtelier();
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", name: "D", attendreFin: false, cfg: cfg(), fetchImpl });
  assert.equal(r.success, true);
  assert.equal(appels.length, 1);
});

test("refus de l'Atelier (plafond) : refus, jamais un repli", async () => {
  const { fetchImpl } = fauxAtelier({ statut: 403, erreur: "plafond atteint : 3 agents lancés tournent déjà" });
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", name: "Z", cfg: cfg(), fetchImpl });
  assert.equal(r.success, false);
  assert.equal(r.refus, true);
  assert.equal(r.injoignable, undefined);
  assert.match(r.stderr, /plafond atteint/);
});

test("clé refusée (401) : refus, pas de repli", async () => {
  const mauvaise = path.join(RACINE, "mauvaise");
  fs.writeFileSync(mauvaise, "autre");
  const { fetchImpl } = fauxAtelier();
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", cfg: cfg({ fichierCle: mauvaise }), fetchImpl });
  assert.equal(r.refus, true);
  assert.match(r.stderr, /401/);
});

test("Atelier injoignable (connexion refusée, 503, clé absente) : injoignable, pour le repli", async () => {
  const refus = new TypeError("fetch failed");
  let r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", cfg: cfg(), fetchImpl: fauxAtelier({ jeter: refus }).fetchImpl });
  assert.equal(r.injoignable, true);
  r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", cfg: cfg(), fetchImpl: fauxAtelier({ statut: 503 }).fetchImpl });
  assert.equal(r.injoignable, true);
  const { appels, fetchImpl } = fauxAtelier();
  r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", cfg: cfg({ fichierCle: path.join(RACINE, "absente") }), fetchImpl });
  assert.equal(r.injoignable, true);
  assert.equal(appels.length, 0);
});

test("arrêter : la demande part à l'Atelier", async () => {
  const { appels, fetchImpl } = fauxAtelier();
  const r = await arreterParAtelier("lc-20260926-0000abcd", { cfg: cfg(), fetchImpl });
  assert.equal(r.ok, true);
  assert.ok(appels[0].url.endsWith("/v1/lancements/lc-20260926-0000abcd/arreter"));
});

test.after(() => { try { fs.rmSync(RACINE, { recursive: true, force: true }); } catch { /* */ } });
