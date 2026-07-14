/**
 * sampler.mjs — Service-initiated session spawning and sampling.
 *
 * Two modes:
 *
 *  spawnHeadless(projectPath, prompt, options)
 *    → Runs `claude -p "<prompt>"` in non-interactive mode inside projectPath.
 *      The spawned process reads CLAUDE.md + .wikichat/instructions.md,
 *      connects to WikiChat MCP (via .mcp.json injected beforehand),
 *      executes its task, and exits. stdout is captured and returned.
 *      Best for: cron-triggered audits, one-shot tasks, automated reports.
 *
 *  sampleSession(sessionName, prompt, context, transports)
 *    → Sends a MCP sampling/createMessage request to an already-connected session.
 *      Falls back to spawnHeadless if no live session found.
 *      Best for: asking a long-running agent to do something.
 *
 * Safety: this module ONLY writes to .mcp.json if it doesn't exist.
 *         It NEVER modifies CLAUDE.md or any existing file.
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { writeAtomicJSON } from "./persistence.mjs";
import { upsertSpawnRegistry } from "./persistence.mjs";
import { randomUUID } from "crypto";
import { state } from "./state.mjs";

// ── Global respawn rate limiter ───────────────────────────────────────────────
let _activeRespawns = 0;
const MAX_CONCURRENT_RESPAWNS = 3;

// ── Resource budget — global ceiling on live + spawning sessions ──────────────
const MAX_SESSIONS = parseInt(process.env.WIKICHAT_MAX_SESSIONS || "30");
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

const CLAUDE_CANDIDATES = [
  path.join(os.homedir(), ".local", "bin", "claude.exe"),
  path.join(os.homedir(), ".npm-global", "claude.cmd"),
  path.join(os.homedir(), ".npm-global", "claude"),
  "claude.exe",
  "claude.cmd",
  "claude",
];

export function findClaudeBin() {
  for (const candidate of CLAUDE_CANDIDATES) {
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch { /* try next */ }
  }
  return null;
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

// ── MCP config injection (safe) ───────────────────────────────────────────────

/**
 * Ensure .mcp.json exists in projectPath so the headless session connects
 * to WikiChat automatically. Never overwrites an existing file.
 */
function ensureMcpJson(projectPath, port = 3777) {
  const mcpPath = path.join(projectPath, ".mcp.json");
  if (!fs.existsSync(mcpPath)) {
    try {
      writeAtomicJSON(mcpPath, {
        mcpServers: {
          wikichat: {
            type: "sse",
            url: `http://localhost:${port}/sse`,
          },
        },
      });
    } catch (err) {
      console.warn(`[Sampler] Cannot write .mcp.json in ${projectPath}:`, err.message);
    }
  }
}

// ── MCP-first preamble — injecté dans TOUS les prompts headless ──────────────

