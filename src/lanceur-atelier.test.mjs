/**
 * lanceur-atelier.test.mjs — Lot D préparé : lancer un tour par l'API MCP de l'Atelier.
 *
 * Un faux Atelier (fetch simulé) répond comme `POST /mcp` : initialize avec
 * Mcp-Session-Id, puis tools/call de atelier_ouvrir / atelier_envoyer /
 * atelier_suivre au format de outils_conversation.py (charge JSON dans un
 * bloc texte, isError pour un refus).
 *
 * Usage : node --test src/lanceur-atelier.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  lanceurActif, slugProjetAtelier, lancerParAtelier, configAtelier,
} from "./lanceur-atelier.mjs";

const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), "wikichat-atelier-"));
const CLE = path.join(RACINE, "atelier_owner_key");
fs.writeFileSync(CLE, "cle-proprietaire\n");
const PROJETS = path.join(RACINE, "projects");

function cfg(extra = {}) {
  return {
    url: "http://127.0.0.1:8787", fichierCle: CLE, racineProjets: PROJETS,
    projetDefaut: "default", delaiMs: 5000, ...extra,
  };
}

/** Faux Atelier : consigne les appels, rejoue un scénario de `suivre`. */
function fauxAtelier({ suivis = [{ fini: true, texte: "fait" }], refus = null } = {}) {
  const appels = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const corps = JSON.parse(init.body);
    appels.push({ url, entetes: init.headers, corps });
    const repondre = (obj, entetes = {}) => ({
      ok: true, status: 200,
      headers: { get: (k) => entetes[k.toLowerCase()] ?? null },
      text: async () => (obj === null ? "" : JSON.stringify(obj)),
    });
    if (init.headers.Authorization !== "Bearer cle-proprietaire") {
      return { ok: false, status: 401, headers: { get: () => null }, text: async () => "" };
    }
    if (corps.method === "initialize") {
      return repondre({ jsonrpc: "2.0", id: corps.id, result: { serverInfo: { name: "atelier" } } }, { "mcp-session-id": "sess-mcp-1" });
    }
    if (corps.method === "notifications/initialized") return repondre(null);
    const { name, arguments: args } = corps.params;
    const outil = (charge, isError = false) => repondre({
      jsonrpc: "2.0", id: corps.id,
      result: { content: [{ type: "text", text: JSON.stringify(charge) }], isError },
    });
    if (refus && refus.outil === name) return outil({ erreur: refus.erreur }, true);
    if (name === "atelier_ouvrir") return outil({ id: "conv-42", projet: args.projet, titre: args.titre, dossier: "/x", etat: "idle" });
    if (name === "atelier_envoyer") return outil({ conversation: args.conversation, etat: "parti", curseur: 0 });
    if (name === "atelier_suivre") {
      const s = suivis[Math.min(n++, suivis.length - 1)];
      return outil({ conversation: args.conversation, etat: "idle", curseur: n, blocs: [], ...s });
    }
    return outil({ erreur: "inconnu" }, true);
  };
  return { appels, fetchImpl };
}

test("lanceur : claude par défaut, atelier seulement si demandé", () => {
  const avant = process.env.WIKICHAT_LANCEUR;
  try {
    delete process.env.WIKICHAT_LANCEUR;
    assert.equal(lanceurActif(), "claude");
    process.env.WIKICHAT_LANCEUR = "Atelier";
    assert.equal(lanceurActif(), "atelier");
    process.env.WIKICHAT_LANCEUR = "autre";
    assert.equal(lanceurActif(), "claude");
  } finally {
    if (avant === undefined) delete process.env.WIKICHAT_LANCEUR; else process.env.WIKICHAT_LANCEUR = avant;
  }
});

test("configuration par défaut : Atelier local, clé dans ~/work/.secrets", () => {
  const c = configAtelier();
  assert.equal(c.url, "http://127.0.0.1:8787");
  assert.match(c.fichierCle.replace(/\\/g, "/"), /work\/\.secrets\/atelier_owner_key$/);
});

test("slug : premier dossier sous la racine des projets, sinon projet par défaut", () => {
  assert.equal(slugProjetAtelier(path.join(PROJETS, "lecteur-grist", "src"), cfg()), "lecteur-grist");
  assert.equal(slugProjetAtelier(path.join(PROJETS, "lecteur-grist"), cfg()), "lecteur-grist");
  assert.equal(slugProjetAtelier(path.join(RACINE, "ailleurs"), cfg()), "default");
  assert.equal(slugProjetAtelier(PROJETS, cfg()), "default");
});

