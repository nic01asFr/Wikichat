#!/usr/bin/env node
/**
 * MCP WikiChat Server v2
 *
 * Single-file entry point. All logic is in src/.
 *   src/state.mjs        — shared in-memory state
 *   src/persistence.mjs  — atomic file I/O (sessions, projects, spawn registry)
 *   src/notifier.mjs     — long-poll waiter/notification system
 *   src/tools.mjs        — all MCP tool definitions
 *   src/events.mjs       — bus d'événements système (détecteurs → triggers)
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { randomUUID } from "crypto";
import { readdir, readFile } from "fs/promises";
import { readFileSync, readdirSync, statSync, unlinkSync } from "fs";
import { join, extname } from "path";
import { homedir } from "os";

import { state, sysMsg, pushMessage, getSessionByName, setOnMessagePush, addMessageListener, rebuildChannelCounts, getChannelCount, markActivity, recentlyActive, isAgentInDMChannel, inboxFor } from "./src/state.mjs";
import { loadProjects, saveSnapshot, saveProject, loadSpawnRegistry, gcSpawnRegistry, saveChannels, loadChannels, saveMessagesDebounced, loadMessages, flushSpawnRegistry, SESSION_STORE, getIdentityBinding, saveIdentityBinding, touchIdentityBinding } from "./src/persistence.mjs";
import { loadMemories, flushMemories, restoreIdentity, remember, recall } from "./src/identity.mjs";
import { startWatchdog, loadCronRegistry } from "./src/resilience.mjs";
import { clearWaiters, notifyWaiters } from "./src/notifier.mjs";
import { registerTools } from "./src/tools.mjs";
import { registerResources } from "./src/resources.mjs";
import { handlePilotePage, handlePiloteData, handlePiloteToggle, handlePiloteFire, handlePiloteCreate, handlePiloteDelete, handlePiloteDecide, handlePiloteApply, handlePiloteContinue, handlePiloteArchitect, handlePiloteTools, handlePiloteDaemon, handlePiloteTranscript, startPiloteCatchup } from "./src/pilote.mjs";
import { scanForProjects } from "./src/scanner.mjs";
import { loadRegistry, saveRegistry, loadConfig, mergeProjects } from "./src/registry.mjs";
import { injectProject, pickupQueue, readLocalArtifacts } from "./src/injector.mjs";
import { spawnHeadless, spawnDaemon, sampleSession, triggerProjectAgent, currentLoad, checkBudget, quotaSnapshot, getMaxSpawnDepth } from "./src/sampler.mjs";
import { configureTriggers, loadTriggers, runLifecycleTriggers, shutdownTriggers, notifyMessageForTriggers, fireWebhook } from "./src/triggers.mjs";
import { configureRoutines, loadRoutines, runRoutine } from "./src/routines.mjs";
import { bootstrapAutonomousTeam } from "./src/team-bootstrap.mjs";
import { reconcileDaemonsAtBoot, shutdownDaemons, fullCleanup } from "./src/daemon-lifecycle.mjs";
import { startDormantWatch, status as dormantStatus, setManualOverride, isActive, onWake, onSleep } from "./src/dormant.mjs";
import { scanForChanges } from "./src/snapshot.mjs";
import { emitEvent } from "./src/events.mjs";
import { ensureUserOverlay } from "./src/overlay-installer.mjs";
import { createIdea, updateIdea, listIdeas, getIdea, ideaStats, deleteIdea, searchIdeas } from "./src/ideas.mjs";
import { auditProject, auditMany } from "./src/repo-audit.mjs";
import { runHarmonizer, formatHarmonizerSummary } from "./src/harmonizer.mjs";


// ── Boot ──────────────────────────────────────────────────────────────────────

// Auto-install Claude Code overlay (skill + slash commands + ~/.claude/CLAUDE.md
// section) so any session that opens with wikichat MCP attached uses it
// naturally. Idempotent — skips if already installed. Disable via
// WIKICHAT_NO_OVERLAY_INSTALL=1.
ensureUserOverlay();

loadChannels();   // Restore persisted channels
loadMessages();   // Restore recent messages
rebuildChannelCounts(); // Build O(1) channel count cache
setOnMessagePush(saveMessagesDebounced); // Auto-persist on new messages
loadProjects();
loadMemories();   // Restore persistent agent memories (remember/recall)
const _spawnGc = gcSpawnRegistry(); // Drop legacy/stale entries from spawn_registry
if (_spawnGc.dropped || _spawnGc.fixed) {
  console.log(`[boot] spawn_registry GC : dropped=${_spawnGc.dropped} fixed=${_spawnGc.fixed} kept=${_spawnGc.total}`);
}

// Configure trigger engine (Phase 5) — wire spawn handler + budget guard
configureTriggers({
  spawnFn: async (params) => {
    const repo = params.repo_path || process.cwd();
    if (params.mode === "daemon") {
      return spawnDaemon(repo, params);
    }
    return spawnHeadless(repo, params.prompt || "register puis attends des instructions.", params);
  },
  budgetCheckFn: checkBudget,
  // routineFn is wired below after configureRoutines (forward via lazy import)
});
loadTriggers();    // Restore persisted triggers
addMessageListener(notifyMessageForTriggers); // Wire mention/channel_match triggers
reconcileDaemonsAtBoot();  // Mark dead PIDs as ended (cleanup before re-spawn)

// Configure routines engine — wire spawn / broadcast / pollTicket / shareArtifact
configureRoutines({
  spawn: async (params) => {
    const repo = params.repo_path || process.cwd();
    const opts = { ...params, parentDepth: params.parentDepth ?? 0 };
    const ticketId = randomUUID().slice(0, 8);
    if (params.mode === "daemon") {
      const r = spawnDaemon(repo, opts);
      return { success: r.success, pid: r.pid, error: r.error, ticketId };
    }
    // headless: fire-and-forget but return ticket immediately
    state.spawnTickets.set(ticketId, {
      id: ticketId, name: params.name, mode: "headless", repo,
      spawnedBy: opts.spawnedBy, spawnerId: null,
      status: "running", createdAt: new Date(),
      completedAt: null, result: null,
    });
    spawnHeadless(repo, params.prompt || params.task || "register puis exécute la mission.", opts).then(res => {
      const t = state.spawnTickets.get(ticketId);
      if (t) {
        t.status = res.success ? "completed" : "failed";
        t.completedAt = new Date();
        t.result = { success: res.success, exitCode: res.exitCode };
      }
      notifyWaiters("__tickets__", null);
    }).catch(() => {});
    return { success: true, ticketId };
  },
  broadcast: ({ channel, content }) => {
    const m = sysMsg(channel || "coordination", content);
    notifyWaiters(channel || "coordination", null);
    return m;
  },
  pollTicket: async (ticketId, timeoutS = 120) => {
    const t = state.spawnTickets.get(ticketId);
    if (!t) return { error: "ticket not found", ticketId };
    if (t.status === "completed" || t.status === "failed") return { ...t };
    // Poll with timeout
    const deadline = Date.now() + (timeoutS * 1000);
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      if (t.status === "completed" || t.status === "failed") return { ...t };
    }
    return { ...t, timeout: true };
  },
  shareArtifact: ({ channel, title, content }) => {
    const m = pushMessage({
      id: randomUUID(), from: "routine", fromName: "🤖 Routine",
      channel: channel || "coordination",
      content: `📎 ${title}\n${"─".repeat(40)}\n${content}\n${"─".repeat(40)}`,
      type: "artifact", timestamp: new Date(),
    });
    notifyWaiters(channel || "coordination", null);
    return m;
  },
});
loadRoutines();   // Restore persisted routines

// Now that routines is loaded, finish wiring triggers (so trigger action
// type "run_routine" can call into the routines engine).
configureTriggers({
  spawnFn: async (params) => {
    const repo = params.repo_path || process.cwd();
    if (params.mode === "daemon") return spawnDaemon(repo, params);
    return spawnHeadless(repo, params.prompt || "register puis attends des instructions.", params);
  },
  budgetCheckFn: checkBudget,
  routineFn: (id, params, opts) => runRoutine(id, params, opts),
});

// Phase 6 PR6 — start dormant gate watcher + wire wake/sleep callbacks.
// On wake: re-fire lifecycle triggers (covers the case where principal arrives
// after server boot). On sleep: log and let watchdog/quota mechanisms do the
// rest — no force-kill of residents (graceful drift, daemons can finish
// in-flight work).
onWake(() => {
  console.log("[Dormant] WAKE — firing lifecycle triggers");
  runLifecycleTriggers().catch(() => {});
});
onSleep(() => {
  console.log("[Dormant] SLEEP — triggers will refuse to fire until wake");
});
// Rattrapage : les agents du pilote dont un cron a été manqué pendant le sommeil
// sont relancés une fois dès le réveil (calculé depuis schedule + last_fired).
startPiloteCatchup();
startDormantWatch();

const teamResult = bootstrapAutonomousTeam();
if (teamResult.provisioned > 0) {
  console.log(`[WikiChat] Autonomous team: ${teamResult.provisioned}/${teamResult.total} triggers provisioned`);
}

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
  }
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
  try { flushMemories(); } catch { /* */ }
  try { shutdownTriggers(); } catch { /* */ }
  try { shutdownDaemons(); } catch { /* */ }

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
  // Idle gate : agents only write to queue/artifacts when active. If we've
  // been idle, nothing new to recover. Skip the 120-projects scan.
  if (!recentlyActive(5 * 60 * 1000)) return;
  try {
    const registry = loadRegistry();
    for (const p of registry.projects.filter(q => q.status !== "missing")) {

      // 1. Queue pickup (offline actions from agents)
      const items = await pickupQueue(p).catch(() => []);
      if (items.length > 0) {
        console.log(`[WikiChat] Picked up ${items.length} queue item(s) from ${p.slug}`);
        for (const item of items) {
          sysMsg("coordination", `📥 [${p.slug}] ${item.agent}: ${item.type}${item.data?.message ? " — " + item.data.message : ""}`);
          emitEvent("queue", `${p.slug} — ${item.agent} a déposé "${item.type}" hors ligne`, { project: p.slug, agent: item.agent });
        }
      }

      // 2. Local artifact pickup (reports written by headless agents even when MCP was down)
      const artifacts = await readLocalArtifacts(p).catch(() => []);
      if (artifacts.length > 0) {
        console.log(`[WikiChat] Recovered ${artifacts.length} local artifact(s) from ${p.slug}`);
        for (const art of artifacts) {
          sysMsg("coordination", `📄 [${p.slug}] ${art.agent} → "${art.title}" (récupéré localement)`);
          emitEvent("artifact", `${p.slug} — ${art.agent} a produit "${art.title}"`, { project: p.slug, agent: art.agent });
        }
      }

    }
  } catch (e) {
    console.error("[WikiChat] Queue/artifact pickup error:", e.message);
  }
}, 2 * 60 * 1000);