const AGENT_PREAMBLE = `
PROTOCOLE OBLIGATOIRE — MCP-FIRST:
1. register() sur WikiChat MCP IMMÉDIATEMENT au démarrage. C'est ta première action.
2. Déclare ta présence : declare_capabilities(skills=[...], current_task="<ce que tu fais>", current_project="<projet>", availability="available").
   → Permet aux autres agents de te trouver via list_sessions(topic=...) et de te contacter.
3. Utilise les tools MCP WikiChat (send_message, share_artifact, etc.) pour TOUTE communication.
4. Pour coordonner avec d'autres : list_sessions(topic="<sujet>") pour trouver qui peut aider,
   contact_agent(target="<nom>", also_invite=[...], thread="<sujet>") pour ouvrir une discussion suivie.
5. Écris aussi ton résultat dans .wikichat/artifacts/<timestamp>_<titre>.md comme backup local.
6. FALLBACK UNIQUEMENT si le MCP est injoignable (erreur réseau): écris dans .wikichat/queue/<timestamp>-<ton-nom>.json
   format: {"type":"artifact","agent":"<nom>","project":"<slug>","ts":"<ISO>","data":{"title":"...","content":"..."}}
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
    path.join(process.cwd(), ".wikichat", "roles"), // server local override
    path.join(process.cwd(), "docs", "roles"),       // shipped templates
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
      `register() puis effectue la mission. ` +
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
    `register() puis share_artifact le rapport sur #coordination. ` +
    `Écris aussi dans .wikichat/artifacts/audit-${projectName}-<timestamp>.md comme backup. Termine.`,

  /**
   * Queue processor.
   */
  queue: (name) =>
    AGENT_PREAMBLE +
    `Tu es ${name}, agent WikiChat. ` +
    `register() puis lis les fichiers dans .wikichat/queue/ s'ils existent. ` +
    `Pour chaque fichier: traite l'action décrite via les tools MCP WikiChat. ` +
    `Partage le rapport via share_artifact sur #coordination. ` +
    `Écris aussi dans .wikichat/artifacts/queue-processed-<timestamp>.md comme backup. Termine.`,

  /**
   * Watchdog check.
   */
  watchdog: (name) =>
    AGENT_PREAMBLE +
    `Tu es ${name}, agent watchdog WikiChat. ` +
    `register() puis get_context() pour lire l'état du système. ` +
    `Identifie les agents stales, les tâches expirées, les anomalies. ` +
    `broadcast() si alertes critiques. share_artifact le rapport sur #coordination. ` +
    `Écris aussi dans .wikichat/artifacts/watchdog-<timestamp>.md comme backup. Termine.`,
};

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

  const claudeBin = findClaudeBin();
  if (!claudeBin) {
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

  // Inject .mcp.json if needed (safe — never overwrites)
  ensureMcpJson(projectPath, port);

  // Ensure .wikichat/ write permissions in .claude/settings.local.json
  // Adds Write(.wikichat/**) without touching any other permissions
  const claudeDir = path.join(projectPath, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  try {
    fs.mkdirSync(claudeDir, { recursive: true });
    let settings = { permissions: { allow: [] } };
    if (fs.existsSync(settingsPath)) {
      try { settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch { /* keep default */ }
    }
    const allow = settings?.permissions?.allow ?? [];
    if (!allow.some(r => r.includes(".wikichat"))) {
      allow.push("Write(.wikichat/**)", "Edit(.wikichat/**)");
      settings.permissions = { ...settings.permissions, allow };
      writeAtomicJSON(settingsPath, settings);
    }
  } catch { /* non-blocking */ }

  // Register in spawn registry
  const spawnEntry = {
    name, role, repo_path: projectPath,
    storage_path: path.join(projectPath, ".wikichat"),
    spawned_by: spawnedBy,
    spawned_at: new Date().toISOString(),
    mode: "headless",
    status: "starting",
    prompt: prompt.slice(0, 200),
    claude_session_name: name,
  };
  try { upsertSpawnRegistry(spawnEntry); } catch { /* non-blocking */ }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const mcpConfigPath = path.join(projectPath, ".mcp.json");
    const baseArgs = ["-p", prompt, "--permission-mode", "bypassPermissions", "--name", name, "--output-format", "json"];
    if (model) baseArgs.push("--model", model);
    if (allowedTools) baseArgs.push("--allowedTools", Array.isArray(allowedTools) ? allowedTools.join(",") : String(allowedTools));
    if (maxTurns) baseArgs.push("--max-turns", String(maxTurns));
    if (resumeSessionId) {
      baseArgs.push("--resume", resumeSessionId);
    }
    if (fs.existsSync(mcpConfigPath)) {
      baseArgs.push("--mcp-config", mcpConfigPath);
    }
    const spawnArgs = buildSpawnArgs(claudeBin, baseArgs);

    const child = spawn(spawnArgs.cmd, spawnArgs.args, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      shell: false,
    });

    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      try { upsertSpawnRegistry({ ...spawnEntry, status: "timeout", ended_at: new Date().toISOString() }); } catch { /* */ }
      _releaseSlot(); _releaseQuota(spawnedBy);
      resolve({ success: false, stdout, stderr: stderr + "\n[timeout]", exitCode: -1 });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const success = code === 0;
      // Capture le session-id Claude depuis la sortie --output-format json (resume ultérieur)
      let claudeSessionId = null;
      try { const j = JSON.parse(stdout); claudeSessionId = j.session_id || j.sessionId || null; } catch { /* stdout non-json */ }
      try {
        upsertSpawnRegistry({
          ...spawnEntry,
          status: success ? "done" : "failed",
          exit_code: code,
          ...(claudeSessionId ? { claude_session_id: claudeSessionId } : {}),
          ended_at: new Date().toISOString(),
        });
      } catch { /* */ }
      _releaseSlot(); _releaseQuota(spawnedBy);
      resolve({ success, stdout, stderr, exitCode: code ?? -1, sessionId: claudeSessionId });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      try { upsertSpawnRegistry({ ...spawnEntry, status: "error", error: err.message, ended_at: new Date().toISOString() }); } catch { /* */ }
      _releaseSlot(); _releaseQuota(spawnedBy);
      resolve({ success: false, stdout, stderr: err.message, exitCode: -1 });
    });
  });
}

