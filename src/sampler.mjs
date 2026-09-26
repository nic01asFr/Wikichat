/**
 * sampler.mjs — Service-initiated session spawning and sampling.
 *
 * Two modes:
 *
 *  spawnHeadless(projectPath, prompt, options)
 *    → Runs `claude -p "<prompt>"` in non-interactive mode inside projectPath.
 *      The spawned process reads CLAUDE.md + .wikichat/instructions.md,
 *      connects to WikiChat MCP (via --mcp-config of a temporary file),
 *      executes its task, and exits. stdout is captured and returned.
 *      Best for: cron-triggered audits, one-shot tasks, automated reports.
 *
 *  sampleSession(sessionName, prompt, context, transports)
 *    → Sends a MCP sampling/createMessage request to an already-connected session.
 *      Falls back to spawnHeadless if no live session found.
 *      Best for: asking a long-running agent to do something.
 *
 * Safety: this module NEVER writes the project's .mcp.json, .claude/ settings
 *         or CLAUDE.md. Its own MCP connection goes through `--mcp-config` of a
 *         temporary file outside the project (see src/lancement.mjs).
 */

import { CHEMINS, DEPOT } from "./chemins.mjs";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { upsertSpawnRegistry } from "./persistence.mjs";
import { randomUUID } from "crypto";
import { state } from "./state.mjs";
import { recall, remember } from "./identity.mjs";
import {
  resoudreModePermission, outilsAutorises, argumentsMcp, supprimerConfigMcp, environnementEnfant,
} from "./lancement.mjs";
import { lanceurActif, lancerParAtelier, configAtelier } from "./lanceur-atelier.mjs";

// ── Global respawn rate limiter ───────────────────────────────────────────────
let _activeRespawns = 0;
const MAX_CONCURRENT_RESPAWNS = 3;

// ── Resource budget — global ceiling on live + spawning sessions ──────────────
const MAX_SESSIONS = parseInt(process.env.WIKICHAT_MAX_SESSIONS || "30");
/**
 * Bornage d'un daemon, en TOURS et non en dollars.
 *
 * Les agents tournent sur l'abonnement Claude Code, pas sur l'API : un plafond
 * `--max-budget-usd` n'y correspond à aucune facturation. Il donnait l'illusion
 * d'une garde-fou tout en bornant sur une grandeur qui n'existe pas ici.
 *
 * Ce qui coûte réellement, c'est le nombre de tours : une veille en boucle relit
 * tout son historique à chaque passage, donc la dépense croît de façon
 * quadratique. C'est cette grandeur-là qu'on borne.
 */
const MAX_TOURS_DAEMON = parseInt(process.env.WIKICHAT_DAEMON_MAX_TURNS || "50");
/**
 * Borne d'un daemon en TEMPS MURAL — la seule qui fonctionne réellement.
 *
 * `--max-turns` n'existe ni en Claude Code 2.1.86 (poste local) ni en 2.1.237
 * (pod SSPCloud) : le CLI l'ignore en silence, sans erreur ni code de retour.
 * `--max-budget-usd` existe mais ne borne rien sur abonnement, où le coût
 * remonté vaut zéro. Les deux plafonds délégués au CLI sont donc inertes, et
 * `spawnDaemon` n'avait par ailleurs aucune minuterie — contrairement à
 * `spawnHeadless`. Un daemon n'était en pratique borné par rien.
 *
 * Le temps mural, lui, est mesurable ici et ne dépend d'aucune version. On
 * garde `--max-turns` — inoffensif s'il est ignoré, utile s'il est un jour
 * reconnu — mais on ne compte plus dessus.
 */
const MAX_DUREE_DAEMON_MS = parseInt(process.env.WIKICHAT_DAEMON_MAX_MS || `${30 * 60 * 1000}`);
let _pendingSpawns = 0; // processes spawned but not yet MCP-connected

/** Count current load: named MCP sessions + processes still booting.
 *  Anonymous sessions (name starts with "session-") are excluded — they are
 *  transient IDE/browser connections that should not consume spawn budget. */
export function currentLoad() {
  const namedCount = [...state.sessions.values()].filter(
    s => s.name && !s.name.startsWith("session-")
  ).length;
  return namedCount + _pendingSpawns;
}

/**
 * Check if a new spawn fits the budget.
 * Returns null if OK, or an error object {error, current, max} if over.
 */
export function checkBudget() {
  const current = currentLoad();
  if (current >= MAX_SESSIONS) {
    return {
      error: `Budget atteint: ${current}/${MAX_SESSIONS} sessions actives. Augmentez WIKICHAT_MAX_SESSIONS ou attendez qu'une session se libère.`,
      current,
      max: MAX_SESSIONS,
    };
  }
  return null;
}

function _claimSlot() { _pendingSpawns++; }
function _releaseSlot() { if (_pendingSpawns > 0) _pendingSpawns--; }

// ── Quotas par owner ──────────────────────────────────────────────────────────
// Map<ownerName, { dailyCount, concurrent, dayStartedAt }>
// Caps :
//   - subagents/projets : 50/jour, 5 concurrent
//   - principal/résidents : 200/jour, 15 concurrent
//   - wikichat-service / trigger:*  : illimité
const _quotas = new Map();
const PRINCIPAL_NAMES = new Set();
const RESIDENT_PREFIXES = ["trigger:", "wikichat-"];
const DAY_MS = 24 * 60 * 60 * 1000;

function _isService(owner) {
  if (!owner) return false;
  return RESIDENT_PREFIXES.some(p => owner.startsWith(p));
}

function _isPrincipalOrResident(owner) {
  if (!owner) return false;
  const principal = process.env.WIKICHAT_PRINCIPAL_AGENT || "Claude-Code";
  if (owner === principal) return true;
  PRINCIPAL_NAMES.add(principal);
  // Résidents canoniques (Sentinel/Librarian/Orchestrator)
  return ["Sentinel", "Librarian", "Orchestrator"].includes(owner);
}

function _capsFor(owner) {
  if (_isService(owner)) return { daily: Infinity, concurrent: Infinity };
  if (_isPrincipalOrResident(owner)) return { daily: 200, concurrent: 15 };
  return { daily: 50, concurrent: 5 };
}

function _ownerEntry(owner) {
  let e = _quotas.get(owner);
  if (!e) { e = { dailyCount: 0, concurrent: 0, dayStartedAt: Date.now() }; _quotas.set(owner, e); }
  // Rolling 24h window reset
  if (Date.now() - e.dayStartedAt > DAY_MS) {
    e.dailyCount = 0;
    e.dayStartedAt = Date.now();
  }
  return e;
}