// Cleanup interval: orphan tasks (TTL expired) + stale sessions
let _cleanupInProgress = false;
setInterval(async () => {
  if (_cleanupInProgress) {
    console.warn("[Cleanup] previous run still in progress — skipping this tick");
    return;
  }
  // Idle gate : skip the entire cleanup body if nothing user-relevant happened
  // in the last 5 minutes. The service should consume ~0 CPU when idle.
  if (!recentlyActive(5 * 60 * 1000)) return;
  _cleanupInProgress = true;
  try {
  const now = new Date();
  for (const proj of state.projects.values()) {
    let changed = false;
    for (const [id, task] of proj.tasks) {
      if (task.status === "active" && task.claim_expires_at && new Date(task.claim_expires_at) < now) {
        task.status = "abandoned";
        task.outcome = "TTL expiré — libéré automatiquement";
        task.completedAt = now;
        proj.blockers.push(`${id}: claim expiré (${task.claimedBy} injoignable ?)`);
        emitEvent("task-expired", `${proj.name} — tâche ${id} libérée (${task.claimedBy} injoignable)`, { project: proj.name, agent: task.claimedBy });
        changed = true;
        sysMsg("coordination", `⏰ Tâche "${id}" libérée automatiquement (TTL expiré — ${task.claimedBy} injoignable)`);
      }
    }
    if (changed) saveProject(proj);
  }
  // Stale marking (15 min) + eviction (default 30 min). A session is only ever
  // removed by the SSE `res.on("close")` handler; when a connection drops without
  // firing `close` (network blip, Claude Code reconnecting under a fresh sessionId),
  // the orphaned entry lingers in the Map forever — just flagged "stale". Over long
  // uptimes these ghosts accumulate. We evict any session quiet past the threshold,
  // replicating the close-handler cleanup (snapshot → transport → waiters → delete).
  // Eviction is non-destructive: a registered session's identity is snapshotted and
  // restored on reconnect via its bind token, so a resident evicted by mistake simply
  // re-attaches. lastSeen is bumped on every POST /messages, so polling daemons stay
  // fresh and are never evicted in normal operation.
  const EVICT_MS = parseInt(process.env.WIKICHAT_SESSION_EVICT_MS || `${30 * 60 * 1000}`);
  for (const [id, s] of state.sessions) {
    const quietMs = Date.now() - new Date(s.lastSeen);
    if (quietMs > EVICT_MS) {
      const wasRegistered = !s.name.startsWith("session-");
      if (wasRegistered) { try { saveSnapshot(s); } catch { /* best-effort */ } }
      state.sessions.delete(id);
      transports.delete(id);
      clearWaiters(id);
      console.log(`[WikiChat] evicted stale session ${s.name} (quiet ${Math.round(quietMs / 60000)}min, total: ${state.sessions.size})`);
    } else if (quietMs > 15 * 60 * 1000 && s.availability !== "stale") {
      s.availability = "stale";
    }
  }
  // DM channel garbage collection — only drop channels that are TRULY empty
  // (no message left in the buffer). Previously this deleted any DM channel with
  // no message in the last 30 min, even when older messages were still buffered —
  // which threw away the channel's `participants` list and silently broke DM
  // visibility for those still-present messages (read_messages/poll_messages fall
  // back to participants when the key doesn't contain the reader's current name).
  // A channel can't outlive its messages, so memory stays bounded by the buffer cap.
  for (const [name] of state.channels) {
    if (!name.startsWith("dm:")) continue;
    const hasAnyMsg = state.messages.some(m => m.channel === name);
    if (!hasAnyMsg) {
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
    const changed = await scanForChanges(projects);
    if (changed.length > 0) {
      // Un événement par changement, pas un message par projet : les triggers
      // matchent sur un type précis (`[event:commits`), pas sur un résumé
      // multi-lignes où plusieurs types se mélangeraient.
      for (const { project, changes } of changed) {
        if (changes.type === "new") {
          emitEvent("new-project", `${project.name} — premier snapshot`, { project: project.name });
          continue;
        }
        for (const c of (changes.changes || [])) {
          emitEvent(c.type, `${project.name} — ${c.detail}`, { project: project.name });
        }
      }
      console.log(`[WikiChat] Change detection: ${changed.length} project(s) changed`);
    }
  } catch (e) {
    console.error("[WikiChat] Change detection error:", e.message);
  }

  } finally { _cleanupInProgress = false; }
}, 5 * 60 * 1000);

// ── Express ───────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Admin endpoint to override dormant gate manually
app.post("/api/admin/dormant/override", (req, res) => {
  const { value } = req.body || {};
  res.json(setManualOverride(value === null || value === undefined ? null : !!value));
});
app.get("/api/admin/dormant", (_req, res) => res.json(dormantStatus()));

const transports = new Map(); // sessionId → { transport, server }

app.post("/api/routines/run", express.json(), async (req, res) => {
  try {
    const { id, params } = req.body || {};
    const result = await runRoutine(id, params || {}, { spawnedBy: "rest-api" });
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Les maquettes de design (concepts, hybrid-concepts, style-guide, game) vivent
// désormais dans docs/design/ : ce sont des documents de travail, pas des pages
// servies en production.
app.get("/pilote", handlePilotePage);
app.get("/pilote/api/data", handlePiloteData);
app.get("/pilote/api/tools", handlePiloteTools);
app.post("/pilote/api/daemon", handlePiloteDaemon);
app.get("/pilote/api/agent/:id/transcript", handlePiloteTranscript);
app.post("/pilote/api/agent", handlePiloteCreate);
app.post("/pilote/api/architect", handlePiloteArchitect);
app.post("/pilote/api/agent/:id/toggle", handlePiloteToggle);
app.post("/pilote/api/agent/:id/fire", handlePiloteFire);
app.post("/pilote/api/agent/:id/continue", handlePiloteContinue);
app.post("/pilote/api/agent/:id/decide", handlePiloteDecide);
app.post("/pilote/api/agent/:id/apply", handlePiloteApply);
app.delete("/pilote/api/agent/:id", handlePiloteDelete);

// MCP SSE endpoint
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const sid = transport.sessionId;
  const mcpServer = new McpServer({ name: "mcp-wikichat", version: "2.0.0" });

  // Stable identity token carried by the client on EVERY connect (survives the
  // transport sessionId changing across reconnects). Two delivery styles, same
  // mechanism: `?agent=<Name>` is the identity directly; `?token=`/header is an
  // opaque token bound to a name on first register(). See src/persistence.mjs.
  const directName = (req.query.agent || "").trim() || null;
  const bindToken = directName
    || (req.query.token || "").trim()
    || (req.headers["x-wikichat-token"] || "").toString().trim()
    || null;

  const session = {
    sessionId: sid,
    name: `session-${sid.slice(0, 6)}`,
    connectedAt: new Date(), lastSeen: new Date(),
    role: null, status: null,
    eta: null, etaReason: null,
    cron_job_id: null, cron_purpose: null,
    skills: [], current_task: null, current_project: null,
    availability: "available",
    storage_path: null,
    bindToken, // used by register() to persist the token→identity binding
  };
  state.sessions.set(sid, session);
  transports.set(sid, { transport, server: mcpServer });

  // Auto-restore identity from the token if we know it (or if ?agent=Name is
  // authoritative). This is what makes "register once, recognised forever" work:
  // the agent never has to re-register after a reconnect.
  let claimName = null, claimRole = null;
  if (directName) {
    claimName = directName; // authoritative on every connect
  } else if (bindToken) {
    const ident = getIdentityBinding(bindToken);
    if (ident) { claimName = ident.name; claimRole = ident.role; }
  }
  if (claimName) {
    const holder = getSessionByName(claimName);
    if (!holder || holder.id === sid) {
      session.name = claimName;
      if (claimRole) session.role = claimRole;
      session.availability = "available";
      try { restoreIdentity(session, claimName); } catch { /* best-effort */ }
      try { saveIdentityBinding(bindToken, claimName, session.role); } catch { /* */ }
      sysMsg("system", `${claimName} connecté — identité ${directName ? "fixée" : "restaurée"} automatiquement.`);
    } else {
      // Name currently held by another live session: don't steal it. Stay
      // anonymous; register() will arbitrate (stale-takeover) if appropriate.
      console.log(`[WikiChat] identité "${claimName}" occupée — ${sid.slice(0, 8)} reste anonyme`);
    }
  }
  console.log(`[WikiChat] +session ${sid.slice(0, 8)}${session.name.startsWith("session-") ? "" : ` (${session.name})`} (total: ${state.sessions.size})`);

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
    }
    console.log(`[WikiChat] -session ${name} (total: ${state.sessions.size})`);
  });

  registerTools(mcpServer, sid);
  registerResources(mcpServer, sid);
  await mcpServer.connect(transport);
});

