/**
 * hooks.test.mjs — Hooks Claude Code, identité par conversation, suivi de
 * projet dérivé des fichiers, fils de dialogue.
 *
 * Deux parties :
 *   1. fonctions pures (lecture d'ETAT.md et des décisions, fusion des hooks
 *      dans settings.json) ;
 *   2. bout en bout : un serveur wikichat isolé (port, HOME et dossier propres),
 *      les hooks installés par l'installateur dans un HOME jetable, et un faux
 *      `claude` (src/faux-claude.mjs) qui les déclenche avec des entrées JSON
 *      réelles, comme Claude Code. Latences et tailles injectées sont mesurées.
 *
 * Usage : node --test src/hooks.test.mjs   (MESURES=1 pour le tableau)
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { declencher, texteInjecte } from "./faux-claude.mjs";

const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), "wikichat-hooks-"));
const MAISON = path.join(RACINE, "maison");
const SERVICE = path.join(RACINE, "service");
const PROJETS = path.join(RACINE, "projects");
const PROJET = path.join(PROJETS, "lecteur-grist");
const PORT = 3700 + Math.floor(Math.random() * 90);
const URL_BASE = `http://127.0.0.1:${PORT}`;
for (const d of [MAISON, SERVICE, PROJETS]) fs.mkdirSync(d, { recursive: true });

process.env.WIKICHAT_ATELIER_PROJETS = PROJETS;
const mesures = [];

// ── 1. Fonctions pures ───────────────────────────────────────────────────────

const pf = await import("./projet-fichiers.mjs");
const ETAT = `# État — Lecteur Grist

Lot courant : L6, lecteur servi par racine.
Dernière vérification : 24/09, 212 tests verts.
Prochaine étape : parité des formules.

## À décider
- OIDC ou jeton de widget
- Hôte des widgets
- rien

## Demandé à l'Atelier
- Servir un artefact par \`racine\`

## Fait et vérifié
- L5 : moteur recopié
`;

test("ETAT.md : tête, À décider, Demandé à l'Atelier", () => {
  const e = pf.analyserEtat(ETAT);
  assert.equal(e.titre, "État — Lecteur Grist");
  assert.deepEqual(e.tete.slice(0, 3), ["Lot courant : L6, lecteur servi par racine.", "Dernière vérification : 24/09, 212 tests verts.", "Prochaine étape : parité des formules."]);
  assert.deepEqual(e.aDecider, ["OIDC ou jeton de widget", "Hôte des widgets"]);
  assert.deepEqual(e.demandeAtelier, ["Servir un artefact par `racine`"]);
});

test("décision : numéro, titre, statut, date", () => {
  const d = pf.analyserDecision("0007-asm-js.md", "# 0007 — asm.js plutôt que wasm\n\n- **Statut** : acceptée\n- Date : 2026-09-20\n");
  assert.deepEqual([d.num, d.titre, d.statut, d.date], ["0007", "asm.js plutôt que wasm", "acceptée", "2026-09-20"]);
});

test("fusion des hooks : l'Atelier et les autres hooks gardés, l'ancien hook remplacé, idempotente", async () => {
  const { fusionnerHooks, hooksVoulus } = await import("./overlay-installer.mjs");
  const reglages = {
    model: "opus",
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "node \"/x/wikichat-mailbox-hook.mjs\"" }, { type: "command", command: "echo autre" }] }],
      SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "/home/onyxia/work/bin/atelier-figer-le-travail.sh" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "garde.sh" }] }],
    },
  };
  const voulus = hooksVoulus("/w/scripts/wikichat-hook.mjs", { reveil: true });
  assert.equal(fusionnerHooks(reglages, voulus), true);
  const s = JSON.stringify(reglages);
  assert.ok(!s.includes("wikichat-mailbox-hook"), "ancien hook encore là");
  assert.ok(s.includes("atelier-figer-le-travail.sh"), "SessionEnd de l'Atelier perdu");
  assert.ok(s.includes("echo autre") && s.includes("garde.sh"), "hooks tiers perdus");
  assert.equal(reglages.model, "opus");
  assert.equal(reglages.hooks.SessionEnd.length, 2);
  assert.equal(reglages.hooks.SessionEnd[0].hooks[0].command, "/home/onyxia/work/bin/atelier-figer-le-travail.sh", "l'Atelier doit rester en tête");
  const guet = reglages.hooks.Stop.flatMap(g => g.hooks).find(h => h.command.endsWith(" guetter"));
  assert.equal(guet.asyncRewake, true);
  assert.equal(reglages.hooks.SessionEnd[1].hooks[0].timeout, undefined, "SessionEnd ne doit pas relever le budget de 1,5 s");
  const avant = JSON.stringify(reglages);
  assert.equal(fusionnerHooks(reglages, voulus), false, "deuxième passage : aucun changement");
  assert.equal(JSON.stringify(reglages), avant);
  // Sans guetteur (CLI trop ancien) : l'entrée asyncRewake disparaît.
  assert.equal(fusionnerHooks(reglages, hooksVoulus("/w/scripts/wikichat-hook.mjs", { reveil: false })), true);
  assert.ok(!JSON.stringify(reglages).includes("asyncRewake"));
});

// ── 2. Bout en bout ──────────────────────────────────────────────────────────

let serveur = null;
const clients = [];

async function attendreServeur() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${URL_BASE}/api/health`); if (r.ok) return; } catch { /* */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error("serveur isolé injoignable");
}