/**
 * Check if an owner can spawn now. Returns null if OK, or {error, owner, daily, concurrent, caps}.
 */
export function checkOwnerQuota(owner) {
  if (!owner) return null;
  const caps = _capsFor(owner);
  const e = _ownerEntry(owner);
  if (e.dailyCount >= caps.daily) {
    return { error: `Quota quotidien atteint pour ${owner}: ${e.dailyCount}/${caps.daily}`, owner, daily: e.dailyCount, caps };
  }
  if (e.concurrent >= caps.concurrent) {
    return { error: `Quota concurrent atteint pour ${owner}: ${e.concurrent}/${caps.concurrent} actifs`, owner, concurrent: e.concurrent, caps };
  }
  return null;
}

function _claimQuota(owner) {
  if (!owner) return;
  const e = _ownerEntry(owner);
  e.dailyCount++;
  e.concurrent++;
}
function _releaseQuota(owner) {
  if (!owner) return;
  const e = _ownerEntry(owner);
  if (e.concurrent > 0) e.concurrent--;
}

export function quotaSnapshot() {
  return [..._quotas.entries()].map(([owner, e]) => ({
    owner, daily: e.dailyCount, concurrent: e.concurrent, caps: _capsFor(owner),
  }));
}

// ── Profondeur de spawn ──────────────────────────────────────────────────────
const MAX_SPAWN_DEPTH = parseInt(process.env.WIKICHAT_MAX_SPAWN_DEPTH || "3");
export function getMaxSpawnDepth() { return MAX_SPAWN_DEPTH; }
export function checkDepth(parentDepth) {
  const depth = (parentDepth ?? 0) + 1;
  if (depth > MAX_SPAWN_DEPTH) {
    return { error: `Profondeur de spawn maximum atteinte (${depth} > ${MAX_SPAWN_DEPTH}). Refactorer en plus plat ou augmenter WIKICHAT_MAX_SPAWN_DEPTH.`, depth };
  }
  return { depth };
}

// ── Claude CLI location ────────────────────────────────────────────────────────

/**
 * Emplacements connus du binaire, PUIS le PATH.
 *
 * La liste ne contenait que `~/.local/bin/claude.exe` — avec l'extension
 * Windows — et omettait `~/.local/bin/claude`, qui est le chemin
 * d'installation standard sous Linux. Les trois dernières entrées (`claude.exe`,
 * `claude.cmd`, `claude`) ne servaient à rien non plus : `fs.accessSync("claude")`
 * résout relativement au répertoire courant, jamais au PATH. Un poste où le
 * binaire n'existe que dans le PATH — via nvm par exemple — ne le trouvait donc
 * jamais.
 *
 * Signalé en spécification vérifiable par l'agent du pod SSPCloud, dont
 * l'installation est en `~/.nvm/versions/node/v22.23.2/bin/claude`.
 */
const CLAUDE_CANDIDATES = [
  path.join(os.homedir(), "work", "bin", "claude"), // SSP Cloud / Atelier pod
  path.join(os.homedir(), ".local", "bin", "claude.exe"),
  path.join(os.homedir(), ".local", "bin", "claude"),
  path.join(os.homedir(), ".npm-global", "claude.cmd"),
  path.join(os.homedir(), ".npm-global", "claude"),
  path.join(os.homedir(), ".bun", "bin", "claude"),
];

/** Parcourt le PATH — ce que `fs.accessSync("claude")` ne faisait pas. */
function chercherDansPath() {
  const noms = process.platform === "win32"
    ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
    : ["claude"];
  const dossiers = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const d of dossiers) {
    for (const n of noms) {
      const c = path.join(d, n);
      try { fs.accessSync(c); return c; } catch { /* suivant */ }
    }
  }
  return null;
}

export function findClaudeBin() {
  for (const candidate of CLAUDE_CANDIDATES) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch { /* try next */ }
  }
  return chercherDansPath();
}

/**
 * On Windows, npm CLI shims are .cmd files that call: node "path/to/cli.js" %*
 * Resolving the underlying script lets us spawn node directly — no cmd /c
 * intermediary, no console window flash, completely background.
 * Returns { cmd, scriptPath } or null if unresolvable.
 */
function resolveWindowsNodeShim(cmdPath) {
  try {
    const content = fs.readFileSync(cmdPath, "utf8");
    const match = content.match(/node(?:\.exe)?\s+"([^"]+)"/i);
    if (!match) return null;
    let scriptPath = match[1].replace(/%~dp0/gi, path.dirname(cmdPath) + path.sep);
    // Normalise separators
    scriptPath = path.normalize(scriptPath);
    if (fs.existsSync(scriptPath)) return { cmd: process.execPath, scriptPath };
  } catch { /* ignore */ }
  return null;
}

/**
 * Build spawn args for the Claude binary.
 * On Windows .cmd files: resolve to node + script to avoid cmd /c console flash.
 */
export function buildSpawnArgs(claudeBin, extraArgs) {
  const isWindows = process.platform === "win32";
  const needsShell = isWindows && (claudeBin.endsWith(".cmd") || claudeBin.endsWith(".bat"));
  if (needsShell) {
    const resolved = resolveWindowsNodeShim(claudeBin);
    if (resolved) {
      return { cmd: resolved.cmd, args: [resolved.scriptPath, ...extraArgs], resolved: true };
    }
    // Fallback: cmd /c (may flash briefly)
    return { cmd: "cmd", args: ["/c", claudeBin, ...extraArgs], resolved: false };
  }
  return { cmd: claudeBin, args: extraArgs, resolved: true };
}

// ── Connexion MCP ─────────────────────────────────────────────────────────────
//
// wikichat créait le `.mcp.json` du projet, ou le « mettait à niveau ». Sur le
// pod, cette mise à niveau a produit des entrées `{enabled, headersHelper}`
// sans url ni command, et elle écrivait dans un fichier qui appartient au
// projet et à la liaison de l'Atelier. C'est fini : voir argumentsMcp() dans
// src/lancement.mjs — fichier temporaire hors du projet, sans
// --strict-mcp-config.

/** Mémorise la session Claude d'un agent pour qu'un prochain réveil la reprenne. */
function memoriserSession(name, claudeSessionId) {
  if (!name || !claudeSessionId) return;
  try { remember(name, "__claude_session_id", claudeSessionId); } catch { /* non bloquant */ }
}

