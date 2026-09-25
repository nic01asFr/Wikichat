/**
 * profils.test.mjs — Profils d'accès (contrat de l'Atelier, docs/vision/profils-acces.md).
 *
 * Deux parties :
 *   1. fonctions pures : lecture de l'annonce, égalité de projets ;
 *   2. contre un serveur isolé (HOME jetable, deux projets `alpha` et `beta`) :
 *      - un agent code ne voit ni n'appelle un outil hors profil ;
 *      - un agent code qui vise un autre projet est refusé ;
 *      - l'Assistant voit tout, une connexion sans profil aussi ;
 *      - ressources filtrées ; briefing et hook SessionStart bornés au projet ;
 *      - bout en bout par le vrai pont stdio, qui lit WIKICHAT_PROFIL et WIKICHAT_PROJET.
 *
 * Usage : node --test --test-concurrency=1 --test-force-exit src/profils.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), "wikichat-profils-"));
const MAISON = path.join(RACINE, "maison");
const PROJETS = path.join(RACINE, "projects");
const LANCEMENT = path.join(RACINE, "lancement");
for (const d of [MAISON, PROJETS, LANCEMENT]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = MAISON;
process.env.USERPROFILE = MAISON;
process.env.WIKICHAT_ATELIER_PROJETS = PROJETS;
process.env.WIKICHAT_NO_OVERLAY_INSTALL = "1";

const W = path.join(MAISON, ".wikichat");
const ecrire = (p, contenu) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof contenu === "string" ? contenu : JSON.stringify(contenu, null, 2)); };
const attendre = (ms) => new Promise(r => setTimeout(r, ms));

const { lireAnnonce, memeProjet, OUTILS_CODE, RESSOURCES_CODE, nomCanonique } = await import("./profils.mjs");

// ═════════════════════════════════════════════════════════════════════════════
// 1. Fonctions pures
// ═════════════════════════════════════════════════════════════════════════════

test("annonce : rien, code avec projet, assistant, inconnu, variable non développée, en-têtes", () => {
  assert.deepEqual(lireAnnonce({ query: {} }), { profil: null, projet: null, annonce: "", projetAnnonce: "", inconnu: false });
  const c = lireAnnonce({ query: { profil: "code", projet: "Mon Projet" } });
  assert.equal(c.profil, "code");
  assert.equal(c.projet, "mon-projet");
  assert.equal(lireAnnonce({ query: { profil: "Assistant" } }).profil, "assistant");
  const x = lireAnnonce({ query: { profil: "admin" } });
  assert.equal(x.profil, "code", "un profil inconnu est traité comme le plus restreint");
  assert.equal(x.inconnu, true);
  assert.equal(lireAnnonce({ query: { profil: "${WIKICHAT_PROFIL}" } }).profil, null);
  const h = lireAnnonce({ headers: { "x-wikichat-profil": "code", "x-wikichat-projet": "beta" } });
  assert.deepEqual([h.profil, h.projet], ["code", "beta"]);
});

test("projets : même projet sous plusieurs écritures, nom canonique connu de wikichat", () => {
  assert.ok(memeProjet("Nouveau Projet 4", "nouveau-projet-4"));
  assert.ok(!memeProjet("alpha", "beta"));
  assert.ok(!memeProjet("", ""));
  const projets = new Map([["Nouveau Projet 4", { name: "Nouveau Projet 4" }], ["gamma", { name: "gamma" }]]);
  assert.equal(nomCanonique("nouveau-projet-4", projets), "Nouveau Projet 4");
  assert.equal(nomCanonique("gamma", projets), "gamma");
  assert.equal(nomCanonique("inconnu", projets), "inconnu");
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Contre un serveur isolé
// ═════════════════════════════════════════════════════════════════════════════

const PORT = 3500 + Math.floor(Math.random() * 90);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const ALPHA = path.join(PROJETS, "alpha");
const BETA = path.join(PROJETS, "beta");
let serveur = null;
const transports = [];

/** Client SSE direct, avec l'annonce dans l'URL comme la pose le pont. */
async function client(nom, { profil = null, projet = null } = {}) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
  const url = new URL(`${URL_BASE}/sse`);
  url.searchParams.set("agent", nom);
  if (profil) url.searchParams.set("profil", profil);
  if (projet) url.searchParams.set("projet", projet);
  const transport = new SSEClientTransport(url);
  const c = new Client({ name: `profils-${nom}`, version: "1.0.0" });
  await c.connect(transport);
  transports.push(transport);
  return {
    brut: c,
    async outils() { return (await c.listTools()).tools.map(t => t.name).sort(); },
    async appel(outil, args = {}) {
      const r = await c.callTool({ name: outil, arguments: args });
      return { texte: r.content?.map(x => x.text).join("\n") || "", erreur: !!r.isError };
    },
  };
}

