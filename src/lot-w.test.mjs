/**
 * lot-w.test.mjs — Comportements du lot W (remise en état de wikichat).
 *
 * Deux parties :
 *   1. dans le processus, avec un HOME jetable posé AVANT tout import (les
 *      chemins de données sont calculés à l'import) : migration W2,
 *      connaissance W1, jobs W3, clôtures W5, plafond J-b, lien de
 *      settings.json ;
 *   2. contre un serveur isolé (autre HOME, dossier de lancement garni de
 *      données « d'avant W2 ») : reprise au démarrage, lecteurs de
 *      connaissance, /api/cartographie (contrat W4), close_project sur un
 *      projet à fichiers, trigger créé par un agent.
 *
 * Usage : node --test src/lot-w.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), "wikichat-lot-w-"));
const MAISON = path.join(RACINE, "maison");            // HOME du processus de test
const PROJETS = path.join(RACINE, "projects");         // racine des projets de l'Atelier
for (const d of [MAISON, PROJETS]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = MAISON;
process.env.USERPROFILE = MAISON;
process.env.WIKICHAT_ATELIER_PROJETS = PROJETS;
process.env.WIKICHAT_NO_OVERLAY_INSTALL = "1";

const W = path.join(MAISON, ".wikichat");
const ecrire = (p, contenu) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof contenu === "string" ? contenu : JSON.stringify(contenu, null, 2)); };
const lire = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const attendre = (ms) => new Promise(r => setTimeout(r, ms));

// ═════════════════════════════════════════════════════════════════════════════
// 1. Dans le processus
// ═════════════════════════════════════════════════════════════════════════════

// ── W2 : migration ───────────────────────────────────────────────────────────

test("W2 : les chemins de données sont sous ~/.wikichat, plus sous le dossier de lancement", async () => {
  const { CHEMINS } = await import("./chemins.mjs");
  const p = await import("./persistence.mjs");
  for (const c of [CHEMINS.memoires, CHEMINS.messages, CHEMINS.fils, CHEMINS.sessions, CHEMINS.projets, p.SESSION_STORE, p.PROJECT_STORE, p.MESSAGES_FILE, p.CHANNELS_FILE, p.SPAWN_REGISTRY, p.AGENTS_DIR]) {
    assert.ok(c.startsWith(W), `${c} n'est pas sous ${W}`);
  }
});

test("W2 : reprise des données du dossier de lancement, fusion, idempotence et retour arrière", async () => {
  const { migrerDonnees, retourArriere, TEMOIN } = await import("./migration.mjs");
  const SRC = path.join(RACINE, "ancien-lancement");
  const vieux = "2026-09-01T00:00:00.000Z", recent = "2026-09-20T00:00:00.000Z";
  ecrire(path.join(SRC, ".wikichat", "memories.json"), {
    Alice: { projet: { value: "ancien-cwd", updatedAt: recent }, commun: { value: "source-vieille", updatedAt: vieux } },
    Bob: { __cwd: { value: "/x", updatedAt: vieux } },
  });
  ecrire(path.join(SRC, ".wikichat", "messages.json"), [{ id: "m1", channel: "c", content: "un", timestamp: vieux }, { id: "m2", channel: "c", content: "deux", timestamp: recent }]);
  ecrire(path.join(SRC, ".wikichat", "fils.json"), { fils: [{ id: "f-1", messages: [{ id: "m1" }] }] });
  ecrire(path.join(SRC, ".wikichat", "channels.json"), [{ name: "general" }, { name: "c" }]);
  ecrire(path.join(SRC, "sessions", "Alice.json"), { name: "Alice", source: "cwd" });
  ecrire(path.join(SRC, "sessions", "Conflit.json"), { version: "source" });
  ecrire(path.join(SRC, "projects", "Projet Sans Depot.json"), { name: "Projet Sans Depot", tasks: {} });
  ecrire(path.join(SRC, "agents", "Alice", "context.json"), { name: "Alice" });
  ecrire(path.join(SRC, "spawn_registry.json"), [{ name: "Alice", storage_path: path.join(SRC, "agents", "Alice"), spawned_at: recent }]);
  ecrire(path.join(SRC, "crons.json"), [{ id: "c1" }]);
  // Déjà présent dans ~/.wikichat : une clé plus récente, une session plus récente.
  ecrire(path.join(W, "memories.json"), { Alice: { commun: { value: "destination-recente", updatedAt: recent } } });
  ecrire(path.join(W, "sessions", "Conflit.json"), { version: "destination" });
  const t = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(W, "sessions", "Conflit.json"), t, t);

  const r = migrerDonnees({ sources: [SRC], log: () => {} });
  assert.equal(r.reprises.length, 1);
  const mem = lire(path.join(W, "memories.json"));
  assert.equal(mem.Alice.projet.value, "ancien-cwd");
  assert.equal(mem.Alice.commun.value, "destination-recente", "la clé la plus récente doit gagner");
  assert.equal(mem.Bob.__cwd.value, "/x");
  assert.deepEqual(lire(path.join(W, "messages.json")).map(m => m.id), ["m1", "m2"]);
  assert.equal(lire(path.join(W, "fils.json")).fils[0].id, "f-1");
  assert.deepEqual(lire(path.join(W, "channels.json")).map(c => c.name), ["general", "c"]);
  assert.equal(lire(path.join(W, "sessions", "Alice.json")).source, "cwd");
  assert.equal(lire(path.join(W, "sessions", "Conflit.json")).version, "destination", "la plus récente reste en place");
  assert.equal(lire(path.join(W, "migration-w2", "conflits", "sessions", "Conflit.json")).version, "source", "l'autre version est gardée");
  assert.ok(fs.existsSync(path.join(W, "projects", "Projet Sans Depot.json")));
  assert.ok(fs.existsSync(path.join(W, "agents", "Alice", "context.json")));
  assert.equal(lire(path.join(W, "spawn_registry.json"))[0].storage_path, path.join(W, "agents", "Alice"), "storage_path recalé");
  assert.deepEqual(lire(path.join(W, "crons.json")), [{ id: "c1" }]);
  // La source est intacte : rien n'est déplacé.
  assert.equal(lire(path.join(SRC, ".wikichat", "memories.json")).Alice.projet.value, "ancien-cwd");
  assert.ok(fs.existsSync(TEMOIN));

  // Idempotence : une clé oubliée depuis ne revient pas au redémarrage suivant.
  const m2 = lire(path.join(W, "memories.json"));
  delete m2.Bob;
  ecrire(path.join(W, "memories.json"), m2);
  const r2 = migrerDonnees({ sources: [SRC], log: () => {} });
  assert.equal(r2.reprises.length, 0);
  assert.deepEqual(r2.ignorees, [fs.realpathSync(SRC)]);
  assert.equal(lire(path.join(W, "memories.json")).Bob, undefined);

  // Retour arrière : la source reçoit l'état courant, l'ancien est gardé à côté.
  retourArriere({ source: SRC, log: () => {} });
  assert.equal(lire(path.join(SRC, ".wikichat", "memories.json")).Alice.commun.value, "destination-recente");
  assert.equal(lire(path.join(SRC, ".avant-retour-w2", "memories.json")).Alice.commun.value, "source-vieille");
});

// ── W1 : un seul lecteur ─────────────────────────────────────────────────────

const PROJET_KB = path.join(RACINE, "depots", "projet-kb");

test("W1 : fiches à plat, centrales et de projet ; recherche, lecture, index", async () => {
  ecrire(path.join(W, "knowledge", "grist-axis.md"), "# Axe Grist\n\n## Décisions closes\nWidget standalone plutôt que plugin.\n");
  ecrire(path.join(W, "knowledge", "blender-axis.md"), "# Axe Blender\n\nRendu headless.\n");
  ecrire(path.join(PROJET_KB, ".wikichat", "knowledge", "notes.md"), "# Notes du projet\n\nLe widget Grist du projet.\n");
  ecrire(path.join(W, "registry.json"), { projects: [{ slug: "projet-kb", name: "projet-kb", path: PROJET_KB, status: "discovered" }] });
  const k = await import("./connaissance.mjs");
  const index = k.indexFiches();
  assert.deepEqual(index.map(f => f.sujet).sort(), ["blender-axis", "grist-axis", "projet-kb/notes"]);
  assert.equal(index.find(f => f.sujet === "grist-axis").titre, "Axe Grist");
  assert.equal(k.lireFiche("grist").sujet, "grist-axis", "le suffixe -axis est implicite");
  assert.equal(k.lireFiche("projet-kb/notes").source, "projet-kb");
  assert.equal(k.lireFiche("../registry"), null, "pas de sortie du dossier");
  const r = k.chercher("widget grist");
  assert.equal(r.resultats[0].sujet, "grist-axis");
  assert.ok(r.resultats.some(x => x.sujet === "projet-kb/notes"));
  assert.equal(k.chercher("widget", { portee: "central" }).resultats.every(x => x.source === "central"), true);
});

// ── W3 : jobs ────────────────────────────────────────────────────────────────

test("W3 : étape job d'une routine — appel direct de runClustering, sans agent", async () => {
  const A = path.join(RACINE, "depots", "a"), B = path.join(RACINE, "depots", "b");
  const deps = { dependencies: { express: "1", zod: "1", chokidar: "1" } };
  ecrire(path.join(A, "package.json"), deps);
  ecrire(path.join(B, "package.json"), deps);
  ecrire(path.join(W, "registry.json"), { projects: [
    { slug: "a", name: "a", path: A, status: "discovered" },
    { slug: "b", name: "b", path: B, status: "discovered" },
  ] });
  const { registerRoutine, runRoutine, routineEstDuCode } = await import("./routines.mjs");
  registerRoutine({ id: "test:clustering", steps: [{ action: "job", params: { job: "runClustering" } }] });
  assert.equal(routineEstDuCode("test:clustering"), true);
  const r = await runRoutine("test:clustering", {});
  assert.equal(r.status, "completed", r.error);
  assert.equal(r.steps[0].output.job, "run_clustering");
  assert.ok(r.steps[0].output.liaisons >= 1);
  const fichiers = fs.readdirSync(path.join(W, "clusters"));
  assert.equal(fichiers.length, 1);
  assert.ok(lire(path.join(W, "clusters", fichiers[0])).edges.some(e => [e.a, e.b].sort().join() === "a,b"));
  // Une action inconnue est refusée à l'enregistrement, pas à chaque exécution.
  assert.throws(() => registerRoutine({ id: "x", steps: [{ action: "send_message", params: {} }] }), /inconnue/);
  assert.throws(() => registerRoutine({ id: "y", steps: [{ action: "job", params: { job: "nexiste_pas" } }] }), /inconnu/);
});

test("W3 : action job d'un trigger — tourne même porte fermée (J-c), un lancement d'agent non", async () => {
  const dormant = await import("./dormant.mjs");
  dormant.setManualOverride(false);
  const t = await import("./triggers.mjs");
  const { routineEstDuCode } = await import("./routines.mjs");
  t.configureTriggers({ spawnFn: async () => ({ success: true }), routineEstDuCodeFn: routineEstDuCode });
  t.registerTrigger({ id: "t-job", type: "webhook", action: { type: "job", params: { job: "run_clustering" } } });
  t.registerTrigger({ id: "t-agent", type: "webhook", action: { type: "spawn_session", params: { name: "X" } } });
  const okJob = await t.fireTrigger("t-job");
  assert.equal(okJob.ok, true, JSON.stringify(okJob));
  assert.equal(okJob.detail.job, "run_clustering");
  assert.equal((await t.fireTrigger("t-agent")).reason, "dormant");
  assert.throws(() => t.registerTrigger({ id: "t-bad", type: "webhook", action: { type: "job", params: { job: "rien" } } }), /inconnu/);
  dormant.setManualOverride(null);
});

test("W3 : les crons Cartographer et Matchmaker de l'équipe passent par l'étape job", async () => {
  process.env.WIKICHAT_AUTONOMOUS_TEAM = "1";
  const { bootstrapAutonomousTeam } = await import("./team-bootstrap.mjs");
  const { getRoutine, routineEstDuCode } = await import("./routines.mjs");
  const { getTrigger } = await import("./triggers.mjs");
  bootstrapAutonomousTeam();
  delete process.env.WIKICHAT_AUTONOMOUS_TEAM;
  for (const [routine, job] of [["team:job-cartography", "run_cartography"], ["team:job-clustering", "run_clustering"], ["team:job-audits", "audit_all_projects"]]) {
    const def = getRoutine(routine);
    assert.deepEqual(def.steps, [{ action: "job", params: { job } }], routine);
    assert.equal(routineEstDuCode(routine), true);
  }
  assert.equal(getTrigger("team-cron-cartography").action.params.id, "team:job-cartography");
  assert.equal(getRoutine("team:knowledge-absorb-closure").steps[0].action, "job");
});

test("W3 : une installation ancienne voit ses routines Cartographer/Matchmaker réparées au démarrage, sans équipe", async () => {
  const { registerRoutine, getRoutine, deleteRoutine } = await import("./routines.mjs");
  const { reparerRoutinesEquipe } = await import("./team-bootstrap.mjs");
  deleteRoutine("team:job-audits");
  registerRoutine({ id: "team:job-cartography", steps: [{ action: "spawn", params: { name: "Cartographer-{ts}", task: "Appelle run_cartography()." } }] });
  const avant = getRoutine("team:job-cartography").run_count;
  const r = reparerRoutinesEquipe();
  assert.ok(r.includes("team:job-cartography"));
  assert.deepEqual(getRoutine("team:job-cartography").steps, [{ action: "job", params: { job: "run_cartography" } }]);
  assert.equal(getRoutine("team:job-cartography").run_count, avant, "statistiques gardées");
  assert.equal(getRoutine("team:job-audits"), null, "aucune routine créée");
  assert.deepEqual(reparerRoutinesEquipe(), [], "idempotent");
});

test("J-b : plafond quotidien par défaut à 24", async () => {
  const t = await import("./triggers.mjs");
  const tr = t.registerTrigger({ id: "t-defaut", type: "webhook", action: { type: "broadcast", params: { content: "x" } } });
  assert.equal(tr.max_per_day, 24);
  assert.equal(t.MAX_PAR_JOUR_DEFAUT, 24);
});

// ── W4 : ponts de la carte ───────────────────────────────────────────────────

test("W4 : les ponts entre îles viennent des vrais liens, plus des thèmes codés en dur", async () => {
  const { generateMap } = await import("./map-generator.mjs");
  const projets = [
    { slug: "agent-mcp", name: "agent-mcp", description: "claude mcp agent llm" },
    { slug: "donnees-grist", name: "donnees-grist", description: "data grist dataset opendata" },
    { slug: "jeu", name: "jeu", description: "game level player" },
    { slug: "rendu", name: "rendu", description: "creative render image 3d" },
  ];
  const sansLiens = generateMap(projets);
  assert.equal(sansLiens.bridges.filter(b => b.from !== "hub").length, 0, "aucun pont inventé (games↔creative, ai↔data…)");
  const carte = generateMap(projets, { aretes: [{ de: "agent-mcp", vers: "donnees-grist", type: "relation" }, { de: "agent-mcp", vers: "donnees-grist", type: "proximite" }] });
  const ponts = carte.bridges.filter(b => b.from !== "hub");
  assert.equal(ponts.length, 1);
  assert.equal(ponts[0].weight, 2);
  assert.match(ponts[0].label, /1 relation/);
});

// ── W5 : clôtures ────────────────────────────────────────────────────────────

test("W5 : prompt du Closer avec les chemins réels d'un projet à fichiers", async () => {
  const P = path.join(PROJETS, "carnet");
  ecrire(path.join(P, "ETAT.md"), "# État — Carnet\n\nLot courant : L2.\n\n## À décider\n- rien\n");
  ecrire(path.join(P, "docs", "decisions", "0001-format.md"), "# Format\n\nStatut : acceptée\n");
  ecrire(path.join(P, ".atelier", "projet.json"), { titre: "Carnet" });
  const { promptCloser } = await import("./closures.mjs");
  const p = promptCloser({ projet: "carnet", racine: P });
  assert.match(p, /`ETAT\.md`/);
  assert.match(p, /docs\/decisions\//);
  assert.match(p, /\.atelier\/projet\.json/);
  assert.match(p, /close_project\(project="carnet", auto=false/);
  assert.doesNotMatch(p, /projects\/carnet\.json/, "ancien chemin central");
  assert.doesNotMatch(p, /Lis docs\/roles\/closer\.md/, "fichier du dépôt wikichat, introuvable depuis le projet");
  assert.match(p, /Rôle : Closer/, "le rôle est injecté");
});

test("W5 : absorption des clôtures par le code, idempotente", async () => {
  const { state } = await import("./state.mjs");
  const { absorberClotures } = await import("./closures.mjs");
  state.projects.set("Vieux Projet", { name: "Vieux Projet", tasks: new Map(), decisions: [], open_questions: [], blockers: [],
    closure: { documentation: "README", deliverables: "v1", retro: "ok", capitalisation: "Motif de file d'attente réutilisable", closedAt: "2026-05-01T00:00:00Z", closedBy: "x" } });
  const r1 = absorberClotures();
  assert.equal(r1.absorbees, 1);
  const fiche = path.join(W, "knowledge", "closure-vieux-projet.md");
  assert.match(fs.readFileSync(fiche, "utf8"), /# Clôture — Vieux Projet[\s\S]*Motif de file d'attente/);
  assert.equal(absorberClotures().absorbees, 0, "deuxième passage : rien");
  const { chercher } = await import("./connaissance.mjs");
  assert.equal(chercher("file d'attente").resultats[0].sujet, "closure-vieux-projet");
});

// ── Ajout (a) : settings.json à travers le lien ──────────────────────────────

test("(a) les hooks sont écrits dans la cible du lien ~/.claude/settings.json, le lien survit", async (t) => {
  const cibleDir = path.join(RACINE, "work", ".claude");
  const cible = path.join(cibleDir, "settings.json");
  ecrire(cible, { model: "opus" });
  const lien = path.join(MAISON, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(lien), { recursive: true });
  try { fs.symlinkSync(cible, lien, "file"); } catch (err) {
    if (err.code === "EPERM") return t.skip("liens symboliques non permis ici (Windows sans mode développeur) — vérifié sous Linux");
    throw err;
  }
  const { ensureHooks, cibleReelle } = await import("./overlay-installer.mjs");
  assert.equal(cibleReelle(lien), fs.realpathSync(cible));
  assert.equal(ensureHooks(() => {}), "installed");
  assert.ok(fs.lstatSync(lien).isSymbolicLink(), "le lien a été remplacé par un fichier");
  const reglages = lire(cible);
  assert.equal(reglages.model, "opus");
  assert.ok(JSON.stringify(reglages.hooks).includes("wikichat-hook.mjs"));
  // Lien pendant (cible pas encore créée) : on crée la cible, pas un fichier à la place du lien.
  fs.unlinkSync(cible);
  assert.equal(ensureHooks(() => {}), "installed");
  assert.ok(fs.lstatSync(lien).isSymbolicLink());
  assert.ok(fs.existsSync(cible));
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Contre un serveur isolé
// ═════════════════════════════════════════════════════════════════════════════

const MAISON_S = path.join(RACINE, "maison-serveur");
const LANCEMENT = path.join(RACINE, "lancement");        // ancien dossier de lancement, avec des données
const PROJETS_S = path.join(RACINE, "projects-serveur");
const PORT = 3600 + Math.floor(Math.random() * 90);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const WS = path.join(MAISON_S, ".wikichat");
let serveur = null;
const clients = [];

async function client(nom) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
  const transport = new SSEClientTransport(new URL(`${URL_BASE}/sse?agent=${encodeURIComponent(nom)}`));
  const c = new Client({ name: `lot-w-${nom}`, version: "1.0.0" });
  await c.connect(transport);
  clients.push(transport);
  return {
    brut: c,
    async appel(outil, args = {}) {
      const r = await c.callTool({ name: outil, arguments: args });
      return r.content?.map(x => x.text).join("\n") || "";
    },
  };
}

before(async () => {
  // Données « d'avant W2 » sous le dossier de lancement.
  ecrire(path.join(LANCEMENT, ".wikichat", "memories.json"), { "Agent-W2": { souvenir: { value: "repris du dossier de lancement", updatedAt: "2026-09-20T00:00:00Z" } } });
  // Connaissance.
  ecrire(path.join(WS, "knowledge", "grist-axis.md"), "# Axe Grist\n\n## TL;DR\nWidgets Grist standalone.\n");
  // Trois projets : deux partagent un connecteur et des dépendances, le troisième est un projet à fichiers de l'Atelier.
  const A = path.join(PROJETS_S, "lecteur-grist"), B = path.join(PROJETS_S, "grist-appstore"), C = path.join(PROJETS_S, "moteur");
  ecrire(path.join(A, ".mcp.json"), { mcpServers: { grist: { command: "x", env: { SECRET: "ne-pas-lire" } }, wikichat: { type: "sse" } } });
  ecrire(path.join(B, ".mcp.json"), { mcpServers: { grist: { command: "y" }, wikichat: { type: "sse" } } });
  ecrire(path.join(A, "ETAT.md"), "# État — Lecteur Grist\n\nLot courant : L6.\n\n## À décider\n- OIDC\n- Hôte\n");
  ecrire(path.join(A, ".atelier", "projet.json"), { titre: "Lecteur Grist", description: "Lire un document Grist sans serveur." });
  ecrire(path.join(A, "docs", "decisions", "0001-asm.md"), "# asm.js\n\nStatut : acceptée\n");
  ecrire(path.join(C, "ETAT.md"), "# État — Moteur\n\nLot courant : L1.\n");
  ecrire(path.join(WS, "registry.json"), { lastScan: "2026-09-25T00:00:00Z", projects: [
    { slug: "lecteur-grist", name: "lecteur-grist", path: A, status: "discovered", stack: ["node"] },
    { slug: "grist-appstore", name: "Grist-AppStore", path: B, status: "discovered" },
    { slug: "disparu", name: "disparu", path: path.join(RACINE, "nexiste-pas"), status: "missing" },
  ] });
  ecrire(path.join(WS, "clusters", "2026-09-21.json"), { edges: [{ a: "lecteur-grist", b: "grist-appstore", score: 0.52, common_deps: ["grist-plugin-api"] }], clusters: [["lecteur-grist", "grist-appstore"]] });

  serveur = spawn(process.execPath, [path.join(DEPOT, "server.mjs")], {
    cwd: LANCEMENT,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", HOME: MAISON_S, USERPROFILE: MAISON_S,
      WIKICHAT_NO_OVERLAY_INSTALL: "1", WIKICHAT_ATELIER_PROJETS: PROJETS_S, WIKICHAT_AUTONOMOUS_TEAM: "",
      WIKICHAT_CARTOGRAPHIE_CACHE_MS: "0" },
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
  for (const t of clients) await t.close().catch(() => {});
  if (serveur) { serveur.kill(); await attendre(300); }
  try { fs.rmSync(RACINE, { recursive: true, force: true }); } catch { /* Windows : fichiers encore ouverts */ }
});