/** Lit `session_id` / `subtype` dans la sortie `--output-format json`. */
function lireSortieJson(stdout) {
  const texte = String(stdout || "").trim();
  if (!texte) return {};
  // La sortie JSON tient en une ligne ; si le flux porte autre chose avant
  // (journal d'un daemon), on essaie la dernière ligne qui ouvre un objet.
  const candidats = [texte, texte.slice(texte.lastIndexOf("\n{") + 1)];
  for (const c of candidats) {
    try {
      const j = JSON.parse(c);
      return { sessionId: j.session_id || j.sessionId || null, sousType: String(j.subtype || "") };
    } catch { /* suivant */ }
  }
  return {};
}

// ── MCP-first preamble — injecté dans TOUS les prompts headless ──────────────

const AGENT_PREAMBLE = `
PROTOCOLE — MCP-FIRST:
1. Ton identité WikiChat est portée par ta connexion (WIKICHAT_AGENT) : n'appelle pas register().
   Seule exception : si get_briefing() te montre anonyme (session-xxxx), register(name=<ton nom>).
2. Déclare ta présence : declare_capabilities(skills=[...], current_task="<ce que tu fais>", current_project="<projet>", availability="available").
   → Permet aux autres agents de te trouver via list_sessions(topic=...) et de te contacter.
3. Utilise les tools MCP WikiChat (send_message, share_artifact, etc.) pour TOUTE communication.
4. Pour coordonner avec d'autres : list_sessions(topic="<sujet>") pour trouver qui peut aider,
   contact_agent(target="<nom>", also_invite=[...], thread="<sujet>") pour ouvrir une discussion suivie.
5. Écris aussi ton résultat dans .wikichat/artifacts/<timestamp>_<titre>.md comme backup local.
6. FALLBACK UNIQUEMENT si le MCP est injoignable (erreur réseau): écris dans .wikichat/queue/<timestamp>-<ton-nom>.json
   format: {"type":"artifact","agent":"<nom>","project":"<slug>","ts":"<ISO>","data":{"title":"...","content":"..."}}

SI L'ÉNONCÉ SE CONTREDIT — dis-le, ne tranche pas en silence.
Quand la consigne, la spécification et les tests ne disent pas la même chose, le
défaut est dans l'énoncé, pas dans ton travail. Signale la contradiction et
demande lequel fait foi, plutôt que d'arbitrer.

Mesuré : un agent à qui on avait donné une spécification contradictoire a d'abord
écrit le code conforme, puis a basculé sous la pression du test rouge, puis a
rédigé une justification invoquant la spécification qu'il venait de violer. Le
code produit était bon par ailleurs — c'est ce qui rend le cas coûteux : rien
n'invitait à le relire. Un arbitrage silencieux se découvre des semaines plus
tard dans du code qu'on croyait conforme.

AVANT DE TERMINER — consigne ce qui doit survivre à ta session :
- Décision actée, blocage rencontré ou question laissée ouverte qui engage le projet
  → add_project_note(project=<projet>, type="decision"|"blocker"|"question", content=<une ligne précise>).
- Chose comprise qui servira à la prochaine session portant TON nom (et à elle seule)
  → remember(<clé>, <valeur>).
Ton historique de conversation, lui, ne survit pas : il appartient à Claude Code et
disparaît. Ces deux traces sont ce qu'on retrouvera de toi. N'y mets rien d'autre —
pas de compte rendu, pas de recopie de l'artefact.
`;

// ── KB context injection ──────────────────────────────────────────────────────

const KB_DIR = path.join(os.homedir(), ".wikichat", "knowledge");

/**
 * Load relevant KB axes for a project and return a compact context block.
 *
 * Detection strategy (no LLM, pure filesystem, ~0ms):
 *   1. Explicit topics list (options.kb_topics) — authoritative.
 *   2. Project name / slug extracted from projectPath basename.
 *   3. Keywords from first 30 lines of CLAUDE.md (words ≥5 chars, top frequency).
 * Match: any *-axis.md whose stem contains a keyword (or vice-versa).
 * Output: TL;DR + DÉCISIONS CLOSES section of each matched axis, capped at 40
 * lines per axis so the injected block stays small (< 200 lines total).
 */
function loadKBContext(projectPath, options = {}) {
  try {
    if (!fs.existsSync(KB_DIR)) return "";
    const axes = fs.readdirSync(KB_DIR).filter(f => f.endsWith("-axis.md"));
    if (axes.length === 0) return "";

    // Build keyword list
    const keywords = new Set();
    if (Array.isArray(options.kb_topics)) {
      options.kb_topics.forEach(t => keywords.add(String(t).toLowerCase()));
    }
    if (projectPath) {
      keywords.add(path.basename(projectPath).toLowerCase());
      // Parse CLAUDE.md for frequency keywords
      try {
        const cm = path.join(projectPath, "CLAUDE.md");
        if (fs.existsSync(cm)) {
          const words = fs.readFileSync(cm, "utf8").split("\n").slice(0, 30).join(" ")
            .toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/);
          const freq = {};
          for (const w of words) { if (w.length >= 5) freq[w] = (freq[w] || 0) + 1; }
          Object.entries(freq).filter(([, n]) => n >= 2)
            .sort((a, b) => b[1] - a[1]).slice(0, 8)
            .forEach(([w]) => keywords.add(w));
        }
      } catch { /* CLAUDE.md unreadable — skip */ }
    }
    if (keywords.size === 0) return "";

    // Match axes
    const matched = axes.filter(f => {
      const stem = f.replace(/-axis\.md$/, "");
      return [...keywords].some(k => stem.includes(k) || k.includes(stem));
    });
    if (matched.length === 0) return "";

    // Extract compact content: TL;DR + DÉCISIONS CLOSES, max 40 lines each
    const blocks = [];
    for (const f of matched.slice(0, 3)) { // cap at 3 axes
      try {
        const raw = fs.readFileSync(path.join(KB_DIR, f), "utf8");
        const lines = raw.split("\n");
        const out = [];
        let inSection = false, sectionLines = 0;
        for (const ln of lines) {
          if (/^##\s+(TL;DR|DÉCISIONS CLOSES|DECISIONS CLOSES)/i.test(ln)) {
            inSection = true; sectionLines = 0; out.push(ln); continue;
          }
          if (inSection && /^##\s/.test(ln)) { inSection = false; }
          if (inSection && sectionLines < 40) { out.push(ln); sectionLines++; }
        }
        if (out.length > 0) {
          const topic = f.replace(/-axis\.md$/, "");
          blocks.push(`### KB: ${topic}\n${out.join("\n").trim()}`);
        }
      } catch { /* unreadable axis */ }
    }
    if (blocks.length === 0) return "";
    return `\n\n## Contexte KB (axes pertinents — lis avant d'agir)\n${blocks.join("\n\n")}\n`;
  } catch { return ""; }
}

// ── Role injection ───────────────────────────────────────────────────────────