before(async () => {
  ecrire(path.join(W, "knowledge", "grist-axis.md"), "# Axe Grist\n\nWidgets Grist standalone, motclecentral.\n");
  ecrire(path.join(ALPHA, "ETAT.md"), "# État — Alpha\n\nLot courant : A1, tetealpha.\n");
  ecrire(path.join(BETA, "ETAT.md"), "# État — Beta\n\nLot courant : B7, tetebeta.\n");
  ecrire(path.join(ALPHA, ".wikichat", "knowledge", "moteur.md"), "# Fiche alpha\n\nmotcleprojet dans alpha.\n");
  ecrire(path.join(BETA, ".wikichat", "knowledge", "moteur.md"), "# Fiche beta\n\nmotcleprojet dans beta.\n");
  ecrire(path.join(W, "registry.json"), { lastScan: "2026-09-26T00:00:00Z", projects: [
    { slug: "alpha", name: "alpha", path: ALPHA, status: "discovered" },
    { slug: "beta", name: "beta", path: BETA, status: "discovered" },
  ] });

  serveur = spawn(process.execPath, [path.join(DEPOT, "server.mjs")], {
    cwd: LANCEMENT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", HOME: MAISON, USERPROFILE: MAISON,
      WIKICHAT_NO_OVERLAY_INSTALL: "1", WIKICHAT_ATELIER_PROJETS: PROJETS, WIKICHAT_AUTONOMOUS_TEAM: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serveur.journal = "";
  serveur.stdout.on("data", d => { serveur.journal += d; });
  serveur.stderr.on("data", d => { serveur.journal += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${URL_BASE}/api/health`); if (r.ok) return; } catch { /* */ }
    await attendre(150);
  }
  throw new Error(`serveur isolé injoignable\n${serveur.journal}`);
});

after(async () => {
  for (const t of transports) await t.close().catch(() => {});
  if (serveur) { serveur.kill(); await attendre(300); }
  try { fs.rmSync(RACINE, { recursive: true, force: true }); } catch { /* Windows : fichiers encore ouverts */ }
});

const HORS_PROFIL_CODE = [
  "list_projects", "audit_all_projects", "scan_projects", "run_cartography", "run_clustering",
  "spawn_session", "respawn_project_agents", "kill_spawn",
  "register_trigger", "list_triggers", "fire_trigger", "set_trigger_enabled", "delete_trigger",
  "register_routine", "list_routines", "run_routine", "delete_routine",
  "purge_registry", "register", "declare_project",
  // Restés exclus par décision du coordinateur (26/09).
  "create_channel", "update_idea", "harmonize_ideas", "list_spawned", "poll_ticket", "poll_messages",
];

test("tools/list : l'agent code reçoit exactement les outils de son profil, l'Assistant et une connexion sans profil reçoivent tout", async () => {
  const code = await client("Code-Alpha", { profil: "code", projet: "alpha" });
  const assistant = await client("Assistant-Test", { profil: "assistant" });
  const sansProfil = await client("Sans-Profil");
  const vusCode = await code.outils();
  const vusAssistant = await assistant.outils();
  const vusSans = await sansProfil.outils();
  assert.deepEqual(vusCode, [...OUTILS_CODE].sort());
  for (const o of OUTILS_CODE) assert.ok(vusAssistant.includes(o), `${o} n'est pas un outil de wikichat`);
  for (const o of HORS_PROFIL_CODE) {
    assert.ok(!vusCode.includes(o), `${o} visible en profil code`);
    assert.ok(vusAssistant.includes(o), `${o} absent pour l'Assistant`);
  }
  assert.deepEqual(vusSans, vusAssistant, "sans profil : comportement d'avant, tous les outils");
  assert.ok(vusAssistant.length >= 53, `${vusAssistant.length} outils`);
  assert.match(serveur.journal, /profil non annoncé — Sans-Profil garde tous les outils/);
  assert.match(serveur.journal, /profil code \(projet alpha\) — Code-Alpha/);
  const statut = await (await fetch(`${URL_BASE}/status`)).json();
  const s = statut.sessions.find(x => x.name === "Code-Alpha");
  assert.deepEqual([s.profil, s.projet], ["code", "alpha"]);
});

test("tools/call : un outil hors profil est refusé à l'agent code, même appelé directement", async () => {
  const code = await client("Code-Alpha-2", { profil: "code", projet: "alpha" });
  for (const [outil, args] of [
    ["spawn_session", { repo_path: BETA, name: "X", task: "rien" }],
    ["list_projects", {}],
    ["register_trigger", { type: "cron", action_type: "job", action_params: { job: "run_clustering" } }],
    ["purge_registry", { dry_run: false }],
    ["run_routine", { id: "x" }],
  ]) {
    const r = await code.appel(outil, args);
    assert.ok(r.erreur, `${outil} n'a pas été refusé : ${r.texte}`);
    assert.match(r.texte, /not found/);
  }
  const reg = JSON.parse(fs.readFileSync(path.join(W, "registry.json"), "utf8"));
  assert.equal(reg.projects.length, 2, "purge_registry n'a rien fait");
  assert.ok(!fs.existsSync(path.join(W, "triggers.json")) || !JSON.stringify(JSON.parse(fs.readFileSync(path.join(W, "triggers.json"), "utf8"))).includes("run_clustering"));
});

test("projet du profil : un autre projet est refusé avec l'adresse de ses agents, le sien passe, l'argument omis vise le sien", async () => {
  const code = await client("Code-Alpha-3", { profil: "code", projet: "alpha" });
  for (const [outil, args] of [
    ["project_state", { project: "beta" }],
    ["add_project_note", { project: "beta", content: "intrusion" }],
    ["claim_task", { project: "beta", task: "t1", description: "x" }],
    ["release_task", { project: "beta", task: "t1", outcome: "x" }],
    ["set_project_meta", { project: "beta", lifecycle: "archived" }],
    ["audit_project", { project: "beta" }],
    ["list_project_agents", { project: "beta" }],
    ["close_project", { project: "beta", auto: false, closure: { documentation: "a", deliverables: "b", retro: "c", capitalisation: "d" } }],
  ]) {
    const r = await code.appel(outil, args);
    assert.match(r.texte, /Refusé : profil code, limité au projet "alpha"/, `${outil} : ${r.texte}`);
    assert.match(r.texte, /contact_agent/, `${outil} : le refus doit dire de passer par les agents`);
  }
  assert.ok(!fs.existsSync(path.join(W, "knowledge", "closure-beta.md")), "beta n'a pas été clôturé");

  const etat = await code.appel("project_state", {});
  assert.match(etat.texte, /tetealpha/);
  assert.doesNotMatch(etat.texte, /tetebeta/);
  assert.match((await code.appel("project_state", { project: "Alpha" })).texte, /tetealpha/, "même projet, autre casse");
  const tache = await code.appel("claim_task", { task: "t-alpha", description: "travail" });
  assert.match(tache.texte, /revendiquée sur alpha/);
  assert.match((await code.appel("release_task", { task: "t-alpha", outcome: "fait" })).texte, /\[done\]/);
  assert.match((await code.appel("add_project_note", { content: "note alpha", type: "question" })).texte, /alpha/);
  // repo_path ne permet pas de viser un autre dossier.
  const cl = await code.appel("close_project", { auto: true, repo_path: BETA });
  assert.match(cl.texte, /repo_path n'est pas disponible/);
});

test("recherche de connaissance : centrale et celle de son projet, pas celle d'un autre projet", async () => {
  const code = await client("Code-Alpha-4", { profil: "code", projet: "alpha" });
  const assistant = await client("Assistant-KB", { profil: "assistant" });
  assert.match((await code.appel("search_knowledge", { query: "motclecentral" })).texte, /Axe Grist/);
  const projet = (await code.appel("search_knowledge", { query: "motcleprojet" })).texte;
  assert.match(projet, /Fiche alpha/);
  assert.doesNotMatch(projet, /Fiche beta/);
  const tout = (await assistant.appel("search_knowledge", { query: "motcleprojet" })).texte;
  assert.match(tout, /Fiche alpha/);
  assert.match(tout, /Fiche beta/);
});

test("messagerie : contact_agent vers un agent d'un autre projet passe, sans réveil ; list_sessions réduit aux présents", async () => {
  const code = await client("Code-Alpha-5", { profil: "code", projet: "alpha" });
  const beta = await client("Code-Beta", { profil: "code", projet: "beta" });
  await beta.appel("claim_task", { task: "secret-beta", description: "tache interne beta" });
  const sessions = (await code.appel("list_sessions", {})).texte;
  assert.match(sessions, /Code-Beta — projet beta/);
  assert.doesNotMatch(sessions, /secret-beta|tache interne/);
  const reveil = await code.appel("contact_agent", { target: "Code-Beta", message: "peux-tu ?", wake: true });
  assert.match(reveil.texte, /wake=true lancerait un agent/);
  const depot = await code.appel("contact_agent", { target: "Code-Beta", message: "question de alpha pour beta" });
  assert.doesNotMatch(depot.texte, /Refusé/, depot.texte);
  const recu = (await beta.appel("read_messages", { channel: "__all__", since_minutes: 5 })).texte;
  assert.match(recu, /question de alpha pour beta/);
  const envoi = await code.appel("send_message", { channel: "@Code-Beta", content: "dm de alpha" });
  assert.match(envoi.texte, /DM envoyé/);
});

test("briefing : l'agent code voit son projet et son courrier, pas les autres projets ; l'Assistant voit tout", async () => {
  const assistant = await client("Assistant-Brief", { profil: "assistant" });
  await assistant.appel("declare_project", { name: "alpha", description: "projet alpha" });
  await assistant.appel("declare_project", { name: "beta", description: "projet beta" });
  await assistant.appel("send_message", { channel: "proj-beta", content: "bruit interne de beta" });
  const code = await client("Code-Alpha-6", { profil: "code", projet: "alpha" });
  const b = (await code.appel("get_briefing", {})).texte;
  assert.match(b, /Ton projet : alpha/);
  assert.doesNotMatch(b, /📁 beta/);
  assert.doesNotMatch(b, /bruit interne de beta/);
  const ba = (await assistant.appel("get_briefing", {})).texte;
  assert.match(ba, /📁 alpha/);
  assert.match(ba, /📁 beta/);
});

test("ressources : même filtrage — ni principal ni décisions, sa seule identité, pas la connaissance d'un autre projet", async () => {
  const code = await client("Code-Alpha-7", { profil: "code", projet: "alpha" });
  const assistant = await client("Assistant-Res", { profil: "assistant" });
  const uris = (await code.brut.listResources()).resources.map(r => r.uri);
  assert.ok(!uris.includes("wikichat://principal"), uris.join(","));
  assert.ok(!uris.includes("wikichat://decisions"));
  assert.ok(uris.includes("wikichat://briefing"));
  assert.ok(uris.includes("wikichat://kb/grist-axis"));
  assert.ok(uris.includes("wikichat://identity/Code-Alpha-7"));
  assert.ok(!uris.some(u => u.startsWith("wikichat://identity/") && u !== "wikichat://identity/Code-Alpha-7"), uris.join(","));
  assert.ok(!uris.some(u => u.includes("beta")), uris.join(","));
  const urisA = (await assistant.brut.listResources()).resources.map(r => r.uri);
  assert.ok(urisA.includes("wikichat://principal") && urisA.includes("wikichat://decisions"));
  await assert.rejects(code.brut.readResource({ uri: "wikichat://principal" }));
  const autre = await code.brut.readResource({ uri: "wikichat://identity/Assistant-Res" });
  assert.match(autre.contents[0].text, /Refusé/);
  const kbBeta = await code.brut.readResource({ uri: `wikichat://kb/${encodeURIComponent("beta/moteur")}` });
  assert.doesNotMatch(kbBeta.contents[0].text, /Fiche beta/);
  const kbAlpha = await code.brut.readResource({ uri: `wikichat://kb/${encodeURIComponent("alpha/moteur")}` });
  assert.match(kbAlpha.contents[0].text, /Fiche alpha/);
  const brief = await code.brut.readResource({ uri: "wikichat://briefing" });
  assert.match(brief.contents[0].text, /Ton projet\nalpha/);
  assert.doesNotMatch(brief.contents[0].text, /bruit interne de beta/);
});

test("hook SessionStart d'un agent code : son projet et son courrier, rien d'un autre projet", async () => {
  const sid = "c0de0001-0000-4000-8000-000000000001";
  const nom = "alpha-c0de00";
  const assistant = await client("Assistant-Hook", { profil: "assistant" });
  await assistant.appel("send_message", { channel: `@${nom}`, content: "courrier pour alpha" });
  await assistant.appel("send_message", { channel: "proj-beta", content: "annonce beta hors sujet" });
  const r = await fetch(`${URL_BASE}/api/hooks/session-start`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ entree: { session_id: sid, cwd: ALPHA, source: "startup" }, env: {} }),
  });
  const sortie = await r.json();
  const ctx = sortie.hookSpecificOutput?.additionalContext || "";
  assert.match(ctx, new RegExp(`Identité wikichat de cette conversation : ${nom} \\(projet alpha`));
  assert.match(ctx, /tetealpha/);
  assert.match(ctx, /courrier pour alpha/);
  assert.doesNotMatch(ctx, /tetebeta|annonce beta|Beta/);
});

test("bout en bout par le pont stdio : WIKICHAT_PROFIL et WIKICHAT_PROJET font le filtrage", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const pont = async (env) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(DEPOT, "scripts", "wikichat-mcp-stdio.mjs")],
      env: { ...process.env, HOME: MAISON, USERPROFILE: MAISON, WIKICHAT_HOST: "127.0.0.1", WIKICHAT_PORT: String(PORT), ...env },
      stderr: "pipe",
    });
    const c = new Client({ name: "profils-pont", version: "1.0.0" });
    await c.connect(transport);
    transports.push(transport);
    return c;
  };
  const code = await pont({ WIKICHAT_AGENT: "Pont-Alpha", WIKICHAT_PROFIL: "code", WIKICHAT_PROJET: "alpha" });
  const noms = (await code.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(noms, [...OUTILS_CODE].sort());
  const refus = await code.callTool({ name: "claim_task", arguments: { project: "beta", task: "x", description: "y" } });
  assert.match(refus.content[0].text, /limité au projet "alpha"/);
  const cache = await code.callTool({ name: "spawn_session", arguments: { repo_path: BETA, name: "X", task: "t" } });
  assert.ok(cache.isError);

  const sans = await pont({ WIKICHAT_AGENT: "Pont-Sans", WIKICHAT_PROFIL: "${WIKICHAT_PROFIL}" });
  const tous = (await sans.listTools()).tools.map(t => t.name);
  assert.ok(tous.includes("spawn_session") && tous.includes("list_projects"));
  const statut = await (await fetch(`${URL_BASE}/status`)).json();
  const p = statut.sessions.find(x => x.name === "Pont-Alpha");
  assert.deepEqual([p?.profil, p?.projet], ["code", "alpha"]);
  assert.equal(statut.sessions.find(x => x.name === "Pont-Sans")?.profil, null);
});