test("serveur W2 : la mémoire laissée sous le dossier de lancement est reprise au démarrage", async () => {
  const c = await client("Agent-W2");
  const r = await c.appel("recall", { key: "souvenir" });
  assert.match(r, /repris du dossier de lancement/);
  assert.ok(fs.existsSync(path.join(WS, "memories.json")));
  assert.match(serveur.journal, /migration W2/);
});

test("serveur W1 : search_knowledge, GET /api/knowledge et wikichat://kb lisent les mêmes fiches", async () => {
  const c = await client("Lecteur-W1");
  assert.match(await c.appel("search_knowledge", { query: "widgets grist" }), /Axe Grist/);
  const index = await (await fetch(`${URL_BASE}/api/knowledge`)).json();
  assert.ok(index.fiches.some(f => f.sujet === "grist-axis" && f.titre === "Axe Grist"), JSON.stringify(index));
  const texte = await (await fetch(`${URL_BASE}/api/knowledge/grist-axis`)).text();
  assert.match(texte, /Widgets Grist standalone/);
  const recherche = await (await fetch(`${URL_BASE}/api/knowledge?q=widgets`)).json();
  assert.equal(recherche.resultats[0].sujet, "grist-axis");
  const res = await c.brut.readResource({ uri: "wikichat://kb/grist-axis" });
  assert.match(res.contents[0].text, /Widgets Grist standalone/);
  const liste = await c.brut.listResources();
  assert.ok(liste.resources.some(r => r.uri === "wikichat://kb/grist-axis"));
});