/**
 * Load a role definition from .wikichat/roles/<roleName>.md if it exists.
 * Falls back to the WikiChat server's own roles directory.
 */
function loadRole(projectPath, roleName) {
  if (!roleName) return "";
  const slug = roleName.toLowerCase().replace(/[^a-z0-9-]/g, "");
  // Try project-local roles first, then server roles
  for (const base of [
    path.join(projectPath, ".wikichat", "roles"),    // project override
    CHEMINS.roles,                                   // surcharges locales du service
    path.join(DEPOT, "docs", "roles"),               // modèles livrés avec wikichat
  ]) {
    const rolePath = path.join(base, `${slug}.md`);
    try {
      if (fs.existsSync(rolePath)) return "\n" + fs.readFileSync(rolePath, "utf8") + "\n";
    } catch { /* ignore */ }
  }
  return "";
}

// ── Prompt templates ──────────────────────────────────────────────────────────

export const PROMPT_TEMPLATES = {
  /**
   * Generic one-shot task. Agent reads context, does task, exits.
   * If options.role matches a file in .wikichat/roles/, its content is injected.
   */
  task: (name, task, options = {}) => {
    const roleContent = options.projectPath ? loadRole(options.projectPath, options.role) : "";
    const kbContext = options.projectPath ? loadKBContext(options.projectPath, options) : "";
    return AGENT_PREAMBLE +
      (roleContent || `Tu es ${name}, agent WikiChat. `) +
      kbContext +
      `Ta mission: ${task}. ` +
      `Effectue la mission. ` +
      `Partage le résultat via share_artifact sur WikiChat. ` +
      `Écris aussi dans .wikichat/artifacts/ comme backup. Termine.`;
  },

  /**
   * Project status audit.
   */
  audit: (name, projectName) =>
    AGENT_PREAMBLE +
    `Tu es ${name}, agent audit WikiChat. ` +
    `Fais un audit de l'état du projet "${projectName}": tâches actives, blockers, agents, progression. ` +
    `share_artifact le rapport sur #coordination. ` +
    `Écris aussi dans .wikichat/artifacts/audit-${projectName}-<timestamp>.md comme backup. Termine.`,

  /**
   * Queue processor.
   */
  queue: (name) =>
    AGENT_PREAMBLE +
    `Tu es ${name}, agent WikiChat. ` +
    `Lis les fichiers dans .wikichat/queue/ s'ils existent. ` +
    `Pour chaque fichier: traite l'action décrite via les tools MCP WikiChat. ` +
    `Partage le rapport via share_artifact sur #coordination. ` +
    `Écris aussi dans .wikichat/artifacts/queue-processed-<timestamp>.md comme backup. Termine.`,

  /**
   * Watchdog check.
   */
  watchdog: (name) =>
    AGENT_PREAMBLE +
    `Tu es ${name}, agent watchdog WikiChat. ` +
    `get_briefing() pour lire l'état du système. ` +
    `Identifie les agents stales, les tâches expirées, les anomalies. ` +
    `broadcast() si alertes critiques. share_artifact le rapport sur #coordination. ` +
    `Écris aussi dans .wikichat/artifacts/watchdog-<timestamp>.md comme backup. Termine.`,
};

/** `allowedTools` (tableau ou CSV) en tableau, ou null. */
function listeOutils(allowedTools) {
  if (!allowedTools) return null;
  const liste = Array.isArray(allowedTools)
    ? allowedTools.map(String)
    : String(allowedTools).split(",").map((s) => s.trim());
  const propre = liste.filter(Boolean);
  return propre.length ? propre : null;
}

// ── spawnHeadless ─────────────────────────────────────────────────────────────

/**
 * Spawn a headless Claude Code session for a one-shot task.
 *
 * @param {string} projectPath  - Absolute path to the project directory
 * @param {string} prompt       - The task prompt (use PROMPT_TEMPLATES)
 * @param {object} options
 *   @param {string} options.name         - Agent name for registry
 *   @param {string} [options.role]       - Agent role
 *   @param {number} [options.port]       - WikiChat MCP port (default 3777)
 *   @param {number} [options.timeoutMs]  - Max execution time (default 5min)
 *   @param {string} [options.spawnedBy]  - Who triggered this spawn
 * @returns {Promise<{ success: boolean, stdout: string, stderr: string, exitCode: number }>}
 */
