#!/usr/bin/env node
/**
 * MCP WikiChat Server v2
 *
 * Single-file entry point. All logic is in src/.
 *   src/state.mjs        — shared in-memory state
 *   src/persistence.mjs  — atomic file I/O (sessions, projects, spawn registry)
 *   src/notifier.mjs     — long-poll waiter/notification system
 *   src/tools.mjs        — all MCP tool definitions
 *   src/dashboard.mjs    — live web dashboard (GET /dashboard)
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { randomUUID } from "crypto";
import { readdir, readFile } from "fs/promises";
import { readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, extname } from "path";
import { homedir } from "os";

import { state, sysMsg, pushMessage, getSessionByName, setOnMessagePush, rebuildChannelCounts, getChannelCount } from "./src/state.mjs";
import { loadProjects, saveSnapshot, saveProject, loadSpawnRegistry, saveChannels, loadChannels, saveMessagesDebounced, loadMessages, flushSpawnRegistry, SESSION_STORE } from "./src/persistence.mjs";
import { startWatchdog, loadCronRegistry } from "./src/resilience.mjs";
import { clearWaiters, notifyWaiters } from "./src/notifier.mjs";
import { registerTools } from "./src/tools.mjs";
import { handleDashboardPage, handleDashboardEvents, pushDashboardUpdate } from "./src/dashboard.mjs";
// [DISABLED] import { handleGamePage } from "./src/game.mjs";
import { scanForProjects } from "./src/scanner.mjs";
import { loadRegistry, saveRegistry, loadConfig, mergeProjects } from "./src/registry.mjs";
import { injectProject, pickupQueue, readLocalArtifacts } from "./src/injector.mjs";
import { spawnHeadless, spawnDaemon, sampleSession, triggerProjectAgent } from "./src/sampler.mjs";
import { generateMap } from "./src/map-generator.mjs";
import { scanForChanges } from "./src/snapshot.mjs";

// ── Boot ──────────────────────────────────────────────────────────────────────

loadChannels();   // Restore persisted channels
loadMessages();   // Restore recent messages
rebuildChannelCounts(); // Build O(1) channel count cache
setOnMessagePush(saveMessagesDebounced); // Auto-persist on new messages
loadProjects();

// Restore cron state into sessions on boot (best effort)
const persistedCrons = loadCronRegistry();
if (persistedCrons.length > 0) {
  console.log(`[WikiChat] ${persistedCrons.length} cron(s) persistés chargés`);
}

// Start watchdog (runs every 60s: stale detection, auto-respawn, cron health)
const watchdogHandle = startWatchdog(
  state,
  loadSpawnRegistry,
  async (entry) => {
    if (entry.mode === "daemon" && entry.repo_path) {
      console.log(`[Watchdog] Auto-respawning daemon: ${entry.name}`);
      spawnDaemon(entry.repo_path, {
        name: entry.name, role: entry.role, task: entry.task,
        port: PORT, spawnedBy: "watchdog-respawn",
      });
      sysMsg("coordination", `🔄 Watchdog relance "${entry.name}" (daemon auto-respawn)`);
    } else {
      console.log(`[Watchdog] Would respawn: ${entry.name}`);
    }
  },
  pushDashboardUpdate
);
// ── Graceful shutdown ─────────────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`[WikiChat] ${signal} received — shutting down gracefully...`);
  try { clearInterval(watchdogHandle); } catch { /* */ }

  // Save all registered sessions
  for (const [, session] of state.sessions) {
    if (!session.name.startsWith("session-")) {
      try { saveSnapshot(session); } catch { /* */ }
    }
  }

  // Flush pending writes
  try { saveChannels(); } catch { /* */ }
  try { saveMessagesDebounced.flush?.(); } catch { /* */ }
  try { flushSpawnRegistry(); } catch { /* */ }

  console.log("[WikiChat] State saved. Exiting.");
  process.exit(0);
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("uncaughtException", (err) => {
  console.error("[WikiChat] FATAL:", err.message);
  gracefulShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  console.warn("[WikiChat] Unhandled rejection:", reason);
});