test("serveur W4 : GET /api/cartographie respecte le contrat", async () => {
  const c = await client("Cartographe-W4");
  // Relation déclarée : le projet doit être connu de wikichat.
  await c.appel("declare_project", { name: "lecteur-grist", description: "Lecteur" });
  await c.appel("set_project_meta", { project: "lecteur-grist", lifecycle: "active", axes: ["grist"], relations: [{ type: "provides-to", project: "Grist-AppStore", note: "widget" }, { type: "depends-on", project: "inconnu" }] });
  const g = await (await fetch(`${URL_BASE}/api/cartographie`)).json();
  assert.equal(g.version, 1);
  for (const k of ["calcule_le", "sources", "noeuds", "aretes", "groupes", "limites"]) assert.ok(k in g, k);
  const ids = new Set(g.noeuds.map(n => n.id));
  assert.deepEqual([...ids].sort(), ["grist-appstore", "lecteur-grist", "moteur"]);
  assert.equal(g.limites.absents_exclus, 1);
  for (const n of g.noeuds) {
    for (const k of ["id", "nom", "titre", "description", "chemin", "origine", "statut", "cycle_de_vie", "but", "axes", "pile", "github", "instantane", "sante", "etat", "decisions", "cloture", "connecteurs", "atelier"]) {
      assert.ok(k in n, `${n.id}.${k}`);
    }
    assert.equal(n.atelier, null);
  }
  const lg = g.noeuds.find(n => n.id === "lecteur-grist");
  assert.equal(lg.titre, "Lecteur Grist");
  assert.equal(lg.description, "Lire un document Grist sans serveur.");
  assert.equal(lg.cycle_de_vie, "active");
  assert.deepEqual(lg.axes, ["grist"]);
  assert.equal(lg.etat.a_decider, 2);
  assert.equal(lg.decisions, 1);
  assert.deepEqual(lg.connecteurs, ["grist", "wikichat"]);
  assert.ok(!JSON.stringify(g).includes("ne-pas-lire"), "aucune valeur de .mcp.json");
  assert.deepEqual(g.noeuds.find(n => n.id === "moteur").origine, ["atelier"]);
  for (const a of g.aretes) {
    assert.ok(ids.has(a.de) && ids.has(a.vers), a.id);
    assert.ok(["relation", "proximite", "meme_connecteur"].includes(a.type));
    if (!a.oriente) assert.ok(a.de < a.vers, a.id);
  }
  const rel = g.aretes.find(a => a.type === "relation");
  assert.deepEqual([rel.de, rel.vers, rel.sous_type, rel.note], ["lecteur-grist", "grist-appstore", "provides-to", "widget"]);
  assert.equal(g.limites.relations_sans_cible, 1);
  assert.equal(g.aretes.find(a => a.type === "proximite").poids, 0.52);
  const mc = g.aretes.filter(a => a.type === "meme_connecteur");
  assert.equal(mc.length, 1);
  assert.deepEqual(mc[0].connecteurs, ["grist"], "wikichat est un connecteur commun : pas de lien");
  assert.deepEqual(g.groupes, [{ id: "clustering-1", type: "clustering", membres: ["lecteur-grist", "grist-appstore"] }]);
  assert.equal(g.sources.clustering, "2026-09-21");
  const filtre = await (await fetch(`${URL_BASE}/api/cartographie?liens=relation`)).json();
  assert.ok(filtre.aretes.every(a => a.type === "relation"));
});