export async function spawnHeadless(projectPath, prompt, options = {}) {
  const {
    name = `headless-${randomUUID().slice(0, 6)}`,
    role = "agent",
    port = parseInt(process.env.PORT || "3777"),
    timeoutMs = 5 * 60 * 1000,
    spawnedBy = "wikichat-service",
    resumeSessionId = null, // If set, resumes an existing Claude session
    parentDepth = 0,
    model = null,           // --model (alias sonnet/opus/haiku ou id complet)
    allowedTools = null,    // --allowedTools (tableau ou chaîne CSV)
  } = options;
  const maxTurns = options.maxTurns ?? options.max_turns ?? null; // --max-turns (bornage contexte)
  const appendSystemPrompt = options.appendSystemPrompt ?? options.append_system_prompt ?? null; // contrat proposeur générique
  const permission = resoudreModePermission(options);
  if (permission.avertissement) console.warn(`[spawn] ${name} : ${permission.avertissement}`);
  const viaAtelier = lanceurActif() === "atelier";

  let claudeBin = viaAtelier ? null : findClaudeBin();
  if (!viaAtelier && !claudeBin) {
    return { success: false, stdout: "", stderr: "claude CLI not found", exitCode: -1 };
  }

  if (!fs.existsSync(projectPath)) {
    return { success: false, stdout: "", stderr: `Project path not found: ${projectPath}`, exitCode: -1 };
  }

  // Pre-flight checks (depth → owner quota → global budget)
  const depthCheck = checkDepth(parentDepth);
  if (depthCheck.error) {
    return { success: false, stdout: "", stderr: depthCheck.error, exitCode: -3 };
  }
  const quotaCheck = checkOwnerQuota(spawnedBy);
  if (quotaCheck) {
    return { success: false, stdout: "", stderr: quotaCheck.error, exitCode: -4 };
  }
  const budget = checkBudget();
  if (budget) {
    return { success: false, stdout: "", stderr: budget.error, exitCode: -2 };
  }
  _claimSlot();
  _claimQuota(spawnedBy);

  // Register in spawn registry
  const spawnEntry = {
    name, role, repo_path: projectPath,
    storage_path: path.join(projectPath, ".wikichat"),
    spawned_by: spawnedBy,
    spawned_at: new Date().toISOString(),
    mode: viaAtelier ? "atelier" : "headless",
    status: "starting",
    prompt: prompt.slice(0, 200),
    claude_session_name: name,
    permission_mode: permission.mode,
  };
  try { upsertSpawnRegistry(spawnEntry); } catch { /* non-blocking */ }

  // Lot D : le tour est demandé à l'Atelier, qui le joue avec son harnais, le
  // profil et le mode du projet, et ses plafonds — pas par un `claude -p` de
  // wikichat. Repli sur `claude -p` seulement si l'Atelier ne répond pas.
  if (viaAtelier) {
    const r = await lancerParAtelier({
      projectPath, prompt, name, model, timeoutMs, spawnedBy,
      mode: permission.mode, bypassAutorise: options.bypassAutorise === true,
      allowedTools: listeOutils(allowedTools),
      conversation: options.atelierConversation || recall(name, "__atelier_conversation") || null,
    });
    if (r.injoignable && configAtelier().repli) {
      claudeBin = findClaudeBin();
      console.warn(`[spawn] ${name} : ${r.stderr} — repli sur claude -p`);
      spawnEntry.mode = "headless-repli";
      spawnEntry.repli = r.stderr;
      try { upsertSpawnRegistry(spawnEntry); } catch { /* */ }
      if (!claudeBin) {
        _releaseSlot(); _releaseQuota(spawnedBy);
        return { success: false, stdout: "", stderr: `${r.stderr} ; claude CLI not found`, exitCode: -1 };
      }
    } else {
      if (r.conversationId) { try { remember(name, "__atelier_conversation", r.conversationId); } catch { /* */ } }
      try {
        upsertSpawnRegistry({
          ...spawnEntry,
          status: r.success ? "done" : (r.refus ? "refused" : "failed"),
          exit_code: r.exitCode,
          ...(r.mode ? { permission_mode: r.mode } : {}),
          ...(r.lancementId ? { atelier_lancement: r.lancementId } : {}),
          ...(r.conversationId ? { atelier_conversation: r.conversationId } : {}),
          ...(r.success ? {} : { error: r.stderr }),
          ended_at: new Date().toISOString(),
        });
      } catch { /* */ }
      _releaseSlot(); _releaseQuota(spawnedBy);
      return { ...r, sessionId: null };
    }
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const mcp = argumentsMcp({ name, port, projectPath });
    const baseArgs = ["-p", prompt, "--permission-mode", permission.mode, "--name", name, "--output-format", "json"];
    if (model) baseArgs.push("--model", model);
    const outils = outilsAutorises(allowedTools, permission.mode);
    if (outils) baseArgs.push("--allowedTools", outils.join(","));
    if (maxTurns) baseArgs.push("--max-turns", String(maxTurns));
    if (appendSystemPrompt) baseArgs.push("--append-system-prompt", appendSystemPrompt);
    // Même garde que pour les daemons : un ID sans transcript fait échouer le CLI.
    // Contrairement au daemon, jamais de reprise implicite ici — un headless est
    // one-shot par nature, il ne reprend que si l'appelant le demande.
    const resumeHeadless = resumeSessionId
      ? resolveResumeSession(name, projectPath, resumeSessionId)
      : null;
    if (resumeHeadless) {
      baseArgs.push("--resume", resumeHeadless.sessionId);
    } else if (resumeSessionId) {
      console.log(`[spawn] ${name} : transcript de ${resumeSessionId} introuvable — démarrage frais.`);
    }
    baseArgs.push(...mcp.args);
    const spawnArgs = buildSpawnArgs(claudeBin, baseArgs);

    let child;
    try {
      child = spawn(spawnArgs.cmd, spawnArgs.args, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "pipe"],
        env: environnementEnfant(name),
        windowsHide: true,
        shell: false,
      });
    } catch (err) {
      supprimerConfigMcp(mcp.fichier);
      try { upsertSpawnRegistry({ ...spawnEntry, status: "error", error: err.message, ended_at: new Date().toISOString() }); } catch { /* */ }
      _releaseSlot(); _releaseQuota(spawnedBy);
      resolve({ success: false, stdout, stderr: err.message, exitCode: -1 });
      return;
    }

    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });

    let fini = false;
    const terminer = (resultat) => {
      if (fini) return;
      fini = true;
      supprimerConfigMcp(mcp.fichier);
      _releaseSlot(); _releaseQuota(spawnedBy);
      resolve(resultat);
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      try { upsertSpawnRegistry({ ...spawnEntry, status: "timeout", ended_at: new Date().toISOString() }); } catch { /* */ }
      terminer({ success: false, stdout, stderr: stderr + "\n[timeout]", exitCode: -1 });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const success = code === 0;
      // Capture le session-id Claude depuis la sortie --output-format json (resume ultérieur)
      const { sessionId: claudeSessionId = null, sousType = "" } = lireSortieJson(stdout);
      // Un agent qui epuise ses tours sort avec le code 0. Sans regarder le
      // sous-type, un run coupe au milieu se lit donc comme une reussite :
      // deux agents sur quatre finissaient ainsi, sur un resultat d'outil,
      // sans avoir rien rapporte — et l'ecran affichait « OK ».
      const tronque = sousType === "error_max_turns";
      // La session est mémorisée ici, plutôt que confiée à un register() que
      // l'agent n'a plus à appeler : son prochain réveil la reprendra.
      memoriserSession(name, claudeSessionId);
      try {
        upsertSpawnRegistry({
          ...spawnEntry,
          status: tronque ? "max_turns" : (success ? "done" : "failed"),
          exit_code: code,
          ...(claudeSessionId ? { claude_session_id: claudeSessionId } : {}),
          ended_at: new Date().toISOString(),
        });
      } catch { /* */ }
      terminer({ success, stdout, stderr, exitCode: code ?? -1, sessionId: claudeSessionId });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      try { upsertSpawnRegistry({ ...spawnEntry, status: "error", error: err.message, ended_at: new Date().toISOString() }); } catch { /* */ }
      terminer({ success: false, stdout, stderr: err.message, exitCode: -1 });
    });
  });
}

// ── Reprise de session (--resume) ─────────────────────────────────────────────

/** Plafond de taille d'un transcript repris. Au-delà, démarrage frais. */
const MAX_RESUME_BYTES = parseInt(process.env.WIKICHAT_MAX_RESUME_MB || "5") * 1024 * 1024;