// MCP POST messages
app.post("/messages", async (req, res) => {
  // Distinguish real intent (tool/resource calls) from MCP handshake noise
  // (initialize, notifications/initialized) — only the former counts as activity.
  const method = req.body?.method;
  if (method && (method.startsWith("tools/") || method.startsWith("resources/") || method.startsWith("prompts/"))) {
    markActivity();
  }
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
  }).catch(() => {});

  res.json({
    jobName,
    action,
    projectSlug,
    status: "running",
    artifactsIn: `${project.path}/.wikichat/artifacts/`,
    note: "Résultat disponible dans 1-3min via artifacts",
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

  res.json({ ok: true, id: msg.id, channel: targetChannel });
});

// GET /api/messages — fetch messages filtered by channel
app.get("/api/messages", (req, res) => {
  const { channel, limit = "50", since_id, since_minutes } = req.query;
  let msgs = state.messages;
  if (channel && channel !== "__all__") {
    msgs = msgs.filter(m => m.channel === channel);
  }
  // since_id : return only messages AFTER this id (exclusive) — enables incremental polling.
  // If the id is not found (server restart, eviction) → return empty so caller knows
  // it needs to re-sync. The caller should fall back to since_minutes on empty response.
  if (since_id) {
    const idx = msgs.findIndex(m => m.id === since_id);
    if (idx >= 0) msgs = msgs.slice(idx + 1);
    else msgs = []; // id not in current buffer → caller must re-sync
  }
  // since_minutes : return only messages from last N minutes
  if (since_minutes) {
    const cutoff = Date.now() - parseFloat(since_minutes) * 60 * 1000;
    msgs = msgs.filter(m => new Date(m.timestamp).getTime() >= cutoff);
  }
  const n = Math.min(parseInt(limit) || 50, 200);
  res.json(msgs.slice(-n));
});

