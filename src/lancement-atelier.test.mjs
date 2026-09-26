/**
 * lancement-atelier.test.mjs — Les agents lancés par wikichat passent par l'Atelier (lot D).
 *
 * Intégration : les vraies fonctions de lancement de wikichat (spawnHeadless,
 * spawnDaemon, et une routine exécutée par le moteur des routines) contre un
 * faux Atelier HTTP qui sert le contrat de `POST /v1/lancements`. Un faux
 * `claude` dans le PATH dit si wikichat a lancé un processus lui-même : il ne
 * doit le faire qu'en repli, quand l'Atelier ne répond pas — jamais quand
 * l'Atelier refuse.
 *
 * Usage : node --test src/lancement-atelier.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";

// ── Bac à sable : AVANT tout import de sampler (chemins figés au chargement) ──
const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), "wikichat-lot-d-"));
const MAISON = path.join(RACINE, "maison");
const PROJETS = path.join(MAISON, "work", "projects");
const PROJET = path.join(PROJETS, "outil");
const FAUX_BIN = path.join(RACINE, "bin");
const TRACE_CLAUDE = path.join(RACINE, "claude-lance.json");
const CLE = path.join(MAISON, "work", ".secrets", "atelier_lanceur_key");
for (const d of [PROJET, FAUX_BIN, path.dirname(CLE)]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(CLE, "cle-du-lanceur\n");

process.env.HOME = MAISON;
process.env.USERPROFILE = MAISON;
process.env.WIKICHAT_MCP_TMP = path.join(RACINE, "configs-mcp");
process.env.FAUX_CLAUDE_SORTIE = TRACE_CLAUDE;
process.env.WIKICHAT_ATELIER_SUIVI_MS = "20";
delete process.env.WIKICHAT_LANCEUR;
delete process.env.WIKICHAT_LANCEUR_REPLI;
delete process.env.WIKICHAT_ATELIER_PROJETS;
delete process.env.WIKICHAT_ATELIER_LANCEUR_CLE_FICHIER;
process.chdir(RACINE);

const SCRIPT = path.join(FAUX_BIN, "faux-claude.mjs");
fs.writeFileSync(SCRIPT, `#!/usr/bin/env node
import fs from "fs";
fs.writeFileSync(process.env.FAUX_CLAUDE_SORTIE, JSON.stringify({ argv: process.argv.slice(2), agent: process.env.WIKICHAT_AGENT }));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "sess-repli" }));
`);
if (process.platform === "win32") {
  fs.writeFileSync(path.join(FAUX_BIN, "claude.cmd"), `@node "%~dp0faux-claude.mjs" %*\r\n`);
} else {
  fs.copyFileSync(SCRIPT, path.join(FAUX_BIN, "claude"));
  fs.chmodSync(path.join(FAUX_BIN, "claude"), 0o755);
}
process.env.PATH = FAUX_BIN + path.delimiter + (process.env.PATH || "");

// ── Faux Atelier HTTP ────────────────────────────────────────────────────────
const atelier = { demandes: [], suivis: 0, statut: 202, erreur: "", etatFinal: "fini", n: 0 };
const serveur = http.createServer((req, res) => {
  let brut = "";
  req.on("data", (c) => { brut += c; });
  req.on("end", () => {
    const repondre = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers["x-atelier-lanceur"] !== "cle-du-lanceur") return repondre(401, { detail: "clé du lanceur requise" });
    if (req.method === "POST" && req.url === "/v1/lancements") {
      const corps = JSON.parse(brut || "{}");
      atelier.demandes.push(corps);
      if (atelier.statut !== 202) return repondre(atelier.statut, { statut: "refus", erreur: atelier.erreur });
      atelier.n += 1;
      return repondre(202, { statut: "fait", lancement: {
        id: `lc-20260926-0000000${atelier.n}`, conversation: corps.conversation || `conv-${atelier.n}`,
        etat: "en_cours", mode: corps.mode === "bypassPermissions" && !corps.mode_de_la_definition ? "acceptEdits" : corps.mode,
        avertissements: [] } });
    }
    if (req.method === "GET" && req.url.startsWith("/v1/lancements/")) {
      atelier.suivis += 1;
      return repondre(200, { lancement: { id: req.url.split("/").pop(), etat: atelier.etatFinal, texte: "rapport de l'agent" } });
    }
    return repondre(404, {});
  });
});
await new Promise((r) => serveur.listen(0, "127.0.0.1", r));
const URL_ATELIER = `http://127.0.0.1:${serveur.address().port}`;
process.env.WIKICHAT_ATELIER_URL = URL_ATELIER;

const { spawnHeadless, spawnDaemon } = await import("./sampler.mjs");
const { recall } = await import("./identity.mjs");
const { configureRoutines, registerRoutine, runRoutine } = await import("./routines.mjs");
const { loadSpawnRegistry } = await import("./persistence.mjs");

function reinitialiser({ statut = 202, erreur = "", etatFinal = "fini" } = {}) {
  Object.assign(atelier, { demandes: [], suivis: 0, statut, erreur, etatFinal });
  try { fs.unlinkSync(TRACE_CLAUDE); } catch { /* */ }
}
const claudeLance = () => fs.existsSync(TRACE_CLAUDE);
const entree = (nom) => [...loadSpawnRegistry()].reverse().find((e) => e.name === nom);

