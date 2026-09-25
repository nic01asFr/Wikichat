/**
 * lancement.test.mjs — Ce que wikichat donne à un processus qu'il lance.
 *
 * Trois défauts réels, chacun vérifié ici :
 *  - `.mcp.json` du projet créé ou « complété » par wikichat, jusqu'à produire
 *    une entrée `{enabled, headersHelper}` sans url ni command ;
 *  - `--permission-mode bypassPermissions` codé en dur ;
 *  - processus lancés sans les secrets de `~/work/.secrets/claude-env.sh`.
 *
 * La partie intégration lance spawnHeadless() contre un faux `claude` qui
 * consigne ses arguments, son environnement et sa configuration MCP. Tout se
 * passe dans un dossier temporaire : HOME, cwd du service, projet.
 *
 * Usage : node --test src/lancement.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

// ── Bac à sable : AVANT tout import de sampler (chemins figés au chargement) ──
const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), "wikichat-lancement-"));
const MAISON = path.join(RACINE, "maison");
const SERVICE = path.join(RACINE, "service");
const PROJET = path.join(RACINE, "projet");
const FAUX_BIN = path.join(RACINE, "bin");
const CONFIGS = path.join(RACINE, "configs-mcp");
const SORTIE = path.join(RACINE, "sortie-claude.json");
const FICHIER_ENV = path.join(MAISON, "work", ".secrets", "claude-env.sh");
for (const d of [MAISON, SERVICE, PROJET, FAUX_BIN, path.dirname(FICHIER_ENV)]) fs.mkdirSync(d, { recursive: true });

process.env.HOME = MAISON;
process.env.USERPROFILE = MAISON;
process.env.WIKICHAT_MCP_TMP = CONFIGS;
process.env.FAUX_CLAUDE_SORTIE = SORTIE;
delete process.env.WIKICHAT_FICHIER_ENV;
delete process.env.WIKICHAT_LANCEUR;
process.chdir(SERVICE);

// Faux `claude` : consigne ce qu'il reçoit, répond comme `--output-format json`.
const SCRIPT = path.join(FAUX_BIN, "faux-claude.mjs");
fs.writeFileSync(SCRIPT, `#!/usr/bin/env node
import fs from "fs";
const argv = process.argv.slice(2);
const i = argv.indexOf("--mcp-config");
const mcp = i >= 0 ? JSON.parse(fs.readFileSync(argv[i + 1], "utf8")) : null;
fs.writeFileSync(process.env.FAUX_CLAUDE_SORTIE, JSON.stringify({
  argv, mcp, cwd: process.cwd(),
  env: {
    WIKICHAT_AGENT: process.env.WIKICHAT_AGENT,
    ATELIER_MCP_JETON: process.env.ATELIER_MCP_JETON,
    ATELIER_MCP_NU: process.env.ATELIER_MCP_NU,
  },
}));
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "sess-faux-123" }));
`);
if (process.platform === "win32") {
  fs.writeFileSync(path.join(FAUX_BIN, "claude.cmd"), `@node "%~dp0faux-claude.mjs" %*\r\n`);
} else {
  fs.copyFileSync(SCRIPT, path.join(FAUX_BIN, "claude"));
  fs.chmodSync(path.join(FAUX_BIN, "claude"), 0o755);
}
process.env.PATH = FAUX_BIN + path.delimiter + (process.env.PATH || "");

const L = await import("./lancement.mjs");
const { spawnHeadless } = await import("./sampler.mjs");
const { recall } = await import("./identity.mjs");
const { modeDeLaDefinition } = await import("./routines.mjs");

function lireSortie() {
  const s = JSON.parse(fs.readFileSync(SORTIE, "utf8"));
  fs.unlinkSync(SORTIE);
  return s;
}
function valeurApres(argv, drapeau) {
  const i = argv.indexOf(drapeau);
  return i >= 0 ? argv[i + 1] : undefined;
}
function dansLeProjet(p) {
  const rel = path.relative(PROJET, p);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

// ── 3. Mode de permission ────────────────────────────────────────────────────

test("mode par défaut : acceptEdits", () => {
  assert.equal(L.resoudreModePermission({}).mode, "acceptEdits");
  assert.equal(L.MODE_PERMISSION_DEFAUT, "acceptEdits");
});

test("un mode explicite est retenu (paramètre routine/trigger/spawn)", () => {
  assert.equal(L.resoudreModePermission({ permission_mode: "plan" }).mode, "plan");
  assert.equal(L.resoudreModePermission({ permissionMode: "default" }).mode, "default");
});

test("bypassPermissions refusé hors définition de routine ou de déclencheur", () => {
  const r = L.resoudreModePermission({ permission_mode: "bypassPermissions" });
  assert.equal(r.mode, "acceptEdits");
  assert.match(r.avertissement, /bypassPermissions ignoré/);
});

test("bypassPermissions honoré quand la définition le demande", () => {
  const r = L.resoudreModePermission({ permission_mode: "bypassPermissions", bypassAutorise: true });
  assert.equal(r.mode, "bypassPermissions");
});

test("mode inconnu : retombe sur acceptEdits", () => {
  const r = L.resoudreModePermission({ permission_mode: "yolo" });
  assert.equal(r.mode, "acceptEdits");
  assert.ok(r.avertissement);
});

test("outils pré-autorisés : wikichat et .wikichat/ par défaut, liste de l'appelant respectée", () => {
  assert.deepEqual(L.outilsAutorises(null, "acceptEdits"), ["mcp__wikichat", "Write(.wikichat/**)", "Edit(.wikichat/**)"]);
  assert.deepEqual(L.outilsAutorises(["Read", "Bash"], "acceptEdits"), ["Read", "Bash"]);
  assert.deepEqual(L.outilsAutorises("Read, Grep", "acceptEdits"), ["Read", "Grep"]);
  assert.equal(L.outilsAutorises(null, "bypassPermissions"), null);
});

test("routine : le mode vient de la définition, jamais d'un paramètre interpolé", () => {
  assert.equal(modeDeLaDefinition({ permission_mode: "bypassPermissions" }, { params: {} }), "bypassPermissions");
  assert.equal(modeDeLaDefinition({ permission_mode: "plan" }, { params: { permission_mode: "default" } }), "default");
  assert.equal(modeDeLaDefinition({}, { params: { permission_mode: "{mode}" } }), null);
  assert.equal(modeDeLaDefinition({}, { params: {} }), null);
});

// ── 2. Connexion MCP ─────────────────────────────────────────────────────────

test("une entrée sans url ni command n'est pas utilisable", () => {
  assert.equal(L.entreeMcpUtilisable({ enabled: true, headersHelper: "node x" }), false);
  assert.equal(L.entreeMcpUtilisable({ enabled: true }), false);
  assert.equal(L.entreeMcpUtilisable({ type: "sse", url: "http://127.0.0.1:3777/sse" }), true);
  assert.equal(L.entreeMcpUtilisable({ command: "node", args: [] }), true);
});

test("configuration temporaire : hors du projet, complète, identité dans l'URL", () => {
  const f = L.ecrireConfigMcpTemporaire({ name: "Agent Test/1", port: 3999, projectPath: PROJET });
  try {
    assert.ok(!dansLeProjet(f), `écrite dans le projet : ${f}`);
    const conf = JSON.parse(fs.readFileSync(f, "utf8"));
    const wc = conf.mcpServers.wikichat;
    assert.ok(L.entreeMcpUtilisable(wc));
    assert.equal(wc.url, "http://127.0.0.1:3999/sse?agent=Agent%20Test%2F1");
    assert.equal(Object.keys(conf.mcpServers).length, 1);
  } finally { L.supprimerConfigMcp(f); }
  assert.equal(fs.existsSync(f), false);
});

test("configuration temporaire refusée si son dossier est dans le projet", () => {
  const avant = process.env.WIKICHAT_MCP_TMP;
  process.env.WIKICHAT_MCP_TMP = path.join(PROJET, "tmp");
  try {
    assert.throws(() => L.ecrireConfigMcpTemporaire({ name: "x", projectPath: PROJET }), /dans le projet/);
    assert.deepEqual(L.argumentsMcp({ name: "x", projectPath: PROJET }).args, []);
  } finally { process.env.WIKICHAT_MCP_TMP = avant; }
  assert.equal(fs.existsSync(path.join(PROJET, "tmp")), false);
});

// ── 5. Environnement ─────────────────────────────────────────────────────────

test("fichier d'environnement absent : aucune variable ajoutée", () => {
  assert.deepEqual(L.chargerEnvSecrets(path.join(RACINE, "absent.sh")), {});
});

test("fichier d'environnement sourcé : variables exportées et affectations nues", () => {
  const f = path.join(RACINE, "env-test.sh");
  fs.writeFileSync(f, "# généré par l'Atelier\nexport ATELIER_MCP_A='valeur avec espaces'\nATELIER_MCP_B=deux\n");
  const vars = L.chargerEnvSecrets(f);
  assert.equal(vars.ATELIER_MCP_A, "valeur avec espaces");
  assert.equal(vars.ATELIER_MCP_B, "deux");
  assert.equal(vars.PATH, undefined, "ne rend que ce que le fichier ajoute");
});

test("environnement enfant : secrets, puis identité en dernier", () => {
  fs.writeFileSync(FICHIER_ENV, "export ATELIER_MCP_JETON=s3cr3t\nWIKICHAT_AGENT=usurpe\n");
  const env = L.environnementEnfant("Vrai-Nom");
  assert.equal(env.ATELIER_MCP_JETON, "s3cr3t");
  assert.equal(env.WIKICHAT_AGENT, "Vrai-Nom");
  assert.equal(env.NO_COLOR, "1");
});

// ── Intégration : spawnHeadless contre un faux claude ────────────────────────

const shDisponible = spawnSync("sh", ["-c", "true"]).status === 0;

test("spawnHeadless : ni .mcp.json ni réglages créés dans le projet", async () => {
  fs.writeFileSync(FICHIER_ENV, "export ATELIER_MCP_JETON=jeton-de-test\nATELIER_MCP_NU=nu\n");
  const r = await spawnHeadless(PROJET, "tâche de test", { name: "Testeur-A", timeoutMs: 30000 });
  assert.equal(r.success, true, r.stderr);
  const s = lireSortie();

  assert.equal(fs.existsSync(path.join(PROJET, ".mcp.json")), false, ".mcp.json créé dans le projet");
  assert.equal(fs.existsSync(path.join(PROJET, ".claude")), false, ".claude/ créé dans le projet");

  // Connexion wikichat : fichier temporaire hors projet, sans --strict-mcp-config
  const conf = valeurApres(s.argv, "--mcp-config");
  assert.ok(conf, "--mcp-config absent");
  assert.ok(!dansLeProjet(conf));
  assert.ok(!s.argv.includes("--strict-mcp-config"));
  assert.match(s.mcp.mcpServers.wikichat.url, /\/sse\?agent=Testeur-A$/);
  assert.equal(fs.existsSync(conf), false, "configuration temporaire non supprimée");

  // Mode : acceptEdits par défaut, jamais bypass
  assert.equal(valeurApres(s.argv, "--permission-mode"), "acceptEdits");
  assert.ok(!s.argv.includes("bypassPermissions"));
  assert.match(valeurApres(s.argv, "--allowedTools"), /mcp__wikichat/);

  // Environnement : secrets du fichier unique + identité
  assert.equal(s.env.WIKICHAT_AGENT, "Testeur-A");
  assert.equal(s.env.ATELIER_MCP_JETON, "jeton-de-test");
  if (shDisponible) assert.equal(s.env.ATELIER_MCP_NU, "nu");

  // Session mémorisée par wikichat (plus besoin de register)
  assert.equal(r.sessionId, "sess-faux-123");
  assert.equal(recall("Testeur-A", "__claude_session_id"), "sess-faux-123");
});

test("spawnHeadless : un .mcp.json existant, même incomplet, n'est jamais touché", async () => {
  const mcp = path.join(PROJET, ".mcp.json");
  const brut = JSON.stringify({ mcpServers: { wikichat: { enabled: true } } }, null, 2);
  fs.writeFileSync(mcp, brut);
  try {
    const r = await spawnHeadless(PROJET, "tâche", { name: "Testeur-B", timeoutMs: 30000 });
    assert.equal(r.success, true, r.stderr);
    lireSortie();
    assert.equal(fs.readFileSync(mcp, "utf8"), brut, ".mcp.json du projet modifié");
    assert.equal(fs.existsSync(path.join(PROJET, ".claude")), false);
  } finally { fs.unlinkSync(mcp); }
});

test("spawnHeadless : bypass demandé par un appel ad hoc → acceptEdits", async () => {
  const r = await spawnHeadless(PROJET, "tâche", { name: "Testeur-C", permission_mode: "bypassPermissions", timeoutMs: 30000 });
  assert.equal(r.success, true, r.stderr);
  const s = lireSortie();
  assert.equal(valeurApres(s.argv, "--permission-mode"), "acceptEdits");
});

test("spawnHeadless : bypass déclaré par une définition → bypassPermissions", async () => {
  const r = await spawnHeadless(PROJET, "tâche", {
    name: "Testeur-D", permission_mode: "bypassPermissions", bypassAutorise: true, timeoutMs: 30000,
  });
  assert.equal(r.success, true, r.stderr);
  const s = lireSortie();
  assert.equal(valeurApres(s.argv, "--permission-mode"), "bypassPermissions");
  assert.equal(valeurApres(s.argv, "--allowedTools"), undefined);
});

test("spawnHeadless : mode plan transmis tel quel", async () => {
  const r = await spawnHeadless(PROJET, "tâche", { name: "Testeur-E", permission_mode: "plan", timeoutMs: 30000 });
  assert.equal(r.success, true, r.stderr);
  assert.equal(valeurApres(lireSortie().argv, "--permission-mode"), "plan");
});

test.after(() => {
  process.chdir(os.tmpdir());
  try { fs.rmSync(RACINE, { recursive: true, force: true }); } catch { /* Windows : fichier encore ouvert */ }
});