// GET /api/inbox — messages addressed to a specific agent (DMs, @mentions,
// broadcasts), for the Stop-hook "mailbox check". Lets an active-but-not-polling
// agent learn it's being contacted at its next turn boundary, no human in the loop.
//
// Cursor protocol: pass the last id you saw via since_id; the response gives the
// new lastId to store. Without since_id, pass since_minutes=N to catch recent
// unread on first activation (so already-pending messages aren't missed); with
// neither, an empty baseline + current lastId is returned (arm without replay).
app.get("/api/inbox", (req, res) => {
  const agent = (req.query.agent || "").toString().trim();
  if (!agent) { res.status(400).json({ error: "agent required" }); return; }
  const sinceMin = parseFloat(req.query.since_minutes) || 0;

  // Unified cursor : the server owns ONE cursor per identity, in the same
  // persistent identity memory used by the `poll` MCP tool. So push (this hook
  // endpoint) and pull (poll) share a single position — a message delivered one
  // way is never re-delivered the other way. An explicit since_id query param
  // still overrides (legacy callers), but the server cursor is the default and
  // is always advanced afterwards.
  const explicitSince = (req.query.since_id || "").toString().trim() || null;
  const serverCursor = recall(agent, "__inbox_cursor");
  const sinceId = explicitSince || serverCursor || null;

  const result = inboxFor(agent, { sinceId, sinceMinutes: sinceMin });

  // Advance the shared cursor to the newest id we just accounted for (covers
  // resync/baseline too — arm at the head without replaying history).
  if (result.lastId) remember(agent, "__inbox_cursor", result.lastId);

  const messages = result.messages.map(m => ({
    id: m.id, from: m.fromName, channel: m.isDM ? "DM" : m.channel, isDM: !!m.isDM,
    content: m.content, timestamp: m.timestamp,
    status: m.status ?? null, expects_reply: m.expects_reply ?? null, eta_seconds: m.eta_seconds ?? null,
  }));

  res.json({
    agent, count: messages.length, messages,
    lastId: result.lastId ?? sinceId,
    ...(result.resynced ? { resynced: true } : {}),
    ...(result.baseline ? { baseline: true } : {}),
  });
});