test("décision du 26/09 : outils rendus au profil code, bornés à son projet", async () => {
  const code = await client("Code-Alpha-8", { profil: "code", projet: "alpha" });
  assert.equal(OUTILS_CODE.length, 26);
  const audit = await code.appel("audit_project", {});
  assert.match(audit.texte, /Audit : "alpha"/, audit.texte);
  assert.ok(audit.texte.includes(ALPHA), audit.texte);
  assert.doesNotMatch((await code.appel("list_project_agents", {})).texte, /Refusé/);
  assert.match((await code.appel("set_status", { status: "en revue" })).texte, /Statut/);
  assert.match((await code.appel("declare_delay", { duration_minutes: 0 })).texte, /Disponibilité rétablie/);
  assert.match((await code.appel("share_artifact", { title: "plan", artifact_type: "plan", content: "étapes", channel: "proj-alpha" })).texte, /partagé/);
  assert.match((await code.appel("list_channels", {})).texte, /Canaux/);
  const idee = (await code.appel("add_idea", { title: "idée alpha" })).texte;
  const id = idee.match(/\[([a-z0-9-]+)\]/i)?.[1];
  assert.ok(id, idee);
  assert.match((await code.appel("list_ideas", {})).texte, /idée alpha/);
  assert.match((await code.appel("get_idea", { id })).texte, /idée alpha/);
});

test("décision du 26/09 : close_project en profil code, auto=false seulement ; le Closer est réservé à l'Assistant", async () => {
  const code = await client("Code-Alpha-9", { profil: "code", projet: "alpha" });
  const auto = await code.appel("close_project", {});
  assert.match(auto.texte, /auto=true lancerait un agent \(le Closer\), réservé à l'Assistant/);
  assert.match((await code.appel("close_project", { auto: true })).texte, /réservé à l'Assistant/);
  const closure = { documentation: "ETAT.md", deliverables: "A1", retro: "RAS", capitalisation: "motcleclosure" };
  const manuel = await code.appel("close_project", { auto: false, closure });
  assert.match(manuel.texte, /clôturé/, manuel.texte);
  assert.ok(fs.existsSync(path.join(W, "knowledge", "closure-alpha.md")));
});

test("contrat : les ressources du profil code sont celles déclarées", () => {
  assert.deepEqual([...RESSOURCES_CODE].sort(), ["briefing", "identity", "knowledge", "role"]);
});