/**
 * Resolve the Claude session an agent should resume, and verify its transcript
 * still exists on disk and is small enough to be worth reloading.
 *
 * `remember(name, "__claude_session_id")` only stores an ID — the actual
 * conversation lives in ~/.claude/projects/<slug>/<id>.jsonl, which Claude Code
 * rotates independently. Passing --resume with a rotated ID makes the CLI fail
 * at startup, so the ID alone is never sufficient : we check the file first and
 * fall back to a fresh session when it is gone.
 *
 * Size matters as much as existence. Long-lived agents accumulate transcripts
 * that reach hundreds of megabytes ; reloading one would exhaust the daemon's
 * --max-budget-usd before its first poll. Past MAX_RESUME_BYTES we start fresh —
 * a resident that loses its history still works, one that burns its budget on
 * boot does not.
 *
 * @param {string} name          - Agent name (memory key)
 * @param {string} projectPath   - cwd the agent runs in (used to derive the slug)
 * @param {string} [explicitId]  - Caller-supplied ID ; takes precedence over memory
 * @returns {{ sessionId: string, transcript: string, bytes: number } | null}
 */
export function resolveResumeSession(name, projectPath, explicitId = null) {
  let sessionId = explicitId;
  if (!sessionId) {
    if (!name) return null;
    try { sessionId = recall(name, "__claude_session_id"); } catch { return null; }
  }
  if (!sessionId) return null;

  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  // Claude Code slugifies the absolute cwd : every non-alphanumeric char → "-".
  const slug = String(projectPath || "").replace(/[^a-zA-Z0-9]/g, "-");

  let transcript = null;
  const direct = path.join(projectsDir, slug, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) {
    transcript = direct;
  } else {
    // The agent may have moved between repos, or the slug casing may differ —
    // scan the sibling project dirs before giving up.
    try {
      for (const dir of fs.readdirSync(projectsDir)) {
        const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
        if (fs.existsSync(candidate)) { transcript = candidate; break; }
      }
    } catch { /* no transcripts dir — treat as fresh */ }
  }

  // Known ID, transcript gone : the memory is stale, not the agent.
  if (!transcript) return null;

  // statSync peut échouer si le fichier disparaît entre le existsSync et ici,
  // ou sur un souci de droits. Ne jamais faire échouer un spawn pour ça.
  let size = 0;
  try { size = fs.statSync(transcript).size; } catch { return null; }

  if (size > MAX_RESUME_BYTES) {
    console.log(
      `[spawn] ${name || sessionId} : transcript de ${(size / 1048576).toFixed(0)} Mo ` +
      `> plafond ${(MAX_RESUME_BYTES / 1048576).toFixed(0)} Mo — démarrage frais ` +
      `(WIKICHAT_MAX_RESUME_MB pour ajuster).`
    );
    return null;
  }

  return { sessionId, transcript, bytes: size };
}

// ── spawnDaemon — persistent background agent ────────────────────────────────

/**
 * Spawn a persistent Claude session that runs in the background.
 * Unlike spawnHeadless (one-shot), this stays alive across several relèves.
 * Uses `claude --resume` if a previous session exists, or starts fresh.
 *
 * @param {string} projectPath  - Absolute path to the project directory
 * @param {object} options
 *   @param {string} options.name         - Agent name
 *   @param {string} [options.role]       - Agent role
 *   @param {string} [options.task]       - Initial task/mission description
 *   @param {number} [options.port]       - WikiChat MCP port (default 3777)
 *   @param {string} [options.spawnedBy]  - Who triggered this spawn
 *   @param {string} [options.sessionId]  - Resume a specific claude session
 * @returns {{ success: boolean, pid: number|null, error?: string }}
 */