// POST /api/identity — an agent (via its Stop hook) reports its stable Claude
// session id + cwd, bound to its WikiChat name. This is the missing link that
// makes `contact_agent` able to RESUME an offline agent: the agent itself can't
// read $CLAUDE_SESSION_ID, but the hook gets it from stdin and reports it here.
// Stored in the identity memory (same place register() persists it).
app.post("/api/identity", express.json(), (req, res) => {
  const { name, claude_session_id, cwd } = req.body || {};
  if (!name || String(name).startsWith("session-")) { res.status(400).json({ error: "name required" }); return; }
  if (claude_session_id) {
    remember(name, "__claude_session_id", claude_session_id);
    const found = getSessionByName(name);
    if (found) { const live = state.sessions.get(found.id); if (live) live.claude_session_id = claude_session_id; }
  }
  if (cwd) remember(name, "__cwd", cwd);
  res.json({ ok: true, name });
});

// POST /api/spawn/daemon — launch a persistent background agent
// Body: { projectPath, name, role?, task? }
app.post("/api/spawn/daemon", (req, res) => {
  const { projectPath, name, role, task, model } = req.body || {};
  if (!projectPath || !name) return res.status(400).json({ error: "projectPath and name required" });
  const result = spawnDaemon(projectPath, {
    name, role, task, model,
    port: PORT,
    spawnedBy: "rest-api",
  });
  if (result.success) {
    sysMsg("coordination", `🟢 Cockpit lance "${name}" en mode daemon dans ${projectPath.split(/[/\\]/).pop()}`);
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
// Ces routes exposent le contenu de .wikichat/ aux agents et aux clients REST.
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
    pilote: `http://localhost:${PORT}/pilote`,
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
    budget: { current: currentLoad(), max: parseInt(process.env.WIKICHAT_MAX_SESSIONS || "10") },
    spawn_depth_max: getMaxSpawnDepth(),
    quotas: quotaSnapshot(),
  });
});

// Admin: kill all running daemons + reconcile registry. Use when something feels off.
app.post("/api/admin/cleanup", (_req, res) => {
  try { res.json(fullCleanup()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Webhook trigger endpoint : fire a registered webhook trigger by id with arbitrary payload.
// curl -X POST http://localhost:3777/api/triggers/webhook/<id> -d '{...}'
app.post("/api/triggers/webhook/:id", async (req, res) => {
  try {
    const result = await fireWebhook(req.params.id, req.body || {}, `webhook:${req.headers["user-agent"] || "unknown"}`);
    if (result?.ok === false) return res.status(400).json(result);
    res.json(result || { ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
║  🛠️  Pilote: http://localhost:${PORT}/pilote          ║
║                                                  ║
╚══════════════════════════════════════════════════╝
  `);
  // Phase 5: fire lifecycle triggers (spawn résidents si configurés)
  runLifecycleTriggers().catch(() => {});
});