test("serveur W5 : close_project sur un projet à fichiers — clôture gardée, fiche retrouvée, #library", async () => {
  const c = await client("Closer-test");
  const closure = { documentation: "ETAT.md et docs/", deliverables: "Moteur L1", retro: "RAS", capitalisation: "Découpage en lots courts et vérifiés" };
  const r = await c.appel("close_project", { project: "moteur", auto: false, closure });
  assert.match(r, /clôturé/, r);
  assert.ok(fs.existsSync(path.join(WS, "knowledge", "closure-moteur.md")));
  assert.match(await c.appel("search_knowledge", { query: "lots courts" }), /Clôture — moteur/);
  assert.match(await c.appel("read_messages", { channel: "library", since_minutes: 5 }), /Closure: moteur/);
  assert.match(await c.appel("close_project", { project: "moteur", auto: false, closure }), /déjà clôturé/);
  // Aucun fichier du projet n'a été écrit hors de .wikichat/.
  const fichiers = fs.readdirSync(path.join(PROJETS_S, "moteur"));
  assert.deepEqual(fichiers.filter(f => f !== ".wikichat").sort(), ["ETAT.md"]);
  const g = await (await fetch(`${URL_BASE}/api/cartographie`)).json();
  const moteur = g.noeuds.find(n => n.id === "moteur");
  assert.equal(moteur.cycle_de_vie, "closed");
  assert.equal(moteur.cloture.fiche, "closure-moteur");
});

test("serveur J-b : register_trigger par un agent — désactivé, où l'activer, plafond 24", async () => {
  const c = await client("Agent-JB");
  const r = await c.appel("register_trigger", { id: "jb-test", type: "cron", config: { schedule: "0 3 * * *" }, action_type: "job", action_params: { job: "run_clustering" } });
  assert.match(r, /DÉSACTIVÉ/);
  assert.match(r, /\/pilote/);
  // triggers.json est écrit avec une seconde de délai : on l'attend (3 s au plus).
  let t = null;
  for (let i = 0; i < 30 && !t; i++) {
    try { t = lire(path.join(WS, "triggers.json"))["jb-test"] || null; } catch { /* pas encore écrit */ }
    if (!t) await attendre(100);
  }
  assert.ok(t, "triggers.json ne contient pas jb-test après 3 s");
  assert.equal(t.enabled, false);
  assert.equal(t.max_per_day, 24);
  // La personne l'arme depuis le Pilote.
  const bascule = await (await fetch(`${URL_BASE}/pilote/api/agent/jb-test/toggle`, { method: "POST" })).json();
  assert.equal(bascule.enabled, true);
});