export function spawnDaemon(projectPath, options = {}) {
  const {
    name = `daemon-${randomUUID().slice(0, 6)}`,
    role = "agent",
    task = null,
    port = parseInt(process.env.PORT || "3777"),
    spawnedBy = "wikichat-service",
    parentDepth = 0,
  } = options;
  const permission = resoudreModePermission(options);
  if (permission.avertissement) console.warn(`[spawn] ${name} : ${permission.avertissement}`);
  // `_sansAtelier` : le repli, quand l'Atelier n'a pas répondu à ce lancement.
  const viaAtelier = !options._sansAtelier && lanceurActif() === "atelier";

  // Daemon mode is only spawnable by service / residents / principal
  // (not by random subagents — prevents fork-bomb cascades)
  const principal = process.env.WIKICHAT_PRINCIPAL_AGENT || "Claude-Code";
  const allowedDaemonSpawners = new Set([
    "wikichat-service", principal, "Sentinel", "Librarian", "Orchestrator",
  ]);
  const isAllowedSpawner = allowedDaemonSpawners.has(spawnedBy)
    || (spawnedBy && spawnedBy.startsWith("trigger:"))
    || (spawnedBy && spawnedBy.startsWith("watchdog-"));
  if (!isAllowedSpawner) {
    return { success: false, pid: null, error: `Le spawn de daemons est réservé au service / résidents / principal. "${spawnedBy}" ne peut spawner que des headless.` };
  }

  const claudeBin = viaAtelier ? null : findClaudeBin();
  if (!viaAtelier && !claudeBin) {
    return { success: false, pid: null, error: "claude CLI not found" };
  }

  if (!fs.existsSync(projectPath)) {
    return { success: false, pid: null, error: `Project path not found: ${projectPath}` };
  }


  // Pre-flight: depth → owner quota → global budget
  const depthCheck = checkDepth(parentDepth);
  if (depthCheck.error) return { success: false, pid: null, error: depthCheck.error };
  const quotaCheck = checkOwnerQuota(spawnedBy);
  if (quotaCheck) return { success: false, pid: null, error: quotaCheck.error };
  const budget = checkBudget();
  if (budget) return { success: false, pid: null, error: budget.error };
  _claimSlot();
  _claimQuota(spawnedBy);

  // Le daemon est un claude -p au prompt long. Il relève, agit, et sort quand il
  // n'a plus rien à faire ; la minuterie MAX_DUREE_DAEMON_MS le borne.
  const prompt = [
    AGENT_PREAMBLE,
    `Tu es ${name}${role ? `, ${role}` : ""}.`,
    task ? `Ta mission: ${task}` : "",
    ``,
    `PROTOCOLE :`,
    `1. send_message(channel="coordination", content="🟢 ${name} en ligne.")`,
    `2. poll(timeout_seconds=120) — relève ce qui t'est adressé, sans argument de canal.`,
    `3. S'il y a quelque chose : traite, réponds via send_message, puis re-poll.`,
    `4. Si deux relèves consécutives ne rapportent rien : consigne ce qui doit survivre`,
    `   (add_project_note / remember) et TERMINE proprement.`,
    ``,
    `Ne boucle pas indéfiniment. Chaque tour d'attente relit tout ton historique :`,
    `attendre coûte plus cher que d'être relancé. Un trigger te réveillera quand il y`,
    `aura de quoi faire, et tu reprendras cette session (wikichat la mémorise pour toi).`,
    `Sois concis : 1-2 phrases par réponse, pas de récapitulatif entre les relèves.`,
  ].filter(Boolean).join("\n");

  // Register in spawn registry
  const spawnEntry = {
    name, role, repo_path: projectPath,
    storage_path: path.join(projectPath, ".wikichat"),
    spawned_by: spawnedBy,
    spawned_at: new Date().toISOString(),
    mode: viaAtelier ? "atelier" : "daemon",
    status: "running",
    task: task || null,
    permission_mode: permission.mode,
    ...(options._sansAtelier ? { repli: options._sansAtelier } : {}),
  };
  try { upsertSpawnRegistry(spawnEntry); } catch { /* non-blocking */ }

  // Lot D : un tour dans la conversation Atelier de l'agent, avec sa durée
  // plafonnée (celle des daemons). Pas de processus à surveiller ni de
  // respawn : l'Atelier tient le tour, et le prochain réveil reprendra la même
  // conversation. Si l'Atelier ne répond pas, repli sur le daemon local.
  if (viaAtelier) {
    lancerParAtelier({
      projectPath, prompt, name, model: options.model || null, attendreFin: false, spawnedBy,
      timeoutMs: MAX_DUREE_DAEMON_MS,
      mode: permission.mode, bypassAutorise: options.bypassAutorise === true,
      allowedTools: listeOutils(options.allowedTools || null),
      conversation: options.atelierConversation || recall(name, "__atelier_conversation") || null,
    }).then((r) => {
      if (r.injoignable && configAtelier().repli) {
        console.warn(`[spawn] ${name} : ${r.stderr} — repli sur le daemon local`);
        _releaseSlot(); _releaseQuota(spawnedBy);
        const repli = spawnDaemon(projectPath, { ...options, name, _sansAtelier: r.stderr || "Atelier injoignable" });
        if (!repli.success) {
          try { upsertSpawnRegistry({ ...spawnEntry, status: "error", error: repli.error }); } catch { /* */ }
        }
        return;
      }
      if (r.conversationId) { try { remember(name, "__atelier_conversation", r.conversationId); } catch { /* */ } }
      try {
        upsertSpawnRegistry({
          ...spawnEntry,
          status: r.success ? "delegated" : (r.refus ? "refused" : "error"),
          ...(r.success ? {} : { error: r.stderr }),
          ...(r.mode ? { permission_mode: r.mode } : {}),
          ...(r.lancementId ? { atelier_lancement: r.lancementId } : {}),
          ...(r.conversationId ? { atelier_conversation: r.conversationId } : {}),
        });
      } catch { /* */ }
      _releaseSlot(); _releaseQuota(spawnedBy);
    }).catch(() => { _releaseSlot(); _releaseQuota(spawnedBy); });
    return { success: true, pid: null, name, via: "atelier" };
  }

  try {
    const isWindows = process.platform === "win32";
    // Aucun modèle par défaut. « haiku » est un alias Anthropic qui n'existe pas
    // sur un endpoint tiers — un pod servi par un LLM auto-hébergé le refuse.
    // Sans valeur explicite, on laisse le CLI choisir le sien.
    const model = options.model || null;
    const outils = outilsAutorises(options.allowedTools || null, permission.mode);
    const argsCommuns = [
      "--permission-mode", permission.mode, "--name", name, "--output-format", "json",
      ...(model ? ["--model", model] : []),
      ...(outils ? ["--allowedTools", outils.join(",")] : []),
    ];

    // Une configuration MCP temporaire par processus, supprimée à sa sortie.
    const lancer = (texte, resumeId) => {
      const mcp = argumentsMcp({ name, port, projectPath });
      const args = ["-p", texte, ...argsCommuns, ...mcp.args,
        ...(resumeId ? ["--resume", resumeId] : []),
        "--max-turns", String(MAX_TOURS_DAEMON)];
      const spawnArgs = buildSpawnArgs(claudeBin, args);
      // detached: false on Windows — keeps the daemon tied to the server's lifetime.
      // On Windows detached children survive parent death (orphan claude.exe).
      const enfant = spawn(spawnArgs.cmd, spawnArgs.args, {
        cwd: projectPath,
        stdio: ["ignore", "pipe", "pipe"],
        env: environnementEnfant(name),
        windowsHide: true,
        detached: !isWindows,
        shell: false,
      });
      // La sortie JSON finale porte le session_id : on garde la fin du flux
      // pour le mémoriser à la sortie (le prochain réveil reprendra la session).
      let fin = "";
      enfant.stdout.on("data", (d) => { fin = (fin + d.toString()).slice(-65536); });
      enfant.on("exit", () => {
        supprimerConfigMcp(mcp.fichier);
        memoriserSession(name, lireSortieJson(fin).sessionId);
      });
      return enfant;
    };

    // Reprise de contexte. Résolue ici plutôt que chez l'appelant : routines,
    // triggers, watchdog et outils MCP passent tous par spawnDaemon, et aucun
    // ne transmettait l'ID — les résidents repartaient de zéro à chaque réveil.
    const resume = resolveResumeSession(name, projectPath, options.sessionId);
    if (!resume && options.sessionId) {
      console.log(`[spawn] ${name} : transcript de ${options.sessionId} introuvable — démarrage frais.`);
    }
    const child = lancer(prompt, resume ? resume.sessionId : null);

    // Les sorties étaient jetées, et le respawn rejouait jusqu'à cinq fois : un
    // spawn qui échoue le faisait donc EN BOUCLE ET SANS TRACE. Impossible de
    // savoir si le binaire manquait, si le modèle était refusé, ou si le MCP ne
    // répondait pas. On garde la dernière sortie sur disque — c'est ce qu'on
    // cherche quand un daemon ne démarre pas.
    const journal = path.join(os.homedir(), ".wikichat", "spawn-logs");
    try { fs.mkdirSync(journal, { recursive: true }); } catch { /* */ }
    const fichierLog = path.join(journal, `${name.replace(/[^\w.-]/g, "_")}.log`);
    const ecrire = (flux) => (buf) => {
      try { fs.appendFileSync(fichierLog, `[${new Date().toISOString()}] ${flux} ${buf}`); } catch { /* */ }
    };
    child.stdout.on("data", ecrire("out"));
    child.stderr.on("data", ecrire("err"));

    // Garde-fou réel : au-delà de la durée admise, on arrête. Sans lui, un
    // daemon qui boucle tourne jusqu'à l'arrêt du service.
    const minuterie = setTimeout(() => {
      console.warn(`[spawn] ${name} : durée maximale atteinte (${Math.round(MAX_DUREE_DAEMON_MS / 60000)} min) — arrêt.`);
      try { child.kill(); } catch { /* déjà mort */ }
    }, MAX_DUREE_DAEMON_MS);
    child.on("exit", () => clearTimeout(minuterie));

    // Auto-respawn with exponential backoff + global rate limit
    let respawnCount = 0;
    const maxRespawns = 5;

    function onExit(code) {
      respawnCount++;
      const delay = Math.min(3000 * Math.pow(2, respawnCount - 1), 120000); // 3s→6s→12s→24s→48s

      if (respawnCount >= maxRespawns || _activeRespawns >= MAX_CONCURRENT_RESPAWNS) {
        upsertSpawnRegistry({
          ...spawnEntry,
          status: respawnCount >= maxRespawns ? "max-respawns" : "rate-limited",
          exit_code: code, ended_at: new Date().toISOString(), respawns: respawnCount,
        });
        return;
      }

      _activeRespawns++;
      setTimeout(() => {
        _activeRespawns--;
        try {
          const continuePrompt = [
            AGENT_PREAMBLE,
            `Tu es ${name}${role ? `, ${role}` : ""}. Redémarrage #${respawnCount}.`,
            `poll() pour relever ce qui t'attend.`,
            `Sois CONCIS. Traite ce qui t'attend, consigne, et termine — ne boucle pas.`,
          ].join("\n");
          // Re-résolu à chaud : l'agent a pu enregistrer un ID plus récent depuis
          // le spawn initial, et le transcript a pu disparaître entre-temps.
          const respawnResume = resolveResumeSession(name, projectPath);
          const newChild = lancer(continuePrompt, respawnResume ? respawnResume.sessionId : null);
          newChild.stdout.on("data", ecrire("out"));
          newChild.stderr.on("data", ecrire("err"));
          newChild.on("exit", onExit);
          newChild.unref();
          upsertSpawnRegistry({ ...spawnEntry, pid: newChild.pid, status: "running", respawns: respawnCount });
        } catch { _activeRespawns = Math.max(0, _activeRespawns - 1); }
      }, delay);
    }

    child.on("exit", onExit);

    child.unref();
    upsertSpawnRegistry({ ...spawnEntry, pid: child.pid });

    // Release the pending slot once the daemon's MCP connection should have happened.
    // After this window the live session is counted via state.sessions instead.
    // Quota concurrent reste tenu tant que le daemon vit (release au exit).
    setTimeout(_releaseSlot, 60000);
    child.on("exit", () => _releaseQuota(spawnedBy));

    return { success: true, pid: child.pid, name };
  } catch (err) {
    upsertSpawnRegistry({ ...spawnEntry, status: "error", error: err.message });
    _releaseSlot();
    _releaseQuota(spawnedBy);
    return { success: false, pid: null, error: err.message };
  }
}