// Auto-scan on boot if configured
(async () => {
  try {
    const config = loadConfig();
    if (config.autoScan) {
      console.log("[WikiChat] Auto-scan enabled — scanning for Claude projects...");
      const scanned = await scanForProjects(config.roots, config.maxDepth);
      const registry = loadRegistry();
      const updated = mergeProjects(registry.projects, scanned);
      registry.projects = updated;
      registry.lastScan = new Date().toISOString();
      saveRegistry(registry);
      for (const p of updated.filter(q => q.status !== "missing")) {
        await injectProject(p).catch(() => {});
      }
      console.log(`[WikiChat] Auto-scan complete — ${scanned.length} project(s) found.`);
    }
  } catch (e) {
    console.error("[WikiChat] Boot scan error:", e.message);
  }
})();

// Queue + artifact pickup: every 2 minutes
// Recovers all agent output even when MCP was unavailable (local-first protocol)
setInterval(async () => {
  try {
    const registry = loadRegistry();
    for (const p of registry.projects.filter(q => q.status !== "missing")) {

      // 1. Queue pickup (offline actions from agents)
      const items = await pickupQueue(p).catch(() => []);
      if (items.length > 0) {
        console.log(`[WikiChat] Picked up ${items.length} queue item(s) from ${p.slug}`);
        for (const item of items) {
          sysMsg("coordination", `📥 [${p.slug}] ${item.agent}: ${item.type}${item.data?.message ? " — " + item.data.message : ""}`);
        }
      }

      // 2. Local artifact pickup (reports written by headless agents even when MCP was down)
      const artifacts = await readLocalArtifacts(p).catch(() => []);
      if (artifacts.length > 0) {
        console.log(`[WikiChat] Recovered ${artifacts.length} local artifact(s) from ${p.slug}`);
        for (const art of artifacts) {
          sysMsg("coordination", `📄 [${p.slug}] ${art.agent} → "${art.title}" (récupéré localement)`);
        }
      }

      if (items.length > 0 || artifacts.length > 0) pushDashboardUpdate();
    }
  } catch (e) {
    console.error("[WikiChat] Queue/artifact pickup error:", e.message);
  }
}, 2 * 60 * 1000);

// Cleanup interval: orphan tasks (TTL expired) + stale sessions
setInterval(() => {
  const now = new Date();
  for (const proj of state.projects.values()) {
    let changed = false;
    for (const [id, task] of proj.tasks) {
      if (task.status === "active" && task.claim_expires_at && new Date(task.claim_expires_at) < now) {
        task.status = "abandoned";
        task.outcome = "TTL expiré — libéré automatiquement";
        task.completedAt = now;
        proj.blockers.push(`${id}: claim expiré (${task.claimedBy} injoignable ?)`);
        changed = true;
        sysMsg("coordination", `⏰ Tâche "${id}" libérée automatiquement (TTL expiré — ${task.claimedBy} injoignable)`);
      }
    }
    if (changed) saveProject(proj);
  }
  for (const [id, s] of state.sessions) {
    if (Date.now() - new Date(s.lastSeen) > 15 * 60 * 1000 && s.availability !== "stale") {
      s.availability = "stale";
    }
  }
  // DM channel garbage collection — remove empty DM channels with no active participants
  const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
  for (const [name, ch] of state.channels) {
    if (!name.startsWith("dm:")) continue;
    const hasRecentMsg = state.messages.some(m => m.channel === name && new Date(m.timestamp) > thirtyMinAgo);
    if (!hasRecentMsg) {
      state.channels.delete(name);
    }
  }
  // Session snapshot rotation — delete snapshots older than 7 days
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const f of readdirSync(SESSION_STORE)) {
      const fp = join(SESSION_STORE, f);
      try { if (statSync(fp).mtimeMs < sevenDaysAgo) unlinkSync(fp); } catch { /* */ }
    }
  } catch { /* */ }

  // Project change detection — scan all projects for git/file changes (0 tokens)
  try {
    const registry = loadRegistry();
    const projects = (registry.projects || []).filter(p => p.status !== "missing" && p.path);
    const changed = scanForChanges(projects);
    if (changed.length > 0) {
      // Auto-create #insights channel if needed
      if (!state.channels.has("insights")) {
        state.channels.set("insights", { name: "insights", description: "Changements et insights détectés automatiquement", createdBy: "system", createdAt: new Date() });
        saveChannels();
      }
      for (const { project, changes } of changed) {
        const details = changes.changes
          ? changes.changes.map(c => `  • ${c.detail}`).join("\n")
          : changes.reason || "changement détecté";
        sysMsg("insights", `📊 ${project.name}: ${changes.type === "new" ? "premier scan" : "changements détectés"}\n${details}`);
      }
      console.log(`[WikiChat] Change detection: ${changed.length} project(s) changed`);
    }
  } catch (e) {
    console.error("[WikiChat] Change detection error:", e.message);
  }

  pushDashboardUpdate();
}, 5 * 60 * 1000);

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