test("réveil headless : demandé à l'Atelier, avec projet, identité, mode, durée ; pas de claude local", async () => {
  reinitialiser();
  const r = await spawnHeadless(PROJET, "Réponds à Nicolas", {
    name: "outil-veilleur", spawnedBy: "trigger:evt-wake-any:mention", timeoutMs: 120_000,
  });
  assert.equal(r.success, true, r.stderr);
  assert.equal(r.stdout, "rapport de l'agent");
  assert.equal(claudeLance(), false, "wikichat a lancé claude lui-même");
  const [d] = atelier.demandes;
  assert.equal(d.origine, "wikichat:trigger:evt-wake-any:mention");
  assert.equal(d.projet, "outil");
  assert.equal(d.nom, "outil-veilleur");
  assert.equal(d.mode, "acceptEdits");
  assert.deepEqual(d.plafonds, { duree_s: 120 });
  assert.ok(atelier.suivis >= 1, "le tour est suivi jusqu'à sa fin");
  const e = entree("outil-veilleur");
  assert.equal(e.mode, "atelier");
  assert.equal(e.status, "done");
  assert.equal(e.atelier_lancement, "lc-20260926-00000001");
  // La conversation est retenue : le réveil suivant la reprend (une identité).
  assert.equal(recall("outil-veilleur", "__atelier_conversation"), "conv-1");
  reinitialiser();
  await spawnHeadless(PROJET, "Encore", { name: "outil-veilleur", timeoutMs: 60_000 });
  assert.equal(atelier.demandes[0].conversation, "conv-1");
});

test("routine : le permission_mode de la DÉFINITION est transmis à l'Atelier", async () => {
  configureRoutines({
    spawn: async (params) => {
      const r = await spawnHeadless(params.repo_path, params.prompt, params);
      return { success: r.success, error: r.stderr };
    },
  });
  registerRoutine({
    id: "revue-plan", permission_mode: "plan",
    steps: [{ action: "spawn", params: { name: "revueur", repo_path: PROJET, prompt: "Relis", timeoutMs: 30_000 } }],
  });
  registerRoutine({
    id: "revue-libre", permission_mode: "bypassPermissions",
    steps: [{ action: "spawn", params: { name: "libre", repo_path: PROJET, prompt: "Relis", timeoutMs: 30_000 } }],
  });
  reinitialiser();
  let res = await runRoutine("revue-plan");
  assert.equal(res.status ?? "completed", "completed", JSON.stringify(res));
  assert.equal(atelier.demandes[0].mode, "plan");
  assert.equal(atelier.demandes[0].mode_de_la_definition, true);
  assert.equal(atelier.demandes[0].origine, "wikichat:routine:revue-plan");
  reinitialiser();
  res = await runRoutine("revue-libre");
  assert.equal(atelier.demandes[0].mode, "bypassPermissions");
  assert.equal(atelier.demandes[0].mode_de_la_definition, true, "c'est à l'Atelier de juger, avec le mode du projet");
});

test("appel ad hoc qui demande bypass : acceptEdits, sans se dire définition", async () => {
  reinitialiser();
  await spawnHeadless(PROJET, "x", { name: "adhoc", permission_mode: "bypassPermissions", timeoutMs: 30_000 });
  assert.equal(atelier.demandes[0].mode, "acceptEdits");
  assert.equal(atelier.demandes[0].mode_de_la_definition, undefined);
});

test("liste d'outils du Pilote : transmise à l'Atelier", async () => {
  reinitialiser();
  await spawnHeadless(PROJET, "x", { name: "proposeur", allowedTools: "mcp__wikichat,Read,Grep", permission_mode: "default", bypassAutorise: true, timeoutMs: 30_000 });
  assert.deepEqual(atelier.demandes[0].outils, ["mcp__wikichat", "Read", "Grep"]);
  assert.equal(atelier.demandes[0].mode, "default");
});