// ── sampleSession ─────────────────────────────────────────────────────────────

/**
 * Send a sampling request to an already-connected session.
 * If the session is not found, falls back to spawnHeadless.
 *
 * @param {string}  sessionName   - Target session name
 * @param {string}  prompt        - What to ask
 * @param {object}  context       - Extra context to prepend
 * @param {Map}     transports    - The server's transports Map (sessionId → {transport, server})
 * @param {Map}     sessions      - state.sessions
 * @param {object}  fallbackOpts  - Options for spawnHeadless fallback
 * @returns {Promise<{ mode: "sampling"|"headless"|"error", result: any }>}
 */
export async function sampleSession(sessionName, prompt, context = {}, transports, sessions, fallbackOpts = {}) {
  // Find live session
  let targetSession = null;
  let targetTransport = null;

  for (const [sid, session] of sessions) {
    if (session.name === sessionName) {
      const entry = transports.get(sid);
      if (entry) {
        targetSession = session;
        targetTransport = entry;
        break;
      }
    }
  }

  if (!targetSession || !targetTransport) {
    // Fallback: headless spawn
    console.log(`[Sampler] Session "${sessionName}" not found — falling back to headless spawn`);
    if (!fallbackOpts.projectPath) {
      return { mode: "error", result: `Session "${sessionName}" not connected and no fallback projectPath provided.` };
    }
    const result = await spawnHeadless(fallbackOpts.projectPath, prompt, {
      name: sessionName, ...fallbackOpts,
    });
    return { mode: "headless", result };
  }

  // Build sampling message
  const contextStr = Object.keys(context).length > 0
    ? `\n\nContexte:\n${JSON.stringify(context, null, 2)}\n\n`
    : "";

  const fullPrompt = contextStr + prompt;

  try {
    // MCP sampling: server → client createMessage
    const response = await targetTransport.server.createMessage({
      messages: [{ role: "user", content: { type: "text", text: fullPrompt } }],
      maxTokens: 2048,
    });
    return { mode: "sampling", result: response };
  } catch (err) {
    console.warn(`[Sampler] sampling failed for "${sessionName}":`, err.message);
    // Fallback
    if (fallbackOpts.projectPath) {
      const result = await spawnHeadless(fallbackOpts.projectPath, prompt, {
        name: sessionName + "-fallback", ...fallbackOpts,
      });
      return { mode: "headless", result };
    }
    return { mode: "error", result: err.message };
  }
}

// ── Service-level trigger ─────────────────────────────────────────────────────

/**
 * Trigger a headless agent for a specific project and task type.
 * Used by cron jobs and the watchdog.
 *
 * @param {string} projectPath
 * @param {"task"|"audit"|"queue"|"watchdog"} taskType
 * @param {object} opts  - { name, task (for "task" type), port, spawnedBy }
 */
export async function triggerProjectAgent(projectPath, taskType, opts = {}) {
  const projectName = path.basename(projectPath);
  const agentName = opts.name || `${taskType}-${projectName}-${randomUUID().slice(0, 4)}`;

  const templateFn = PROMPT_TEMPLATES[taskType];
  if (!templateFn) throw new Error(`Unknown task type: ${taskType}`);

  const prompt = taskType === "task"
    ? templateFn(agentName, opts.task || "effectue une revue du projet")
    : taskType === "audit"
    ? templateFn(agentName, projectName)
    : templateFn(agentName);

  console.log(`[Sampler] Triggering ${taskType} agent "${agentName}" in ${projectName}`);

  return spawnHeadless(projectPath, prompt, {
    name: agentName,
    role: taskType,
    port: opts.port,
    spawnedBy: opts.spawnedBy || "wikichat-cron",
    permission_mode: opts.permission_mode || null,
  });
}