const transports = new Map(); // sessionId → { transport, server }

// Dashboard & Game
app.get("/dashboard", handleDashboardPage);
app.get("/dashboard/events", handleDashboardEvents);
// [DISABLED] app.get("/game", handleGamePage);
app.get("/style-guide.html", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(readFileSync(join(process.cwd(), "public", "style-guide.html"))); });
app.get("/concepts.html", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(readFileSync(join(process.cwd(), "public", "concepts.html"))); });
app.get("/hybrid-concepts.html", (_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(readFileSync(join(process.cwd(), "public", "hybrid-concepts.html"))); });

// MCP SSE endpoint
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const sid = transport.sessionId;
  const mcpServer = new McpServer({ name: "mcp-wikichat", version: "2.0.0" });

  state.sessions.set(sid, {
    sessionId: sid,
    name: `session-${sid.slice(0, 6)}`,
    connectedAt: new Date(), lastSeen: new Date(),
    role: null, status: null,
    eta: null, etaReason: null,
    cron_job_id: null, cron_purpose: null,
    skills: [], current_task: null, current_project: null,
    availability: "available",
    storage_path: null,
  });
  transports.set(sid, { transport, server: mcpServer });
  console.log(`[WikiChat] +session ${sid.slice(0, 8)} (total: ${state.sessions.size})`);
  pushDashboardUpdate();

  res.on("close", () => {
    const session = state.sessions.get(sid);
    const name = session?.name ?? sid.slice(0, 8);
    const wasRegistered = session && !session.name.startsWith("session-");
    if (session && wasRegistered) saveSnapshot(session);
    state.sessions.delete(sid);
    transports.delete(sid);
    clearWaiters(sid);
    if (wasRegistered) {
      sysMsg("system", `${name} s'est déconnecté.`);
      pushDashboardUpdate();
    }
    console.log(`[WikiChat] -session ${name} (total: ${state.sessions.size})`);
  });

  registerTools(mcpServer, sid);
  await mcpServer.connect(transport);
});

// MCP POST messages
app.post("/messages", async (req, res) => {
  const sid = req.query.sessionId;
  const entry = transports.get(sid);
  if (!entry) { res.status(404).json({ error: "Session not found" }); return; }
  const session = state.sessions.get(sid);
  if (session) session.lastSeen = new Date();
  await entry.transport.handlePostMessage(req, res, req.body);
});

// ── Project Registry API ───────────────────────────────────────────────────────