test("refus de l'Atelier (plafond) : pas de repli, échec remonté", async () => {
  reinitialiser({ statut: 403, erreur: "plafond atteint : 24 lancements aujourd'hui pour wikichat:trigger:x" });
  const r = await spawnHeadless(PROJET, "x", { name: "refuse", spawnedBy: "trigger:x", timeoutMs: 30_000 });
  assert.equal(r.success, false);
  assert.match(r.stderr, /plafond atteint/);
  assert.equal(claudeLance(), false, "un refus ne doit jamais être contourné par claude -p");
  assert.equal(entree("refuse").status, "refused");
});

test("Atelier injoignable : repli sur claude -p, noté au registre", async () => {
  reinitialiser();
  process.env.WIKICHAT_ATELIER_URL = "http://127.0.0.1:9"; // rien n'écoute
  try {
    const r = await spawnHeadless(PROJET, "x", { name: "repli", timeoutMs: 30_000 });
    assert.equal(r.success, true, r.stderr);
    assert.equal(claudeLance(), true);
    const trace = JSON.parse(fs.readFileSync(TRACE_CLAUDE, "utf8"));
    assert.equal(trace.argv[trace.argv.indexOf("--permission-mode") + 1], "acceptEdits");
    assert.equal(trace.agent, "repli");
    const e = entree("repli");
    assert.equal(e.mode, "headless-repli");
    assert.match(e.repli, /injoignable/);
  } finally { process.env.WIKICHAT_ATELIER_URL = URL_ATELIER; }
});

test("repli interdit (WIKICHAT_LANCEUR_REPLI=0) : échec, pas de claude local", async () => {
  reinitialiser();
  process.env.WIKICHAT_ATELIER_URL = "http://127.0.0.1:9";
  process.env.WIKICHAT_LANCEUR_REPLI = "0";
  try {
    const r = await spawnHeadless(PROJET, "x", { name: "sans-repli", timeoutMs: 30_000 });
    assert.equal(r.success, false);
    assert.equal(claudeLance(), false);
  } finally {
    process.env.WIKICHAT_ATELIER_URL = URL_ATELIER;
    delete process.env.WIKICHAT_LANCEUR_REPLI;
  }
});

test("daemon : demandé à l'Atelier avec la durée des daemons, sans processus local", async () => {
  reinitialiser();
  const r = spawnDaemon(PROJET, { name: "Sentinel", spawnedBy: "wikichat-service", task: "veille" });
  assert.equal(r.success, true);
  assert.equal(r.via, "atelier");
  for (let i = 0; i < 100 && !entree("Sentinel")?.atelier_lancement; i++) await new Promise((ok) => setTimeout(ok, 20));
  assert.equal(atelier.demandes.length, 1);
  assert.equal(atelier.demandes[0].plafonds.duree_s, 1800);
  assert.equal(entree("Sentinel").status, "delegated");
  assert.equal(claudeLance(), false);
});