test("nouvel agent : ouvrir, envoyer, suivre jusqu'à la fin", async () => {
  const { appels, fetchImpl } = fauxAtelier({ suivis: [{}, { fini: true, texte: "rapport" }] });
  const r = await lancerParAtelier({
    projectPath: path.join(PROJETS, "lecteur-grist"), prompt: "fais ceci", name: "Agent-X",
    model: "sonnet", cfg: cfg(), fetchImpl, timeoutMs: 10000,
  });
  assert.equal(r.success, true, r.stderr);
  assert.equal(r.conversationId, "conv-42");
  assert.equal(r.stdout, "rapport");
  const outils = appels.filter((a) => a.corps.method === "tools/call").map((a) => a.corps.params);
  assert.deepEqual(outils.map((o) => o.name), ["atelier_ouvrir", "atelier_envoyer", "atelier_suivre", "atelier_suivre"]);
  assert.deepEqual(outils[0].arguments, { projet: "lecteur-grist", titre: "Agent-X", modele: "sonnet" });
  assert.deepEqual(outils[1].arguments, { conversation: "conv-42", message: "fais ceci" });
  assert.ok(outils[2].arguments.attendre_s <= 25);
  // Session MCP portée après initialize
  assert.equal(appels.at(-1).entetes["Mcp-Session-Id"], "sess-mcp-1");
});

test("agent connu : la conversation est reprise, pas rouverte", async () => {
  const { appels, fetchImpl } = fauxAtelier();
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "suite", name: "Agent-X", conversation: "conv-7", cfg: cfg(), fetchImpl });
  assert.equal(r.success, true);
  const noms = appels.filter((a) => a.corps.method === "tools/call").map((a) => a.corps.params.name);
  assert.ok(!noms.includes("atelier_ouvrir"));
  assert.equal(r.conversationId, "conv-7");
});

test("sans attendre la fin (daemon) : rend la main après envoyer", async () => {
  const { appels, fetchImpl } = fauxAtelier();
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", name: "D", attendreFin: false, cfg: cfg(), fetchImpl });
  assert.equal(r.success, true);
  assert.ok(!appels.some((a) => a.corps.params?.name === "atelier_suivre"));
});

test("tour bloqué sur une autorisation : on rend la main, sans décider à la place de l'humain", async () => {
  const { appels, fetchImpl } = fauxAtelier({ suivis: [{ autorisations_attendues: [{ request_id: "r1" }] }] });
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", name: "B", cfg: cfg(), fetchImpl });
  assert.equal(r.success, false);
  assert.equal(r.bloque, true);
  assert.ok(!appels.some((a) => a.corps.params?.name === "atelier_decider"));
});

test("refus de l'Atelier (projet inconnu) : erreur remontée", async () => {
  const { fetchImpl } = fauxAtelier({ refus: { outil: "atelier_ouvrir", erreur: "projet inconnu : zz" } });
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", name: "Z", cfg: cfg(), fetchImpl });
  assert.equal(r.success, false);
  assert.match(r.stderr, /projet inconnu/);
});

test("clé absente : aucun appel, erreur explicite", async () => {
  const { appels, fetchImpl } = fauxAtelier();
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", name: "Z", cfg: cfg({ fichierCle: path.join(RACINE, "absente") }), fetchImpl });
  assert.equal(r.success, false);
  assert.match(r.stderr, /clé Atelier introuvable/);
  assert.equal(appels.length, 0);
});

test("clé refusée : 401 remonté", async () => {
  const mauvaise = path.join(RACINE, "mauvaise");
  fs.writeFileSync(mauvaise, "autre");
  const { fetchImpl } = fauxAtelier();
  const r = await lancerParAtelier({ projectPath: RACINE, prompt: "p", name: "Z", cfg: cfg({ fichierCle: mauvaise }), fetchImpl });
  assert.equal(r.success, false);
  assert.match(r.stderr, /401/);
});

test.after(() => { try { fs.rmSync(RACINE, { recursive: true, force: true }); } catch { /* */ } });