app.get("/api/projects", (_req, res) => {
  try {
    const registry = loadRegistry();
    res.json(registry);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/map/generate", (_req, res) => {
  try {
    const registry = loadRegistry();
    const map = generateMap(registry.projects || []);
    res.json(map);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/projects/scan", async (_req, res) => {
  res.json({ status: "scanning", message: "Scan started" });
  try {
    const config = loadConfig();
    const scanned = await scanForProjects(config.roots, config.maxDepth);
    const registry = loadRegistry();
    const updated = mergeProjects(registry.projects, scanned);
    registry.projects = updated;
    registry.lastScan = new Date().toISOString();
    saveRegistry(registry);
    for (const p of updated) {
      await injectProject(p).catch(() => {});
    }
    pushDashboardUpdate();
    console.log(`[WikiChat] /api/projects/scan done — ${scanned.length} project(s) found.`);
  } catch (e) {
    console.error("[Scan] error:", e);
  }
});

app.get("/api/projects/:slug", (req, res) => {
  try {
    const registry = loadRegistry();
    const project = registry.projects.find(p => p.slug === req.params.slug);
    if (!project) {
      return res.status(404).json({ error: `Project "${req.params.slug}" not found in registry` });
    }
    res.json(project);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sampler API ────────────────────────────────────────────────────────────────

// POST /api/spawn/headless — launch a headless agent in a project
// Body: { projectPath, prompt?, taskType?, name?, role?, timeoutMs? }
app.post("/api/spawn/headless", async (req, res) => {
  const { projectPath, prompt, taskType = "task", name, role, timeoutMs } = req.body || {};
  if (!projectPath) return res.status(400).json({ error: "projectPath required" });
  try {
    const opts = { name, role, timeoutMs, spawnedBy: "wikichat-api", port: PORT };
    const result = taskType && !prompt
      ? await triggerProjectAgent(projectPath, taskType, opts)
      : await spawnHeadless(projectPath, prompt, opts);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sample — send a sampling request to a named live session
// Body: { sessionName, prompt, context?, fallbackProjectPath? }
app.post("/api/sample", async (req, res) => {
  const { sessionName, prompt, context = {}, fallbackProjectPath } = req.body || {};
  if (!sessionName || !prompt) return res.status(400).json({ error: "sessionName and prompt required" });
  try {
    const result = await sampleSession(
      sessionName, prompt, context,
      transports, state.sessions,
      fallbackProjectPath ? { projectPath: fallbackProjectPath, port: PORT } : {}
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/action — UI-triggered headless agent for a specific project action
// Body: { action, projectSlug, params? }
// Actions: "audit", "inspect-agent", "shop-crawl", "museum-index", "task-run", "custom"
// Returns: { jobName, status: "running", artifactsIn: ".wikichat/artifacts/" }
app.post("/api/action", async (req, res) => {
  const { action, projectSlug, params = {} } = req.body || {};
  if (!action || !projectSlug) return res.status(400).json({ error: "action and projectSlug required" });

  const registry = loadRegistry();
  const project = registry.projects.find(p => p.slug === projectSlug);
  if (!project) return res.status(404).json({ error: `Project "${projectSlug}" not found` });

  const ts = Date.now();
  const jobName = `${action}-${projectSlug}-${ts}`.slice(0, 40);

  const ACTION_PROMPTS = {
    audit: (p) =>
      `Tu es un agent d'audit. Lis .wikichat/context.json du projet "${p.name}". ` +
      `Produis un rapport d'état complet (tâches actives, blockers, agents, progression) ` +
      `dans .wikichat/artifacts/audit-${p.slug}-${ts}.md. Puis tente share_artifact sur #coordination.`,

    "inspect-agent": (_p) =>
      `Tu es un agent inspecteur. L'agent cible est "${params.agentName || "inconnu"}". ` +
      `Lis son historique dans sessions/ et agents/ (spawn_registry.json, snapshots). ` +
      `Produis un résumé de son activité dans .wikichat/artifacts/inspect-${params.agentName || "agent"}-${ts}.md.`,

    "shop-crawl": (p) =>
      `Tu es un agent crawler de magasin. Analyse le projet "${p.name}" (${p.path}). ` +
      `Identifie les patterns, composants, configs, scripts réutilisables dans d'autres projets. ` +
      `Stack détecté: ${(p.stack || []).join(", ") || "générique"}. ` +
      `Formate chaque produit comme: {title, type, description, file_path, reuse_instructions}. ` +
      `Écris le catalogue dans .wikichat/artifacts/shop-${p.slug}-${ts}.md. Puis share_artifact sur #shop.`,

    "museum-index": (p) =>
      `Tu es un agent d'indexation du musée WikiChat. ` +
      `Analyse les artifacts dans .wikichat/artifacts/ et les snapshots sessions/. ` +
      `Produis un index chronologique des événements notables du projet "${p.name}" ` +
      `dans .wikichat/artifacts/museum-${p.slug}-${ts}.md. ` +
      `Format: timeline avec date, agent, action, résultat.`,

    "task-run": (p) =>
      `Tu es un agent d'exécution de tâche. Projet: "${p.name}". ` +
      `Tâche: ${params.task || "effectuer une revue générale du projet"}. ` +
      `Écris le résultat dans .wikichat/artifacts/task-${ts}.md. Puis release_task si applicable.`,

    custom: (p) =>
      params.prompt || `Analyse le projet "${p.name}" et produis un rapport dans .wikichat/artifacts/custom-${ts}.md.`,
  };

  const promptFn = ACTION_PROMPTS[action];
  if (!promptFn) return res.status(400).json({ error: `Unknown action "${action}". Valid: ${Object.keys(ACTION_PROMPTS).join(", ")}` });

  const prompt = promptFn(project);

  // Fire-and-forget — result lands in .wikichat/artifacts/ and is auto-recovered
  spawnHeadless(project.path, prompt, {
    name: jobName,
    role: action,
    port: PORT,
    spawnedBy: "wikichat-ui",
  }).then(result => {
    if (!result.success) console.warn(`[Action] ${jobName} failed (exit ${result.exitCode})`);
    pushDashboardUpdate();
  }).catch(() => {});

  res.json({
    jobName,
    action,
    projectSlug,
    status: "running",
    artifactsIn: `${project.path}/.wikichat/artifacts/`,
    note: "Résultat disponible dans 1-3min via artifacts ou dashboard",
  });
});

// ── Chat API — browser user → WikiChat messages ────────────────────────────────

// POST /api/chat — send a message from the browser UI into WikiChat
// Body: { from, channel, content }
// channel can be "@AgentName" for DMs
app.post("/api/chat", (req, res) => {
  const { from = "Pilot", channel = "general", content } = req.body || {};
  if (!content) return res.status(400).json({ error: "content required" });

  let targetChannel = channel;
  let msgType = "message";

  // DM support: channel = "@AgentName"
  if (channel.startsWith("@")) {
    const targetName = channel.slice(1);
    const target = getSessionByName(targetName);
    if (!target) return res.status(404).json({ error: `Agent "${targetName}" not found` });
    // Normalize DM channel key alphabetically
    const parts = [from, targetName].sort();
    targetChannel = `dm:${parts[0]}-${parts[1]}`;
    msgType = "direct_message";
    if (!state.channels.has(targetChannel)) {
      state.channels.set(targetChannel, { description: `DM: ${from} ↔ ${targetName}`, created: new Date() });
      saveChannels();
    }
  }

  const msg = pushMessage({
    id: randomUUID(),
    from: "browser-pilot",
    fromName: from,
    channel: targetChannel,
    content,
    type: msgType,
    timestamp: new Date(),
  });

  notifyWaiters(targetChannel);
  notifyWaiters("__all__");
  pushDashboardUpdate();

  res.json({ ok: true, id: msg.id, channel: targetChannel });
});

// GET /api/messages — fetch messages filtered by channel
app.get("/api/messages", (req, res) => {
  const { channel, limit = "50" } = req.query;
  let msgs = state.messages;
  if (channel && channel !== "__all__") {
    msgs = msgs.filter(m => m.channel === channel);
  }
  const n = Math.min(parseInt(limit) || 50, 200);
  res.json(msgs.slice(-n));
});

// POST /api/spawn/daemon — launch a persistent background agent
// Body: { projectPath, name, role?, task? }
app.post("/api/spawn/daemon", (req, res) => {
  const { projectPath, name, role, task, model } = req.body || {};
  if (!projectPath || !name) return res.status(400).json({ error: "projectPath and name required" });
  const result = spawnDaemon(projectPath, {
    name, role, task, model,
    port: PORT,
    spawnedBy: "cockpit",
  });
  if (result.success) {
    sysMsg("coordination", `🟢 Cockpit lance "${name}" en mode daemon dans ${projectPath.split(/[/\\]/).pop()}`);
    pushDashboardUpdate();
  }
  res.json(result);
});

// GET /api/agents — list all spawned agents grouped by project
app.get("/api/agents", (req, res) => {
  const registry = loadSpawnRegistry();
  const liveSessions = [...state.sessions.values()];

  const agents = registry.map(entry => {
    const live = liveSessions.find(s => s.name === entry.name);
    return {
      name: entry.name,
      role: entry.role,
      project: entry.repo_path ? entry.repo_path.replace(/\\/g, "/").split("/").pop() : null,
      projectPath: entry.repo_path,
      mode: entry.mode,
      status: live ? "connected" : entry.status,
      pid: entry.pid,
      spawned_by: entry.spawned_by,
      spawned_at: entry.spawned_at,
      ended_at: entry.ended_at,
      online: !!live,
    };
  });

  // Group by project
  const byProject = {};
  for (const a of agents) {
    const proj = a.project || "unknown";
    if (!byProject[proj]) byProject[proj] = [];
    byProject[proj].push(a);
  }

  res.json({ agents, byProject });
});

app.post("/api/projects/:slug/inject", async (req, res) => {
  try {
    const registry = loadRegistry();
    const project = registry.projects.find(p => p.slug === req.params.slug);
    if (!project) {
      return res.status(404).json({ error: `Project "${req.params.slug}" not found in registry` });
    }
    const serverUrl = `http://localhost:${PORT}`;
    await injectProject(project, serverUrl);
    res.json({ status: "ok", message: `WikiChat overlay injected into ${project.name}`, slug: project.slug });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── .wikichat/ folder API ──────────────────────────────────────────────────────
// These routes let the dashboard/game read .wikichat/ content directly.
// Each project has its own .wikichat/ overlay; global knowledge lives in ~/.wikichat/

const GLOBAL_WIKICHAT = join(homedir(), ".wikichat");

// Safely resolve a .wikichat sub-path for a project (path traversal guard)
function resolveWikiChatPath(projectPath, ...parts) {
  const base = join(projectPath, ".wikichat");
  const resolved = join(base, ...parts);
  if (!resolved.startsWith(base)) throw new Error("Path traversal blocked");
  return resolved;
}

// List artifacts for a project
app.get("/api/projects/:slug/wikichat/artifacts", async (req, res) => {
  try {
    const registry = loadRegistry();
    const project = registry.projects.find(p => p.slug === req.params.slug);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const dir = resolveWikiChatPath(project.path, "artifacts");
    const files = await readdir(dir).catch(() => []);
    const items = await Promise.all(
      files
        .filter(f => [".md", ".json", ".txt"].includes(extname(f)))
        .map(async (f) => {
          const fp = join(dir, f);
          const s = await stat(fp).catch(() => null);
          return s ? { name: f, size: s.size, modified: s.mtime, path: fp } : null;
        })
    );
    res.json({ slug: req.params.slug, artifacts: items.filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read a specific artifact file for a project
app.get("/api/projects/:slug/wikichat/artifacts/:filename", async (req, res) => {
  try {
    const registry = loadRegistry();
    const project = registry.projects.find(p => p.slug === req.params.slug);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const fp = resolveWikiChatPath(project.path, "artifacts", req.params.filename);
    const content = await readFile(fp, "utf8");
    const ext = extname(req.params.filename);
    if (ext === ".json") {
      try { return res.json(JSON.parse(content)); } catch { /* fall through */ }
    }
    res.type("text/plain").send(content);
  } catch (e) {
    res.status(404).json({ error: "File not found" });
  }
});

// Read context.json for a project
app.get("/api/projects/:slug/wikichat/context", async (req, res) => {
  try {
    const registry = loadRegistry();
    const project = registry.projects.find(p => p.slug === req.params.slug);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const fp = resolveWikiChatPath(project.path, "context.json");
    const raw = await readFile(fp, "utf8").catch(() => "{}");
    res.json(JSON.parse(raw));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List knowledge bases (global ~/.wikichat/knowledge/)
app.get("/api/knowledge", async (_req, res) => {
  try {
    const dir = join(GLOBAL_WIKICHAT, "knowledge");
    const topics = await readdir(dir).catch(() => []);
    const bases = await Promise.all(topics.map(async (topic) => {
      const topicDir = join(dir, topic);
      const s = await stat(topicDir).catch(() => null);
      if (!s?.isDirectory()) return null;

      const files = await readdir(topicDir).catch(() => []);
      let summary = "";
      if (files.includes("kb.md")) {
        const kbPath = join(topicDir, "kb.md");
        const content = await readFile(kbPath, "utf8").catch(() => "");
        summary = content.split("\n").slice(0, 3).join(" ").slice(0, 200);
      }
      return { topic, files, summary, path: topicDir, modified: s.mtime };
    }));
    res.json({ knowledgeBases: bases.filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Read a specific knowledge base file
app.get("/api/knowledge/:topic/:file", async (req, res) => {
  try {
    const fp = join(GLOBAL_WIKICHAT, "knowledge", req.params.topic, req.params.file);
    // Guard against path traversal
    const base = join(GLOBAL_WIKICHAT, "knowledge");
    if (!fp.startsWith(base)) return res.status(403).json({ error: "Forbidden" });

    const content = await readFile(fp, "utf8");
    if (extname(req.params.file) === ".json") {
      try { return res.json(JSON.parse(content)); } catch { /* fall through */ }
    }
    res.type("text/plain").send(content);
  } catch (e) {
    res.status(404).json({ error: "File not found" });
  }
});

// Global artifacts (wikichat project itself)
app.get("/api/wikichat/artifacts", async (_req, res) => {
  try {
    const dir = join(import.meta.dirname, ".wikichat", "artifacts");
    const files = await readdir(dir).catch(() => []);
    const items = await Promise.all(
      files
        .filter(f => [".md", ".json", ".txt"].includes(extname(f)))
        .map(async (f) => {
          const fp = join(dir, f);
          const s = await stat(fp).catch(() => null);
          return s ? { name: f, size: s.size, modified: s.mtime } : null;
        })
    );
    res.json({ artifacts: items.filter(Boolean) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/wikichat/artifacts/:filename", async (req, res) => {
  try {
    const dir = join(import.meta.dirname, ".wikichat", "artifacts");
    const fp = join(dir, req.params.filename);
    if (!fp.startsWith(dir)) return res.status(403).json({ error: "Forbidden" });
    const content = await readFile(fp, "utf8");
    res.type("text/plain").send(content);
  } catch (e) {
    res.status(404).json({ error: "File not found" });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({
    name: "MCP WikiChat", version: "2.0.0", status: "running",
    sessions: state.sessions.size,
    channels: [...state.channels.keys()].filter(c => !c.startsWith("dm:")),
    totalMessages: state.messages.length,
    uptime: Math.floor(process.uptime()),
    dashboard: `http://localhost:${PORT}/dashboard`,
  });
});

// Status dump
app.get("/status", (req, res) => {
  res.json({
    sessions: [...state.sessions.entries()].map(([id, s]) => ({
      id: id.slice(0, 8), name: s.name, role: s.role, status: s.status,
      availability: s.availability, connectedAt: s.connectedAt, lastSeen: s.lastSeen,
      skills: s.skills, current_task: s.current_task, current_project: s.current_project,
    })),
    channels: [...state.channels.entries()].filter(([n]) => !n.startsWith("dm:"))
      .map(([name, info]) => ({ name, description: info.description, messageCount: getChannelCount(name) })),
    projects: [...state.projects.values()].map(p => ({ name: p.name, description: p.description, activeTasks: [...p.tasks.values()].filter(t => t.status === "active").length })),
    totalMessages: state.messages.length,
  });
});

// Health endpoint with memory/performance metrics
app.get("/api/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "healthy",
    uptime: Math.floor(process.uptime()),
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024) + "MB",
      heap: Math.round(mem.heapUsed / 1024 / 1024) + "/" + Math.round(mem.heapTotal / 1024 / 1024) + "MB",
    },
    sessions: state.sessions.size,
    registeredSessions: [...state.sessions.values()].filter(s => !s.name.startsWith("session-")).length,
    channels: state.channels.size,
    messages: state.messages.length,
    readReceipts: state.reads.size,
    waiters: state.waiters.size,
    spawnRegistry: loadSpawnRegistry().length,
  });
});

// ── Listen ─────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || "3777");
const HOST = process.env.HOST || "127.0.0.1";

app.listen(PORT, HOST, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║           MCP WikiChat Server v2.0.0             ║
╠══════════════════════════════════════════════════╣
║                                                  ║
║  🌐 http://localhost:${PORT}                       ║
║  📡 SSE:  http://localhost:${PORT}/sse               ║
║  📊 Dashboard: http://localhost:${PORT}/dashboard    ║
║                                                  ║
╚══════════════════════════════════════════════════╝
  `);
});
