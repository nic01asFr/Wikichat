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
const MAX_SESSIONS = parseInt(process.env.WIKICHAT_MAX_SESSIONS || "10");
let _pendingSpawns = 0; // processes spawned but not yet MCP-connected

/** Count current load: connected MCP sessions + processes still booting */
export function currentLoad() {
  return state.sessions.size + _pendingSpawns;
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
2. Utilise les tools MCP WikiChat (send_message, share_artifact, etc.) pour TOUTE communication.
3. Écris aussi ton résultat dans .wikichat/artifacts/<timestamp>_<titre>.md comme backup local.
4. FALLBACK UNIQUEMENT si le MCP est injoignable (erreur réseau): écris dans .wikichat/queue/<timestamp>-<ton-nom>.json
   format: {"type":"artifact","agent":"<nom>","project":"<slug>","ts":"<ISO>","data":{"title":"...","content":"..."}}
`;

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
    path.join(projectPath, ".wikichat", "roles"),
    path.join(process.cwd(), ".wikichat", "roles"),
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
    return AGENT_PREAMBLE +
      (roleContent || `Tu es ${name}, agent WikiChat. `) +
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
  } = options;

  const claudeBin = findClaudeBin();
  if (!claudeBin) {
    return { success: false, stdout: "", stderr: "claude CLI not found", exitCode: -1 };
  }

  if (!fs.existsSync(projectPath)) {
    return { success: false, stdout: "", stderr: `Project path not found: ${projectPath}`, exitCode: -1 };
  }

  // Resource budget check
  const budget = checkBudget();
  if (budget) {
    return { success: false, stdout: "", stderr: budget.error, exitCode: -2 };
  }
  _claimSlot();

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

    // On Windows, .cmd files must be invoked via cmd /c
    const isWindows = process.platform === "win32";
    const needsShell = isWindows && (claudeBin.endsWith(".cmd") || claudeBin.endsWith(".bat"));
    const mcpConfigPath = path.join(projectPath, ".mcp.json");
    const baseArgs = ["-p", prompt, "--permission-mode", "bypassPermissions", "--name", name];
    if (resumeSessionId) {
      baseArgs.push("--resume", resumeSessionId);
    }
    if (fs.existsSync(mcpConfigPath)) {
      baseArgs.push("--mcp-config", mcpConfigPath);
    }
    const spawnArgs = needsShell
      ? { cmd: "cmd", args: ["/c", claudeBin, ...baseArgs] }
      : { cmd: claudeBin, args: baseArgs };

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
      _releaseSlot();
      resolve({ success: false, stdout, stderr: stderr + "\n[timeout]", exitCode: -1 });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      const success = code === 0;
      try {
        upsertSpawnRegistry({
          ...spawnEntry,
          status: success ? "done" : "failed",
          exit_code: code,
          ended_at: new Date().toISOString(),
        });
      } catch { /* */ }
      _releaseSlot();
      resolve({ success, stdout, stderr, exitCode: code ?? -1 });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      try { upsertSpawnRegistry({ ...spawnEntry, status: "error", error: err.message, ended_at: new Date().toISOString() }); } catch { /* */ }
      _releaseSlot();
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
  } = options;

  const claudeBin = findClaudeBin();
  if (!claudeBin) {
    return { success: false, pid: null, error: "claude CLI not found" };
  }

  if (!fs.existsSync(projectPath)) {
    return { success: false, pid: null, error: `Project path not found: ${projectPath}` };
  }

  // Resource budget check
  const budget = checkBudget();
  if (budget) {
    return { success: false, pid: null, error: budget.error };
  }
  _claimSlot();

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
    const needsShell = isWindows && (claudeBin.endsWith(".cmd") || claudeBin.endsWith(".bat"));
    const model = options.model || "haiku";
    const baseArgs = ["-p", prompt, "--permission-mode", "bypassPermissions", "--name", name, "--model", model];
    if (fs.existsSync(mcpConfigPath)) {
      baseArgs.push("--mcp-config", mcpConfigPath);
    }
    if (options.sessionId) {
      baseArgs.push("--resume", options.sessionId);
    }
    baseArgs.push("--max-budget-usd", "5");

    const spawnArgs = needsShell
      ? { cmd: "cmd", args: ["/c", claudeBin, ...baseArgs] }
      : { cmd: claudeBin, args: baseArgs };

    const child = spawn(spawnArgs.cmd, spawnArgs.args, {
      cwd: projectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      windowsHide: true,
      detached: true,
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
          const newArgs = needsShell
            ? ["/c", claudeBin, "-p", continuePrompt, "--permission-mode", "bypassPermissions", "--name", name, ...(fs.existsSync(mcpConfigPath) ? ["--mcp-config", mcpConfigPath] : []), "--model", model, "--max-budget-usd", "5"]
            : ["-p", continuePrompt, "--permission-mode", "bypassPermissions", "--name", name, ...(fs.existsSync(mcpConfigPath) ? ["--mcp-config", mcpConfigPath] : []), "--model", model, "--max-budget-usd", "5"];
          const newChild = spawn(needsShell ? "cmd" : claudeBin, newArgs, {
            cwd: projectPath,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
            windowsHide: true, detached: true, shell: false,
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
    setTimeout(_releaseSlot, 60000);

    return { success: true, pid: child.pid, name };
  } catch (err) {
    upsertSpawnRegistry({ ...spawnEntry, status: "error", error: err.message });
    _releaseSlot();
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