before(async () => {
  // Projet de l'Atelier, avec ses fichiers d'état.
  fs.mkdirSync(path.join(PROJET, ".atelier"), { recursive: true });
  fs.mkdirSync(path.join(PROJET, "docs", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(PROJET, "ETAT.md"), ETAT);
  fs.writeFileSync(path.join(PROJET, ".atelier", "projet.json"), JSON.stringify({ titre: "Lecteur Grist", description: "Lire un document Grist sans serveur Grist." }));
  fs.writeFileSync(path.join(PROJET, "docs", "decisions", "0001-asm-js.md"), "# asm.js plutôt que wasm\n\nStatut : acceptée\n");
  fs.writeFileSync(path.join(PROJET, "docs", "decisions", "0002-moteur.md"), "# Moteur gristlabs en sous-processus\n\nStatut : acceptée\n");

  // Réglages existants, comme sur le pod : ancien hook Stop + SessionEnd de l'Atelier.
  fs.mkdirSync(path.join(MAISON, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(MAISON, ".claude", "settings.json"), JSON.stringify({
    model: "opus",
    hooks: {
      Stop: [{ matcher: "", hooks: [{ type: "command", command: `node "${DEPOT.replace(/\\/g, "/")}/scripts/wikichat-mailbox-hook.mjs"` }] }],
      SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: "/home/onyxia/work/bin/atelier-figer-le-travail.sh" }] }],
    },
  }, null, 2));

  // Installation réelle, dans le HOME jetable.
  const inst = spawnSync(process.execPath, ["-e",
    `import(${JSON.stringify("file:///" + path.join(DEPOT, "src", "overlay-installer.mjs").replace(/\\/g, "/"))}).then(m => console.log(JSON.stringify(m.ensureUserOverlay({ log: () => {} }))))`],
  { env: { ...process.env, HOME: MAISON, USERPROFILE: MAISON, WIKICHAT_HOOK_REVEIL: "1", WIKICHAT_NO_OVERLAY_INSTALL: "" }, encoding: "utf8" });
  assert.equal(inst.status, 0, inst.stderr);

  serveur = spawn(process.execPath, [path.join(DEPOT, "server.mjs")], {
    cwd: SERVICE,
    env: {
      ...process.env, PORT: String(PORT), HOST: "127.0.0.1",
      HOME: MAISON, USERPROFILE: MAISON,
      WIKICHAT_NO_OVERLAY_INSTALL: "1", WIKICHAT_ATELIER_PROJETS: PROJETS,
      WIKICHAT_GUET_DELAI_MS: "200",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  serveur.stderr.on("data", () => {});
  await attendreServeur();
});

after(async () => {
  for (const c of clients) { try { await c.close(); } catch { /* */ } }
  if (serveur) serveur.kill();
  await new Promise(r => setTimeout(r, 300));
  try { fs.rmSync(RACINE, { recursive: true, force: true }); } catch { /* */ }
  if (process.env.MESURES === "1" || mesures.length) {
    console.log("\nMesures (processus complet : démarrage de node + appel local) :");
    console.log("| Cas | Hook | Latence (ms) | Injecté (car.) |");
    console.log("|---|---|---|---|");
    for (const m of mesures) console.log(`| ${m.cas} | ${m.hook} | ${m.ms.toFixed(0)} | ${m.taille} |`);
  }
});

const ENV_COMMUN = () => ({ WIKICHAT_URL: URL_BASE });
const estWikichat = (r) => r.commande.includes("wikichat-hook.mjs");

async function hook(cas, evenement, entree, env = {}, valeurMatcher = null) {
  // Hors du test qui lui est consacré, le guetteur (asyncRewake) est coupé :
  // resté en vie d'un cas à l'autre, il remettrait les messages à la place du
  // hook que le cas examine.
  const r = await declencher(MAISON, evenement, entree, { env: { ...ENV_COMMUN(), WIKICHAT_HOOK_REVEIL: "0", ...env }, valeurMatcher });
  const sync = r.sync.filter(estWikichat);
  if (process.env.EXEMPLES === "1") for (const x of sync) console.log(`\n=== ${cas} (${evenement}) ===\n${x.stdout}`);
  for (const x of sync) mesures.push({ cas, hook: `${evenement}${x.commande.endsWith("guetter") ? " (guetteur)" : ""}`, ms: x.ms, taille: texteInjecte(x).length });
  return { ...r, sync };
}

async function mcp(url) {
  const t = new SSEClientTransport(new URL(url));
  const c = new Client({ name: "e2e-hooks", version: "1.0.0" });
  await c.connect(t);
  const o = {
    async call(tool, args = {}) {
      const r = await c.callTool({ name: tool, arguments: args });
      return r.content?.map(x => x.text).join("\n") || "";
    },
    close: () => t.close().catch(() => {}),
  };
  clients.push(o);
  return o;
}

const A = randomUUID(), B = randomUUID();
const NOM_A = `lecteur-grist-${A.replace(/-/g, "").slice(0, 6)}`;
const NOM_B = `lecteur-grist-${B.replace(/-/g, "").slice(0, 6)}`;
const SOUS_DOSSIER = path.join(PROJET, "lecteur");

test("installation : hooks posés, ancien hook retiré, SessionEnd de l'Atelier conservé", () => {
  const s = JSON.parse(fs.readFileSync(path.join(MAISON, ".claude", "settings.json"), "utf8"));
  const tout = JSON.stringify(s.hooks);
  for (const ev of ["session-start", "prompt", " stop", "guetter", "session-end"]) assert.ok(tout.includes(ev), ev);
  assert.ok(!tout.includes("wikichat-mailbox-hook"));
  assert.ok(tout.includes("atelier-figer-le-travail.sh"));
  assert.equal(s.model, "opus");
});

test("SessionStart (VS Code, startup) : identité dérivée de la conversation, projet tiré des fichiers", async () => {
  fs.mkdirSync(SOUS_DOSSIER, { recursive: true });
  const r = await hook("VS Code, startup", "SessionStart", { session_id: A, cwd: SOUS_DOSSIER, source: "startup" }, { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }, "startup");
  assert.equal(r.sync.length, 1);
  const t = texteInjecte(r.sync[0]);
  assert.equal(r.sync[0].sortie.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(t, new RegExp(`Identité wikichat de cette conversation : ${NOM_A} \\(projet lecteur-grist, surface vscode\\)`));
  assert.match(t, /Projet « Lecteur Grist »/);
  assert.match(t, /Lot courant : L6/);
  assert.match(t, /À décider : OIDC ou jeton de widget ; Hôte des widgets/);
  assert.match(t, /0002 Moteur gristlabs en sous-processus \(acceptée\)/);
  assert.ok(t.length <= 2500);
});

test("même conversation dans un tour de l'Atelier : même nom ; reprise sans rien de neuf → rien d'injecté", async () => {
  const r = await hook("Atelier, resume sans nouveauté", "SessionStart", { session_id: A, cwd: PROJET, source: "resume" },
    { WIKICHAT_AGENT: NOM_A, ATELIER_SESSION: A, CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }, "resume");
  assert.equal(r.sync[0].stdout.trim(), "", `rien attendu, reçu : ${r.sync[0].stdout}`);
  const c = await (await fetch(`${URL_BASE}/api/conversations/${A}`)).json();
  assert.equal(c.nom, NOM_A);
  assert.equal(c.surface, "atelier");
});

test("identité commune `atelier` ignorée ; connexion MCP de la conversation nommée d'après elle", async () => {
  const r = await hook("terminal, startup", "SessionStart", { session_id: B, cwd: PROJET, source: "startup" },
    { WIKICHAT_AGENT: "atelier", CLAUDE_CODE_ENTRYPOINT: "cli" }, "startup");
  const t = texteInjecte(r.sync[0]);
  assert.match(t, new RegExp(`: ${NOM_B} \\(projet lecteur-grist, surface terminal\\)`));
  assert.match(t, new RegExp(`Présents sur ce projet : ${NOM_A}`));
  const b = await mcp(`${URL_BASE}/sse?agent=atelier&claude_session=${B}`);
  const sessions = await b.call("list_sessions");
  assert.match(sessions, new RegExp(NOM_B));
});

test("message pour info : pas de relance en fin de tour, remis au prompt suivant, marqué lu", async () => {
  const b = clients[0];
  const env = await b.call("send_message", { channel: `@${NOM_A}`, content: "Pour info : parité des dates corrigée." });
  assert.match(env, /Fil f-[0-9a-f]{6}/);
  const s = await hook("Stop, message pour info", "Stop", { session_id: A, cwd: PROJET, stop_hook_active: false }, { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" });
  assert.equal(s.sync[0].stdout.trim(), "", "un message pour info ne doit pas relancer");
  const p = await hook("UserPromptSubmit, 1 message", "UserPromptSubmit", { session_id: A, cwd: PROJET, prompt: "continue" }, { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" });
  const t = texteInjecte(p.sync[0]);
  assert.equal(p.sync[0].sortie.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(t, /parité des dates corrigée/);
  assert.match(t, new RegExp(NOM_B));
  const p2 = await hook("UserPromptSubmit, rien de neuf", "UserPromptSubmit", { session_id: A, cwd: PROJET, prompt: "encore" }, {});
  assert.equal(p2.sync[0].stdout.trim(), "", "rien de neuf : rien d'injecté");
  const fils = await (await fetch(`${URL_BASE}/api/fils?session=${B}&statut=tous`)).json();
  const dernier = fils.fils[0].messages.at(-1);
  assert.deepEqual(dernier.lu_par, [NOM_A]);
});

test("réponse attendue : relance visible, plafonnée à 3", async () => {
  const b = clients[0];
  for (let i = 1; i <= 4; i++) {
    await b.call("send_message", { channel: `@${NOM_A}`, content: `Question ${i} : tu valides ?`, expects_reply: true, status: "over" });
    const s = await hook(`Stop, réponse attendue (${i})`, "Stop", { session_id: A, cwd: PROJET, stop_hook_active: i > 1 }, {});
    if (i <= 3) {
      assert.equal(s.sync[0].sortie?.decision, "block", `relance ${i} attendue`);
      assert.match(s.sync[0].sortie.systemMessage, new RegExp(`réponse attendue par ${NOM_B} \\(relance ${i}/3\\)`));
      assert.match(s.sync[0].sortie.reason, new RegExp(`Question ${i}`));
    } else {
      assert.equal(s.sync[0].stdout.trim(), "", "au-delà de 3 relances : plus de blocage");
    }
  }
  // Le message non remis arrive au prompt suivant, et le compteur repart.
  const p = await hook("UserPromptSubmit après plafond", "UserPromptSubmit", { session_id: A, cwd: PROJET, prompt: "ok" }, {});
  assert.match(texteInjecte(p.sync[0]), /Question 4/);
});

test("fil : réponse par reply_to, puis clôture par status=done", async () => {
  const b = clients[0];
  const a = await mcp(`${URL_BASE}/sse?agent=atelier&claude_session=${A}`);
  const envoi = await b.call("send_message", { channel: `@${NOM_A}`, content: "Tu prends la parité ?", expects_reply: true, reply_by_seconds: 600 });
  const id = /🆔 ([0-9a-f]{8})/.exec(envoi)[1];
  let f = await (await fetch(`${URL_BASE}/api/fils?session=${A}`)).json();
  assert.deepEqual(f.fils[0].attend, [NOM_A]);
  assert.ok(f.fils[0].echeance);
  await a.call("send_message", { channel: `@${NOM_B}`, content: "Oui, je la prends.", reply_to: id });
  f = await (await fetch(`${URL_BASE}/api/fils?session=${A}`)).json();
  assert.deepEqual(f.fils[0].attend, [], "la réponse solde la dette");
  const liste = await a.call("list_threads");
  assert.match(liste, /rien d'attendu/);
  await a.call("send_message", { channel: `@${NOM_B}`, content: "Fait.", reply_to: id, status: "done" });
  f = await (await fetch(`${URL_BASE}/api/fils?session=${A}&statut=clos`)).json();
  assert.equal(f.fils[0].statut, "clos");
});

test("guetteur natif : réveil (code 2) sur réponse attendue ; remplacé par le suivant ; absent d'un tour de l'Atelier", async () => {
  // Deux fins de tour : le second guetteur remplace le premier.
  const r1 = await declencher(MAISON, "Stop", { session_id: A, cwd: PROJET, stop_hook_active: false }, { env: ENV_COMMUN() });
  const g1 = r1.async[0];
  await new Promise(r => setTimeout(r, 600));
  const r2 = await declencher(MAISON, "Stop", { session_id: A, cwd: PROJET, stop_hook_active: false }, { env: ENV_COMMUN() });
  const g2 = r2.async[0];
  const fin1 = await Promise.race([g1, new Promise(r => setTimeout(() => r(null), 5000))]);
  assert.ok(fin1, "le premier guetteur doit s'arrêter quand un second prend le relais");
  assert.equal(fin1.code, 0);
  await new Promise(r => setTimeout(r, 600));
  const t0 = Date.now();
  await clients[0].call("send_message", { channel: `@${NOM_A}`, content: "Réveille-toi : revue demandée.", expects_reply: true });
  const fin2 = await Promise.race([g2, new Promise(r => setTimeout(() => r(null), 5000))]);
  assert.ok(fin2, "le guetteur doit réveiller la session");
  assert.equal(fin2.code, 2);
  assert.match(fin2.stderr, /revue demandée/);
  mesures.push({ cas: "réveil après envoi", hook: "Stop (guetteur)", ms: Date.now() - t0, taille: fin2.stderr.length });
  // Tour de l'Atelier : pas de guetteur.
  const r3 = await declencher(MAISON, "Stop", { session_id: A, cwd: PROJET, stop_hook_active: false }, { env: { ...ENV_COMMUN(), ATELIER_SESSION: A, WIKICHAT_AGENT: NOM_A } });
  const fin3 = await Promise.race([r3.async[0], new Promise(r => setTimeout(() => r(null), 3000))]);
  assert.ok(fin3 && fin3.code === 0 && !fin3.stderr, "aucun guetteur dans un tour de l'Atelier");
});

test("compact : identité et projet réinjectés ; ETAT.md modifié signalé au prompt suivant", async () => {
  const c = await hook("compact", "SessionStart", { session_id: A, cwd: PROJET, source: "compact" }, {}, "compact");
  const t = texteInjecte(c.sync[0]);
  assert.match(t, new RegExp(`Identité wikichat de cette conversation : ${NOM_A}`));
  assert.match(t, /Lot courant : L6/);
  await new Promise(r => setTimeout(r, 30));
  fs.writeFileSync(path.join(PROJET, "ETAT.md"), ETAT.replace("Lot courant : L6", "Lot courant : L7, parité"));
  const p = await hook("UserPromptSubmit, ETAT modifié", "UserPromptSubmit", { session_id: A, cwd: PROJET, prompt: "suite" }, {});
  assert.match(texteInjecte(p.sync[0]), /ETAT\.md du projet a changé .*Lot courant : L7/);
  const r = await hook("Atelier, resume après modification", "SessionStart", { session_id: A, cwd: PROJET, source: "resume" }, { WIKICHAT_AGENT: NOM_A, ATELIER_SESSION: A }, "resume");
  assert.equal(r.sync[0].stdout.trim(), "", "déjà signalé : pas de réinjection à la reprise");
});

test("project_state et add_project_note : lus dans les fichiers, rien d'écrit dans le projet", async () => {
  const a = clients[1];
  const avant = fs.readdirSync(PROJET).sort();
  const note = await a.call("add_project_note", { project: "lecteur-grist", content: "Le jeton de widget reste en lecture seule.", type: "decision" });
  assert.match(note, /docs\/decisions\/NNNN/);
  assert.deepEqual(fs.readdirSync(PROJET).sort(), avant, "wikichat ne doit rien créer dans le projet");
  assert.ok(!fs.existsSync(path.join(PROJET, ".wikichat", "project-state.json")));
  const etat = await a.call("project_state", {});
  assert.match(etat, /Projet « Lecteur Grist »/);
  assert.match(etat, /Lot courant : L7/);
  assert.match(etat, /\[decision\] .*jeton de widget/);
  const api = await (await fetch(`${URL_BASE}/api/projets/etat?cwd=${encodeURIComponent(SOUS_DOSSIER)}`)).json();
  assert.equal(api.slug, "lecteur-grist");
  assert.equal(api.titre, "Lecteur Grist");
  assert.equal(api.decisions.length, 2);
  assert.ok(api.presents.includes(NOM_A));
});

test("SessionEnd : hors ligne ; conversation retrouvée par son nom et son alias", async () => {
  const e = await hook("SessionEnd", "SessionEnd", { session_id: B, cwd: PROJET, reason: "prompt_input_exit" }, {}, "prompt_input_exit");
  assert.equal(e.sync[0].stdout.trim(), "");
  const c = await (await fetch(`${URL_BASE}/api/conversations/${B}`)).json();
  assert.equal(c.en_ligne, false);
  // L'Atelier adopte B sous un autre nom : l'ancien devient alias.
  const adoption = await hook("Atelier adopte B", "SessionStart", { session_id: B, cwd: PROJET, source: "resume" }, { WIKICHAT_AGENT: "lecteur-grist-adopte", ATELIER_SESSION: "zz" }, "resume");
  const texteAdoption = texteInjecte(adoption.sync[0]);
  assert.match(texteAdoption, new RegExp(`Anciennement ${NOM_B}`));
  assert.ok(!/Question 1/.test(texteAdoption), "ses propres messages, écrits sous l'ancien nom, ne lui sont pas remis");
  const c2 = await (await fetch(`${URL_BASE}/api/conversations/${B}`)).json();
  assert.equal(c2.nom, "lecteur-grist-adopte");
  assert.deepEqual(c2.alias, [NOM_B]);
  const envoi = await clients[1].call("send_message", { channel: `@${NOM_B}`, content: "Toujours là ?" });
  assert.match(envoi, /résolu vers lecteur-grist-adopte/);
});

test("temps de réponse du serveur seul (sans démarrage de node)", async () => {
  const corps = (entree) => JSON.stringify({ entree, env: {} });
  for (const [ev, entree] of [
    ["session-start", { session_id: A, cwd: PROJET, source: "compact" }],
    ["prompt", { session_id: A, cwd: PROJET, prompt: "x" }],
    ["stop", { session_id: A, cwd: PROJET, stop_hook_active: false }],
  ]) {
    const t0 = performance.now();
    const r = await fetch(`${URL_BASE}/api/hooks/${ev}`, { method: "POST", headers: { "content-type": "application/json" }, body: corps(entree) });
    const ms = performance.now() - t0;
    await r.json();
    mesures.push({ cas: `serveur seul (traitement ${r.headers.get("x-wikichat-ms")} ms)`, hook: ev, ms, taille: 0 });
    assert.ok(ms < 500, `${ev} : ${ms} ms`);
  }
});

test("serveur absent : le hook ne dit rien, sort en 0, vite", async () => {
  const r = await declencher(MAISON, "UserPromptSubmit", { session_id: A, cwd: PROJET, prompt: "x" }, { env: { WIKICHAT_URL: "http://127.0.0.1:9" } });
  const x = r.sync.find(estWikichat);
  assert.equal(x.code, 0);
  assert.equal(x.stdout, "");
  assert.ok(x.ms < 3000, `${x.ms} ms`);
  mesures.push({ cas: "serveur absent", hook: "UserPromptSubmit", ms: x.ms, taille: 0 });
});