// ── spawnDaemon — persistent background agent ────────────────────────────────

/**
 * Spawn a persistent Claude session that runs in the background.
 * Unlike spawnHeadless (one-shot), this stays alive and loops on poll_messages.
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

  const claudeBin = findClaudeBin();
  if (!claudeBin) {
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

  // Ensure .mcp.json
  ensureMcpJson(projectPath, port);

  const mcpConfigPath = path.join(projectPath, ".mcp.json");

  // Daemon uses claude -p with a long-running prompt that loops on poll_messages
  // Timeout is set very high (2 hours) to keep the agent alive
  const prompt = [
    AGENT_PREAMBLE,
    `Tu es ${name}${role ? `, ${role}` : ""}.`,
    task ? `Ta mission: ${task}` : "",
    ``,
    `PROTOCOLE DAEMON — BOUCLE INFINIE:`,
    `1. register(name="${name}"${role ? `, role="${role}"` : ""})`,
    `2. send_message(channel="coordination", content="🟢 ${name} en ligne, prêt.")`,
    `3. BOUCLE INFINIE (MINIMUM 100 itérations):`,
    `   - poll_messages(timeout_seconds=30, types=["message","direct_message","broadcast","artifact"])`,
    `   - Si timeout: relance poll_messages IMMÉDIATEMENT sans commentaire.`,
    `   - Si message reçu: réponds BRIÈVEMENT via send_message, puis relance poll_messages.`,
    `4. JAMAIS terminer. Chaque timeout = relance immédiate sans texte entre les appels.`,
    `5. INTERDIT: résumés, récapitulatifs, "dois-je continuer?", réflexions entre les polls.`,
    `6. Sois CONCIS: réponds en 1-2 phrases max, pas de bavardage. Économise les tokens.`,
  ].filter(Boolean).join("\n");

  // Register in spawn registry
  const spawnEntry = {
    name, role, repo_path: projectPath,
    storage_path: path.join(projectPath, ".wikichat"),
    spawned_by: spawnedBy,
    spawned_at: new Date().toISOString(),
    mode: "daemon",
    status: "running",
    task: task || null,
  };
  try { upsertSpawnRegistry(spawnEntry); } catch { /* non-blocking */ }

  try {
    const isWindows = process.platform === "win32";
    const model = options.model || "haiku";
    const baseArgs = ["-p", prompt, "--permission-mode", "bypassPermissions", "--name", name, "--model", model];
    if (fs.existsSync(mcpConfigPath)) {
      baseArgs.push("--mcp-config", mcpConfigPath);
    }
    if (options.sessionId) {
      baseArgs.push("--resume", options.sessionId);
    }
    baseArgs.push("--max-budget-usd", "5");

    const spawnArgs = buildSpawnArgs(claudeBin, baseArgs);

    // detached: false on Windows — keeps the daemon tied to the server's lifetime.
    // On Windows detached children survive parent death (orphan claude.exe).
    const child = spawn(spawnArgs.cmd, spawnArgs.args, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      detached: !isWindows,
      shell: false,
    });

    child.stdout.on("data", () => {}); // drain
    child.stderr.on("data", () => {}); // drain

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
            `register(name="${name}"${role ? `, role="${role}"` : ""}) puis poll_messages.`,
            `Sois CONCIS. Boucle poll_messages(timeout_seconds=30).`,
          ].join("\n");
          const respawnBaseArgs = ["-p", continuePrompt, "--permission-mode", "bypassPermissions", "--name", name,
            ...(fs.existsSync(mcpConfigPath) ? ["--mcp-config", mcpConfigPath] : []),
            "--model", model, "--max-budget-usd", "5"];
          const respawnSpawnArgs = buildSpawnArgs(claudeBin, respawnBaseArgs);
          const newChild = spawn(respawnSpawnArgs.cmd, respawnSpawnArgs.args, {
            cwd: projectPath,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
            windowsHide: true, detached: !isWindows, shell: false,
          });
          newChild.stdout.on("data", () => {});
          newChild.stderr.on("data", () => {});
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
  });
}