test("daemon, Atelier injoignable : repli sur le daemon local", async () => {
  reinitialiser();
  process.env.WIKICHAT_ATELIER_URL = "http://127.0.0.1:9";
  try {
    spawnDaemon(PROJET, { name: "Librarian", spawnedBy: "wikichat-service", task: "range" });
    for (let i = 0; i < 250 && !claudeLance(); i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.equal(claudeLance(), true, "le daemon local n'a pas été lancé");
    assert.match(entree("Librarian").repli || "", /injoignable/);
  } finally { process.env.WIKICHAT_ATELIER_URL = URL_ATELIER; }
});

// ── J-b3 : branche pour un travail planifié, pas pour un réveil ─────────────

const { brancheDuLancement, politiqueDeBranche } = await import("./lancement.mjs");
const { configureTriggers, registerTrigger, fireTrigger } = await import("./triggers.mjs");

test("politique de branche : auto = branche si planifié ; toujours ; jamais", () => {
  const maintenant = new Date("2026-09-26T10:00:00Z");
  assert.equal(brancheDuLancement({ planifie: true, spawnedBy: "routine:revue-nuit", name: "Revueur", maintenant }),
    "agent/routine-revue-nuit/2026-09-26-revueur");
  assert.equal(brancheDuLancement({ planifie: false, spawnedBy: "trigger:evt-wake-any:mention", name: "x", maintenant }), null);
  assert.equal(brancheDuLancement({ politique: "toujours", spawnedBy: "Claude-Code", name: "Été", maintenant }),
    "agent/claude-code/2026-09-26-ete");
  assert.equal(brancheDuLancement({ politique: "jamais", planifie: true, spawnedBy: "routine:x", name: "x" }), null);
  assert.equal(brancheDuLancement({ politique: "n'importe", planifie: true, spawnedBy: "routine:x", name: "x" })?.startsWith("agent/"), true);
  assert.throws(() => politiqueDeBranche("parfois"), /inconnue/);
});

test("routine en auto : l'agent travaille sur une branche agent/…, sans reprendre une conversation", async () => {
  registerRoutine({
    id: "nettoyage", steps: [{ action: "spawn", params: { name: "nettoyeur", repo_path: PROJET, prompt: "Range", timeoutMs: 30_000 } }],
  });
  reinitialiser();
  await runRoutine("nettoyage");
  const [d] = atelier.demandes;
  assert.match(d.branche, /^agent\/routine-nettoyage\/\d{4}-\d{2}-\d{2}-nettoyeur$/);
  assert.equal(d.conversation, undefined);
  assert.equal(entree("nettoyeur").branche, d.branche);
});

test("routine en jamais (définition ou étape) : dans le projet", async () => {
  registerRoutine({
    id: "lecture", branche: "jamais",
    steps: [{ action: "spawn", params: { name: "lecteur", repo_path: PROJET, prompt: "Lis", timeoutMs: 30_000 } }],
  });
  registerRoutine({
    id: "lecture-etape",
    steps: [{ action: "spawn", params: { name: "lecteur2", repo_path: PROJET, prompt: "Lis", branche: "jamais", timeoutMs: 30_000 } }],
  });
  reinitialiser();
  await runRoutine("lecture");
  await runRoutine("lecture-etape");
  assert.equal(atelier.demandes.length, 2);
  assert.ok(atelier.demandes.every((d) => d.branche === undefined));
  assert.throws(() => registerRoutine({ id: "x", branche: "parfois", steps: [{ action: "wait", params: {} }] }), /inconnue/);
});

test("trigger cron en auto : branche ; trigger de réveil : pas de branche ; toujours : branche", async () => {
  configureTriggers({
    spawnFn: async (params) => spawnHeadless(params.repo_path, params.prompt, params),
    budgetCheckFn: () => null,
  });
  const params = { name: "planifie", repo_path: PROJET, prompt: "Vérifie", timeoutMs: 30_000 };
  registerTrigger({ id: "t-cron", type: "cron", enabled: false, config: { schedule: "0 4 * * *" }, action: { type: "spawn_session", params } });
  registerTrigger({ id: "t-mention", type: "mention", enabled: false, config: { target_name: "reveille" },
    action: { type: "spawn_session", params: { ...params, name: "reveille" } } });
  registerTrigger({ id: "t-toujours", type: "mention", enabled: false, branche: "toujours", config: { target_name: "code" },
    action: { type: "spawn_session", params: { ...params, name: "code" } } });
  assert.throws(() => registerTrigger({ id: "t-faux", type: "cron", branche: "parfois", config: {}, action: { type: "spawn_session", params } }), /inconnue/);

  reinitialiser();
  await fireTrigger("t-cron", { force: true, source: "cron" });
  await fireTrigger("t-mention", { force: true, source: "mention:m1" });
  await fireTrigger("t-toujours", { force: true, source: "mention:m2" });
  const parNom = Object.fromEntries(atelier.demandes.map((d) => [d.nom, d]));
  assert.match(parNom.planifie.branche, /^agent\/trigger-t-cron\//);
  assert.equal(parNom.reveille.branche, undefined, "un réveil travaille dans le projet");
  assert.match(parNom.code.branche, /^agent\/trigger-t-toujours\//);
});

test("branche requise et Atelier injoignable : pas de repli dans le projet", async () => {
  reinitialiser();
  process.env.WIKICHAT_ATELIER_URL = "http://127.0.0.1:9";
  try {
    const r = await spawnHeadless(PROJET, "x", { name: "brancheur", politiqueBranche: "toujours", timeoutMs: 30_000 });
    assert.equal(r.success, false);
    assert.match(r.stderr, /pas de repli hors de l'Atelier/);
    assert.equal(claudeLance(), false);
  } finally { process.env.WIKICHAT_ATELIER_URL = URL_ATELIER; }
});

test.after(() => {
  serveur.close();
  process.chdir(os.tmpdir());
  try { fs.rmSync(RACINE, { recursive: true, force: true }); } catch { /* Windows : fichier encore ouvert */ }
});
