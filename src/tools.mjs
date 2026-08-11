/**
 * tools.mjs — All MCP tool definitions.
 * Grouped by category with clear section headers.
 */

import { randomUUID } from "crypto";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

import {
  state, pushMessage, sysMsg, getSessionByName, getSessionName,
  dmChannelKey, isAgentInDMChannel, resolveAgentName, timeSince, timeUntil, cronInMinutes, overlapScore, getEtaSummary,
  getChannelCount, inboxFor,
} from "./state.mjs";
import { scanForProjects } from "./scanner.mjs";
import { loadRegistry, loadConfig, saveRegistry, mergeProjects } from "./registry.mjs";
import { injectProject } from "./injector.mjs";
import { notifyWaiters, registerWaiter } from "./notifier.mjs";
import {
  saveSnapshot, loadSnapshot, saveProject, loadSpawnRegistry,
  upsertSpawnRegistry, getAgentStoragePath, writeAgentFile,
  SESSION_STORE, saveIdentityBinding, getIdentityBinding,
} from "./persistence.mjs";
import { recordHeartbeat, loadCronRegistry, saveCronRegistry, upsertCron, deleteCron } from "./resilience.mjs";
import { spawnHeadless, spawnDaemon, findClaudeBin, PROMPT_TEMPLATES } from "./sampler.mjs";
import { restoreIdentity, remember, recall, forgetKey } from "./identity.mjs";
import { registerTrigger, listTriggers, deleteTrigger, setEnabled, fireTrigger } from "./triggers.mjs";
import { registerRoutine, listRoutines, deleteRoutine, runRoutine } from "./routines.mjs";
import { triggerMemoryPublish } from "./memory-publish-hook.mjs";
import { runCartography } from "./jobs/cartography.mjs";
import { runClustering } from "./jobs/clustering.mjs";
import { createIdea, updateIdea, listIdeas, getIdea, searchIdeas, ideaStats, deleteIdea } from "./ideas.mjs";
import { auditProject, auditMany } from "./repo-audit.mjs";
import { runHarmonizer, formatHarmonizerSummary } from "./harmonizer.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function txt(text) { return { content: [{ type: "text", text }] }; }

function notify(channel, excludeId) {
  notifyWaiters(channel, excludeId);
}

/** Render the coordination protocol of a message so the RECIPIENT can act on it.
 * Without this, status/expects_reply/eta were stored on send but never shown on
 * receive — the "fin de message" turn-taking convention was purely decorative. */
function coordMarkers(msg) {
  const m = [];
  if (msg.status === "over") m.push("🔚 over → à toi");
  else if (msg.status === "standby") m.push(`⏳ standby${msg.eta_seconds ? ` ~${msg.eta_seconds}s` : ""} → n'attends pas`);
  else if (msg.status === "done") m.push("✅ done → rien à répondre");
  if (msg.expects_reply) m.push("❓ réponse attendue");
  if (msg.eta_seconds && msg.status !== "standby") m.push(`⏱️ ETA ${msg.eta_seconds}s`);
  return m.length ? `\n     ⟨${m.join(" · ")}⟩` : "";
}

function formatMsgList(msgs) {
  const lines = msgs.map(msg => {
    const t = new Date(msg.timestamp).toLocaleTimeString("fr-FR");
    const ch = msg.isDM ? "📩DM" : `#${msg.channel}`;
    const re = msg.replyTo ? ` ↩️${msg.replyTo.slice(0, 8)}` : "";
    const readers = state.reads.get(msg.id);
    const ack = readers?.size > 0 ? ` ✓${[...readers].join(",")}` : "";
    return `[${t}] [${ch}] ${msg.fromName}: ${msg.content}${re}\n  └─ id:${msg.id.slice(0, 8)}${ack}${coordMarkers(msg)}`;
  });
  const lastId = msgs.at(-1).id;
  return txt(`🔔 ${msgs.length} nouveau(x) message(s):\n\n${lines.join("\n\n")}\n\n🔖 Dernier: ${lastId.slice(0, 8)}`);
}

/**
 * Resolve an agent's "home" — its project channel. An agent registered in a repo
 * belongs to that project's room: that room is where teammates reach it (by
 * @mention) and what it polls. This is the stable address the volatile display
 * name never was. Resolution order: persisted __home_channel → the session's
 * current_project → the reported cwd matched against the registry (else the
 * cwd's basename). Returns a channel slug, or null if nothing locates a project.
 */
function homeChannelFor(name) {
  if (!name) return null;
  const persisted = recall(name, "__home_channel");
  if (persisted) return persisted;
  const found = getSessionByName(name);
  const sess = found ? state.sessions.get(found.id) : null;
  let proj = sess?.current_project || null;
  if (!proj) {
    const cwd = recall(name, "__cwd");
    if (cwd) {
      const baseName = path.basename(String(cwd).replace(/[\\/]+$/, ""));
      try {
        const norm = p => String(p).replace(/[\\/]+$/, "").toLowerCase();
        const reg = loadRegistry();
        const hit = reg.projects.find(p => p.path && norm(p.path) === norm(cwd));
        proj = hit?.name || hit?.slug || baseName;
      } catch { proj = baseName; }
    }
  }
  if (!proj) return null;
  const slug = "proj-" + String(proj).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug.length > 5 ? slug : null;
}

/**
 * Ensure an agent's home project channel exists, list the agent as a member, and
 * persist the home so future resolutions are O(1). Returns the slug or null.
 */
async function ensureHomeChannel(name) {
  const slug = homeChannelFor(name);
  if (!slug) return null;
  const nameLc = String(name).toLowerCase();
  let ch = state.channels.get(slug);
  if (!ch) {
    ch = { name: slug, description: `🏠 Maison projet — agents y vivent et s'y joignent par @mention`, createdBy: name, createdAt: new Date(), participants: [nameLc] };
    state.channels.set(slug, ch);
  } else {
    if (!Array.isArray(ch.participants)) ch.participants = [];
    if (!ch.participants.includes(nameLc)) ch.participants.push(nameLc);
  }
  remember(name, "__home_channel", slug);
  const found = getSessionByName(name);
  const sess = found ? state.sessions.get(found.id) : null;
  if (sess) sess.home_channel = slug;
  try { const { saveChannels } = await import("./persistence.mjs"); saveChannels(); } catch { /* non-blocking */ }
  return slug;
}

/**
 * buildBriefing — intelligent context for an agent session.
 * Filters by time (since), detects @mentions, and optionally filters by mission keywords.
 */
function buildBriefing(sessionId, { since, mission } = {}) {
  const session = state.sessions.get(sessionId);
  const myName = getSessionName(sessionId);

  // Resolve the "since" cutoff
  let sinceDate = null;
  if (since) {
    // Try as ISO date first, then as message ID
    const parsed = new Date(since);
    if (!isNaN(parsed)) {
      sinceDate = parsed;
    } else {
      const refMsg = state.messages.find(m => m.id.startsWith(since));
      if (refMsg) sinceDate = new Date(refMsg.timestamp);
    }
  }
  if (!sinceDate && session?.lastSeen) {
    sinceDate = new Date(session.lastSeen);
  }

  // Sessions list
  const sl = [...state.sessions.entries()]
    .map(([id, s]) => {
      const me = id === sessionId ? " ← vous" : "";
      const proj = s.current_project ? ` [${s.current_project}]` : "";
      const task = s.current_task ? ` 📋 ${s.current_task}` : "";
      return `  ${s.name}${s.role ? ` (${s.role})` : ""}${proj}${task}${me}`;
    })
    .join("\n");

  // Channels
  const cl = [...state.channels.entries()].filter(([n]) => !n.startsWith("dm:"))
    .map(([n, info]) => `  #${n}: ${getChannelCount(n)} msg — ${info.description}`)
    .join("\n");

  // Projects
  const pl = [...state.projects.values()].map(p => {
    const agents = [...state.sessions.values()].filter(s => s.current_project?.toLowerCase() === p.name.toLowerCase());
    const tasks = [...p.tasks.values()].filter(t => t.status === "active").length;
    return `  📁 ${p.name}${agents.length ? ` | 👥 ${agents.map(a => a.name).join(", ")}` : ""}${tasks ? ` | 📋 ${tasks} tâche(s)` : ""}`;
  }).join("\n");

  // Filter messages visible to this session.
  // DM participants are stored by lowercased agent NAME (stable across reconnects),
  // so we must compare against the name, not the volatile sessionId.
  const myNameLc = getSessionName(sessionId).toLowerCase();
  let msgs = state.messages.filter(m =>
    !m.isDM || (state.channels.get(m.channel)?.participants ?? []).includes(myNameLc)
  );

  // Apply time filter
  if (sinceDate) {
    msgs = msgs.filter(m => new Date(m.timestamp) > sinceDate);
  }

  // Detect @mentions — messages that reference this agent by name
  const mentionPattern = new RegExp(`@${myName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
  const mentions = msgs.filter(m => m.from !== sessionId && mentionPattern.test(m.content));

  // If mission is specified, find messages with keyword overlap
  let missionMsgs = [];
  if (mission) {
    const keywords = mission.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    missionMsgs = msgs.filter(m => {
      const content = m.content.toLowerCase();
      return keywords.some(k => content.includes(k));
    });
  }

  // Recent messages (last 10 if no time filter, or all since cutoff capped at 25)
  const recentMsgs = sinceDate ? msgs.slice(-25) : msgs.slice(-10);

  // Format helpers
  const fmtMsg = m => {
    const t = new Date(m.timestamp).toLocaleTimeString("fr-FR");
    const ch = m.isDM ? "📩DM" : `#${m.channel}`;
    return `  [${t}] [${ch}] ${m.fromName}: ${m.content.slice(0, 200)}${m.content.length > 200 ? "…" : ""}`;
  };

  // Build output
  const sections = [];
  sections.push(
    `╔══════════════════════════════════════╗\n║     MCP WikiChat — Briefing v3       ║\n╚══════════════════════════════════════╝`
  );

  // Time context
  if (sinceDate) {
    sections.push(`⏰ Depuis: ${sinceDate.toLocaleTimeString("fr-FR")} (${timeSince(sinceDate)}) — ${msgs.length} message(s) total`);
  }

  // Priority: @mentions first
  if (mentions.length > 0) {
    sections.push(`🔔 MENTIONS (${mentions.length}):\n${mentions.map(fmtMsg).join("\n")}`);
  }

  // Mission-relevant messages
  if (missionMsgs.length > 0) {
    const unique = missionMsgs.filter(m => !mentions.includes(m));
    if (unique.length > 0) {
      sections.push(`🎯 Pertinent pour "${mission}" (${unique.length}):\n${unique.slice(-10).map(fmtMsg).join("\n")}`);
    }
  }

  // Active topics (agents with current_task)
  const activeTopics = [...state.sessions.values()]
    .filter(s => s.current_task && s.sessionId !== sessionId)
    .map(s => `  📋 ${s.name}: ${s.current_task}`);
  if (activeTopics.length > 0) {
    sections.push(`🔧 En cours (éviter doublons):\n${activeTopics.join("\n")}`);
  }

  // Sessions, projects, channels
  sections.push(`👥 Sessions (${state.sessions.size}):\n${sl || "  (aucune)"}`);
  sections.push(`🗺️ Projets (${state.projects.size}):\n${pl || "  (aucun)"}`);
  sections.push(`📺 Canaux:\n${cl || "  (aucun)"}`);

  // Recent messages (lower priority than mentions)
  const recentFormatted = recentMsgs.map(fmtMsg).join("\n");
  sections.push(`📨 ${sinceDate ? "Nouveaux messages" : "Messages récents"}:\n${recentFormatted || "  (aucun)"}`);

  // Workflow hint
  sections.push(
    `💡 send_message → poll_messages(since_id) — boucle\n` +
    `   remember(key, value) / recall(key) — mémoire persistante\n` +
    `   📊 Dashboard: http://localhost:${process.env.PORT || 3777}/dashboard`
  );

  return txt(sections.join("\n\n"));
}

/** Resolve or create a DM channel, return channel key + resolution info.
 *
 * The target name is normalised via resolveAgentName() — exact match, then
 * session-XXX → real name, then unique prefix/substring — so a DM addressed to
 * "@Bob" reaches an agent registered as "Bob-Dev" instead of vanishing onto a
 * channel nobody reads. The SAME resolver runs on read_messages/poll_messages,
 * so both sides compute the identical channel key. */
function resolveDMChannel(sessionId, targetName) {
  const senderName = getSessionName(sessionId);
  let resolution = resolveAgentName(targetName);
  // A DM must never resolve to its own sender (can happen when the typed target
  // is a substring of the sender's name, e.g. "@Box" while sending as "SenderBox").
  // Treat that as a literal target instead — never silently self-DM.
  if (resolution.matched && resolution.name.toLowerCase() === senderName.toLowerCase()) {
    resolution = { name: targetName, matched: false, online: false };
  }
  const resolvedTarget = resolution.name;

  // The DM channel is keyed by AGENT NAMES (stable across reconnections).
  // Even if the target is currently offline, we can still create the DM
  // channel — the target will see the message when they reconnect under
  // the same name. This makes async DMs work correctly.
  const key = dmChannelKey(senderName, resolvedTarget);
  if (!state.channels.has(key)) {
    state.channels.set(key, {
      name: key,
      description: `DM entre ${senderName} et ${resolvedTarget}`,
      createdBy: "system",
      createdAt: new Date(),
      isDM: true,
      // Participants stored by NAME, not session-id, so reconnections preserve membership
      participants: [senderName.toLowerCase(), resolvedTarget.toLowerCase()],
    });
  }
  return {
    channel: key,
    resolvedTarget,
    typedTarget: targetName,
    matched: resolution.matched,
    online: resolution.online,
  };
}

/**
 * Track the current agent's contribution to a project. Called passively from
 * claim_task / release_task / add_project_note / close_project / declare_project.
 *
 * Maintains <project>/.wikichat/project-state.json#agents{} — a roster of all
 * agents who ever worked on the project, with their last_seen, role, agent_type,
 * claude_session_id (if known), and contributions trail.
 *
 * Enables list_project_agents() + respawn_project_agents() — bringing the whole
 * team back when revisiting a project later.
 */
function trackAgentOnProject(sessionId, project, contribution) {
  const session = state.sessions.get(sessionId);
  if (!session) return;
  const name = session.name;
  if (!name || name.startsWith("session-")) return; // anonymous, skip
  const proj = state.projects.get(project);
  if (!proj) return;
  proj.agents = proj.agents || {};
  const now = new Date().toISOString();
  const entry = proj.agents[name] || {
    role: session.role || null,
    agent_type: session.agent_type || "interactive",
    claude_session_id: session.claude_session_id || null,
    first_seen: now,
    contributions: [],
    repo_path: session.storage_path ? session.storage_path.replace(/[\\/]\.wikichat[\\/]?$/, "") : null,
  };
  entry.last_seen = now;
  // Keep claude_session_id fresh if session has it now
  if (session.claude_session_id) entry.claude_session_id = session.claude_session_id;
  if (contribution && !entry.contributions.includes(contribution)) {
    entry.contributions.push(contribution);
    if (entry.contributions.length > 20) entry.contributions = entry.contributions.slice(-20);
  }
  proj.agents[name] = entry;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerTools(server, sessionId) {

  // ══ IDENTITY ════════════════════════════════════════════════════════════════

  server.tool(
    "register",
    "S'enregistrer avec un nom identifiable. Chaque session DOIT s'enregistrer en début de conversation. Si tu connais ton claude_session_id (ex: $CLAUDE_SESSION_ID), passe-le pour permettre une reprise via --resume au prochain spawn daemon.",
    {
      name: z.string().describe("Nom d'affichage unique (ex: 'Alice', 'Backend-Dev', 'Reviewer')"),
      role: z.string().optional().describe("Rôle (ex: 'développeur', 'reviewer', 'architecte')"),
      agent_type: z.enum(["interactive", "daemon", "headless"]).default("interactive").describe("Type d'agent: interactive (turn-based, poll quand demandé), daemon (boucle poll permanente), headless (one-shot, exécute et sort)"),
      claude_session_id: z.string().optional().describe("ID de session Claude Code, persisté pour permettre --resume aux prochains spawns daemon."),
    },
    async ({ name, role, agent_type, claude_session_id }) => {
      const conflict = getSessionByName(name);
      if (conflict && conflict.id !== sessionId) {
        // If the conflicting session is stale or disconnected for >5min, release the name.
        // This handles the common case : agent disconnects, reconnects under same name.
        // Without this, the agent had to pick a new name → DM history lost.
        const lastSeenAge = Date.now() - new Date(conflict.lastSeen || conflict.connectedAt).getTime();
        const stale = lastSeenAge > 5 * 60 * 1000 || conflict.availability === "stale";
        if (stale) {
          // Liberate the name : revert old session to anonymous, transfer identity
          const oldSession = state.sessions.get(conflict.id);
          if (oldSession) oldSession.name = `session-${conflict.id.slice(0, 6)}`;
          sysMsg("system", `Identité "${name}" transférée (session précédente stale depuis ${Math.floor(lastSeenAge/60000)}min)`);
        } else {
          const ageMin = Math.floor(lastSeenAge / 60000);
          return txt(`❌ Le nom "${name}" est déjà pris par une session active (vue il y a ${ageMin}min). Choisis un autre nom ou attends qu'elle expire (5min).`);
        }
      }

      const session = state.sessions.get(sessionId);
      if (!session) return txt("❌ Session introuvable.");

      const oldName = session.name;
      session.name = name;
      session.role = role ?? null;
      session.agent_type = agent_type;
      session.lastSeen = new Date();

      // Bind this connection's stable token → identity so future reconnects are
      // recognised automatically without re-registering. This is the durable
      // half of "register once, stay yourself across reconnects".
      if (session.bindToken) {
        try { saveIdentityBinding(session.bindToken, name, role ?? null); } catch { /* non-blocking */ }
      }

      // Migrate DM channel participants when renaming (especially anonymous → real name).
      // Without this, DMs sent to the old name become invisible after registration.
      if (oldName !== name) {
        const oldLc = oldName.toLowerCase();
        const newLc = name.toLowerCase();
        for (const ch of state.channels.values()) {
          if (!ch.isDM || !ch.participants) continue;
          const idx = ch.participants.indexOf(oldLc);
          if (idx >= 0) ch.participants[idx] = newLc;
        }
      }

      // Resolve storage path
      const reg = loadSpawnRegistry();
      const entry = reg.find(e => e.name === name);
      if (entry?.storage_path) {
        session.storage_path = entry.storage_path;
      } else if (!session.storage_path) {
        const fallback = path.join(process.cwd(), "agents", name);
        session.storage_path = fallback;
        upsertSpawnRegistry({ name, type: "peer", storage_path: fallback, registered_at: new Date().toISOString() });
      }
      writeAgentFile(session.storage_path, "", "context.json", JSON.stringify({
        name, role: role ?? null,
        type: entry ? (entry.type ?? "spawned") : "peer",
        storage_path: session.storage_path,
        registered_at: new Date().toISOString(),
      }, null, 2));

      sysMsg("system", oldName !== name
        ? `${oldName} s'est renommé en "${name}"${role ? ` (${role})` : ""}`
        : `${name} s'est enregistré${role ? ` comme ${role}` : ""}`);
      notify("general", sessionId);

      const others = [...state.sessions.entries()]
        .filter(([id]) => id !== sessionId)
        .map(([, s]) => `  • ${s.name}${s.role ? ` (${s.role})` : ""}`)
        .join("\n");

      // Persist claude_session_id (Solution C — enables --resume on respawn)
      if (claude_session_id) {
        remember(name, "__claude_session_id", claude_session_id);
        session.claude_session_id = claude_session_id;
      }

      // Auto-restore identity (skills, current_project, availability, memories)
      const identity = restoreIdentity(session, name);

      // Join your project's home channel — your stable address. Teammates reach
      // you there by @mention; it's what you poll. Best-effort: if your cwd/project
      // isn't known yet (first turn, hook hasn't reported cwd), it resolves later.
      let home = null;
      try { home = await ensureHomeChannel(name); } catch { /* non-blocking */ }
      const homeHint = home
        ? `\n\n🏠 Maison : #${home} — c'est là qu'on te joint (@${name}) et ce que tu relèves avec poll().`
        : `\n\n🏠 Maison : pas encore résolue (projet/cwd inconnu) — elle se fixera dès que ton repo sera connu.`;

      const resumeHint = identity.restored
        ? `\n\n📦 Identité restaurée (${timeSince(identity.snapshotAge)}): ${identity.summary}.` +
          (identity.lastInterlocutors.length
            ? `\n   Derniers interlocuteurs: ${identity.lastInterlocutors.slice(0, 3).join(", ")}`
            : "")
        : "";

      const isCurator = role && /curator|curateur|meta|méta/i.test(role);
      const workflowByType = {
        interactive: `💡 Mode interactif (turn-based): ta maison #${home || "(projet)"} te livre tout ce qui t'est adressé via ton hook, à chaque fin de tour — pas de boucle poll.\n   poll() = relever à la demande tout ce qui t'est adressé depuis ton dernier poll (curseur auto). poll(timeout_seconds=N) = rendez-vous synchrone si tu dois attendre une réponse maintenant.\n   Pour joindre quelqu'un : contact_agent(target, message) dépose dans SA maison ; sa réponse revient dans la tienne.`,
        daemon: `💡 Mode daemon: poll_messages(since_id, timeout=120) en boucle permanente\n   Ne terminez jamais — relancez poll après chaque timeout.`,
        headless: `💡 Mode headless: exécutez votre mission → share_artifact → exit\n   Pas de poll, pas de boucle. One-shot.`,
      };
      const workflow = isCurator
        ? `🔍 Mode Méta-Curateur: get_briefing → list_projects → read_agent_history → analyser → share_artifact\n⚠️  Pas besoin de poll_messages.`
        : workflowByType[agent_type] || workflowByType.interactive;

      return txt(
        `✅ Enregistré: "${name}"${role ? ` (${role})` : ""}\n\n` +
        `📡 ${state.sessions.size} session(s)${others ? ":\n" + others : " (vous êtes seul)"}\n\n` +
        `Canaux: ${[...state.channels.keys()].filter(c => !c.startsWith("dm:")).map(c => `#${c}`).join(", ")}\n\n` +
        workflow + homeHint + resumeHint
      );
    }
  );

  // ── set_status ──────────────────────────────────────────────────────────────

  server.tool(
    "set_status",
    "Définir un statut visible par les autres sessions.",
    { status: z.string().describe("Statut (ex: 'en train de coder le module auth')") },
    async ({ status }) => {
      const session = state.sessions.get(sessionId);
      if (session) { session.status = status; session.lastSeen = new Date(); }
      sysMsg("system", `${getSessionName(sessionId)} → statut: "${status}"`);
      notify("general", sessionId);
      return txt(`✅ Statut: "${status}"`);
    }
  );

  // ── remember / recall ───────────────────────────────────────────────────────

  server.tool(
    "remember",
    "Mémoriser une donnée persistante associée à TON identité d'agent (clé/valeur). Survit aux sessions. " +
    "⚠️ LIÉ À TON NOM — pas au projet. Un autre agent ne peut pas lire ta mémoire. " +
    "Pour des notes PROJECT-LEVEL visibles par tous les agents : utilise add_project_note(project, content, type). " +
    "Usages légitimes de remember : tes préférences, ton état courant, tes config perso.",
    {
      key: z.string().describe("Clé courte (ex: 'preferred_branch', 'last_review'). Évite les infos projet — utilise add_project_note() pour ça."),
      value: z.string().describe("Valeur à mémoriser (texte libre)"),
    },
    async ({ key, value }) => {
      const session = state.sessions.get(sessionId);
      if (!session?.name || session.name.startsWith("session-")) {
        return txt("❌ Tu dois être register() avec un nom stable avant de mémoriser.");
      }
      remember(session.name, key, value);
      return txt(`🧠 Mémorisé: ${key} = "${value.slice(0, 80)}${value.length > 80 ? "…" : ""}"`);
    }
  );

  server.tool(
    "recall",
    "Récupérer une mémoire persistante. Sans clé: retourne toutes les mémoires de l'agent.",
    {
      key: z.string().optional().describe("Clé (omettre pour tout lister)"),
    },
    async ({ key }) => {
      const session = state.sessions.get(sessionId);
      if (!session?.name || session.name.startsWith("session-")) {
        return txt("❌ Tu dois être register() avec un nom stable avant de recall.");
      }
      const result = recall(session.name, key);
      if (key) {
        return txt(result === null ? `(rien sous "${key}")` : `🧠 ${key}: ${result}`);
      }
      const entries = Object.entries(result || {});
      if (entries.length === 0) return txt("(aucune mémoire)");
      return txt(`🧠 ${entries.length} mémoire(s):\n` + entries.map(([k, v]) => `  • ${k}: ${String(v).slice(0, 100)}`).join("\n"));
    }
  );

  server.tool(
    "forget",
    "Oublier une mémoire spécifique.",
    { key: z.string().describe("Clé à oublier") },
    async ({ key }) => {
      const session = state.sessions.get(sessionId);
      if (!session?.name) return txt("❌ Pas de nom enregistré.");
      const ok = forgetKey(session.name, key);
      return txt(ok ? `🗑️  Oublié: ${key}` : `(rien sous "${key}")`);
    }
  );


  // ── get_briefing ───────────────────────────────────────────────────────────

  server.tool(
    "get_briefing",
    "Briefing intelligent filtré. Détecte vos @mentions, filtre par date/mission, sépare messages prioritaires du flux. Résumé filtré de l'état du réseau, à appeler en début de session.",
    {
      since: z.string().optional().describe("ISO timestamp ou ID message. Défaut: votre lastSeen"),
      mission: z.string().optional().describe("Votre mission pour filtrer le contexte (ex: 'review sampler.mjs')"),
    },
    async ({ since, mission }) => buildBriefing(sessionId, { since, mission })
  );

  // ══ MESSAGING ═══════════════════════════════════════════════════════════════

  server.tool(
    "send_message",
    "Envoyer un message sur un canal ou en DM. Utilisez '@NomSession' comme canal pour un message direct. " +
    "Champs de coordination : `expects_reply=true` signale que tu attends une réponse (les autres n'ont pas besoin de poll si ce n'est pas le cas), " +
    "`eta_seconds` annonce ton temps de travail estimé avant la prochaine action (réduit les polls inutiles). " +
    "Convention : terminer un message avec `status='over'` = j'ai fini, c'est à toi. `status='standby'` = je travaille, n'attends pas.",
    {
      content: z.string().describe("Contenu du message"),
      channel: z.string().default("general").describe("Canal cible ou '@Nom' pour un DM"),
      reply_to: z.string().optional().describe("ID du message auquel répondre"),
      expects_reply: z.boolean().optional().describe("Si true : tu attends une réponse. Les autres agents peuvent attendre ton next message avant de re-poll."),
      eta_seconds: z.number().optional().describe("Temps estimé en secondes avant ton prochain message (ex: 300 = 5 min de travail). Réduit les polls inutiles côté destinataire."),
      status: z.enum(["over", "standby", "done"]).optional().describe("over = j'ai terminé, c'est à toi | standby = je travaille, n'attends pas de réponse immédiate | done = tâche complètement terminée"),
    },
    async ({ content, channel, reply_to, expects_reply, eta_seconds, status }) => {
      const senderName = getSessionName(sessionId);
      let targetChannel = channel;
      let isDM = false;
      let dmHint = "";

      if (channel.startsWith("@")) {
        const res = resolveDMChannel(sessionId, channel.slice(1));
        if (res.error) return txt(`❌ ${res.error}`);
        targetChannel = res.channel;
        isDM = true;
        // Surface DM resolution so mis-addressing is never silent. Before this,
        // a DM to a name that didn't exactly match a registered agent was keyed
        // onto a channel the recipient never read — sent, but invisible.
        if (res.matched && res.resolvedTarget.toLowerCase() !== res.typedTarget.toLowerCase()) {
          dmHint = `\n↪️ "@${res.typedTarget}" résolu vers ${res.resolvedTarget}.`;
        }
        if (res.matched && !res.online) {
          dmHint += `\n💤 ${res.resolvedTarget} est hors-ligne — il verra le DM à sa reconnexion.`;
        }
        if (!res.matched) {
          dmHint += `\n⚠️ Aucune session nommée "${res.typedTarget}". Le DM reste en attente, visible uniquement quand un agent s'enregistre EXACTEMENT sous ce nom. Vérifie list_sessions.`;
        }
      } else if (!state.channels.has(channel)) {
        return txt(`❌ Canal "#${channel}" inexistant. Disponibles: ${[...state.channels.keys()].filter(c => !c.startsWith("dm:")).map(c => `#${c}`).join(", ")}.`);
      }

      const msg = pushMessage({
        id: randomUUID(), from: sessionId, fromName: senderName,
        channel: targetChannel, content, timestamp: new Date(),
        replyTo: reply_to ?? null, isDM,
        // Coordination metadata
        expects_reply: expects_reply ?? null,
        eta_seconds: eta_seconds ?? null,
        status: status ?? null,
      });
      notify(targetChannel, sessionId);
      if (!isDM) notify("__all__", sessionId);

      // Persist locally
      const sp = getAgentStoragePath(sessionId);
      if (sp) {
        const date = new Date().toISOString().slice(0, 10);
        writeAgentFile(sp, "messages", `${targetChannel.replace(/:/g, "_")}_${date}.jsonl`,
          JSON.stringify({ id: msg.id.slice(0, 8), channel: targetChannel, content, timestamp: msg.timestamp, isDM }) + "\n", true);
      }

      // Clear ETA on send
      const sender = state.sessions.get(sessionId);
      const cronHint = sender?.cron_job_id
        ? `\n⏰ Rappel cron actif → CronDelete("${sender.cron_job_id}") pour l'annuler.` : "";
      if (sender) { sender.eta = null; sender.etaReason = null; }

      return txt(`${isDM ? `📩 DM envoyé à ${channel}` : `📤 Envoyé sur #${channel}`}\n🆔 ${msg.id.slice(0, 8)} ⏱️ ${new Date().toLocaleTimeString("fr-FR")}${dmHint}${cronHint}\n\n⚡ Lance poll_messages pour attendre la réponse.`);
    }
  );

  // ── read_messages ───────────────────────────────────────────────────────────

  server.tool(
    "read_messages",
    "Lire les messages récents. Filtrage par canal, expéditeur ou période.",
    {
      channel: z.string().optional().describe("Canal ('__all__' pour tout, '@Nom' pour DM avec cet agent, '@me' pour tous mes DMs)"),
      from_session: z.string().optional().describe("Filtrer par expéditeur"),
      since_minutes: z.number().default(30).describe("Messages des N dernières minutes"),
      limit: z.number().default(50).describe("Nombre max"),
      since_id: z.string().optional().describe("Messages après cet ID"),
    },
    async ({ channel, from_session, since_minutes, limit, since_id }) => {
      // Resolve "@Name" → DM channel key. "@me" / self-reference → DMs only.
      // Same name resolution as send_message so both sides agree on the key.
      let dmOnly = false;
      if (channel?.startsWith("@")) {
        const myName = getSessionName(sessionId);
        const targetName = channel.slice(1);
        if (!targetName || targetName.toLowerCase() === myName.toLowerCase() || targetName === "me") {
          channel = "__all__";
          dmOnly = true;
        } else {
          channel = dmChannelKey(myName, resolveAgentName(targetName).name);
        }
      }

      const cutoff = new Date(Date.now() - since_minutes * 60 * 1000);
      let sinceFound = !since_id;

      const filtered = state.messages.filter(msg => {
        if (!sinceFound) {
          if (msg.id === since_id || msg.id.startsWith(since_id)) sinceFound = true;
          return false;
        }
        if (new Date(msg.timestamp) < cutoff) return false;
        if (dmOnly && !msg.isDM) return false;
        if (channel && channel !== "__all__" && msg.channel !== channel) return false;
        if (msg.isDM) {
          const myName = getSessionName(sessionId);
          // Check channel key (stable, derived from names at creation time) OR
          // participants list (updated on rename). Either match = visible.
          const ci = state.channels.get(msg.channel);
          const inByKey = isAgentInDMChannel(msg.channel, myName);
          const inByParticipants = ci?.participants?.includes(myName.toLowerCase());
          if (!inByKey && !inByParticipants) return false;
        }
        if (from_session && msg.fromName.toLowerCase() !== from_session.toLowerCase()) return false;
        return true;
      }).slice(-limit);

      if (filtered.length === 0) {
        return txt(`📭 Aucun message${channel ? ` sur ${channel}` : ""} (${since_minutes}min).\n💡 Utilisez poll_messages pour attendre.`);
      }

      const lines = filtered.map(msg => {
        const t = new Date(msg.timestamp).toLocaleTimeString("fr-FR");
        const ch = msg.isDM ? "📩DM" : `#${msg.channel}`;
        const re = msg.replyTo ? ` ↩️${msg.replyTo.slice(0, 8)}` : "";
        return `[${t}] [${ch}] ${msg.fromName}: ${msg.content}${re}\n  └─ id:${msg.id.slice(0, 8)}${coordMarkers(msg)}`;
      });
      return txt(`📬 ${filtered.length} message(s):\n\n${lines.join("\n\n")}\n\n🔖 Dernier: ${filtered.at(-1).id.slice(0, 8)}`);
    }
  );

  // ── poll_messages ───────────────────────────────────────────────────────────

  server.tool(
    "poll_messages",
    "Attendre de nouveaux messages (long-polling). Pour agents actifs dans une conversation. Les curateurs n'en ont PAS besoin — utilisez read_messages().",
    {
      channel: z.string().default("__all__").describe("Canal à surveiller. '__all__' = tout. '@Nom' = DM avec cet agent. '@me' = tous mes DMs. (défaut: tous)"),
      timeout_seconds: z.number().default(30).describe("Timeout en secondes (max: 120)"),
      since_id: z.string().optional().describe("Attendre les messages après cet ID"),
      since_minutes: z.number().default(5).describe("Sans since_id, fenêtre de lookback (défaut 5min) — livre les messages bufferés non lus avant de long-poll. Mettre 0 pour désactiver et n'attendre que du nouveau."),
      types: z.array(z.enum(["message", "direct_message", "system", "broadcast", "artifact"])).optional()
        .describe("Filtrer par types. Ex: ['direct_message','broadcast'] pour ignorer les events système."),
    },
    async ({ channel, timeout_seconds, since_id, since_minutes, types }) => {
      const timeout = Math.min(timeout_seconds, 120) * 1000;

      // Resolve "@Name" → DM channel key. "@me" or self-reference → "__all__" + dmOnly flag.
      // Same name resolution as send_message so both sides agree on the key.
      let dmOnly = false;
      if (channel.startsWith("@")) {
        const myName = getSessionName(sessionId);
        const targetName = channel.slice(1);
        if (!targetName || targetName.toLowerCase() === myName.toLowerCase() || targetName === "me") {
          channel = "__all__";
          dmOnly = true;
        } else {
          channel = dmChannelKey(myName, resolveAgentName(targetName).name);
        }
      }

      const session = state.sessions.get(sessionId);
      if (session) session.lastSeen = new Date();

      function matchesFilter(msg) {
        // System channel filtered by default unless explicitly requested
        if (msg.channel === "system" && channel !== "system") {
          if (!types?.includes("system")) return false;
        }
        // dmOnly: caller used "@me" or "@self" — only return DMs
        if (dmOnly && !msg.isDM) return false;
        // Channel filter
        if (channel !== "__all__" && msg.channel !== channel && msg.channel !== "__broadcast__") return false;
        // DM visibility — check both participants list (updated on rename) and
        // channel key (derived from names at creation time, stable across restarts)
        if (msg.isDM) {
          const myName = getSessionName(sessionId).toLowerCase();
          const ci = state.channels.get(msg.channel);
          const inByParticipants = ci?.participants?.includes(myName);
          const inByKey = isAgentInDMChannel(msg.channel, myName);
          if (!inByParticipants && !inByKey) return false;
        }
        // Own messages excluded
        if (msg.from === sessionId) return false;
        // Type filter
        if (!types || types.length === 0) return true;
        if (types.includes("direct_message") && msg.isDM) return true;
        if (types.includes("broadcast") && msg.channel === "__broadcast__") return true;
        if (types.includes("system") && msg.from === "system") return true;
        if (types.includes("artifact") && msg.content?.startsWith("📎")) return true;
        if (types.includes("message") && !msg.isDM && msg.from !== "system" && msg.channel !== "__broadcast__" && !msg.content?.startsWith("📎")) return true;
        return false;
      }

      // 1) since_id : check buffered after this id — scan from end (O(recent) not O(all))
      if (since_id) {
        const idx = state.messages.findLastIndex(m => m.id === since_id || m.id.startsWith(since_id));
        if (idx >= 0) {
          const buffered = state.messages.slice(idx + 1).filter(matchesFilter);
          if (buffered.length > 0) return formatMsgList(buffered);
        }
      } else if (since_minutes > 0) {
        // 2) Sans since_id : check buffered dans la fenêtre de lookback.
        //    Couvre le cas "agent re-connecté qui poll un DM arrivé pendant qu'il était parti".
        const cutoff = Date.now() - since_minutes * 60 * 1000;
        const buffered = [];
        for (let i = state.messages.length - 1; i >= 0; i--) {
          const msg = state.messages[i];
          if (new Date(msg.timestamp).getTime() < cutoff) break;
          if (matchesFilter(msg)) buffered.unshift(msg);
        }
        if (buffered.length > 0) return formatMsgList(buffered);
      }

      // 3) Long-poll : wait for a MATCHING message, re-waiting through spurious
      //    wakeups. A waiter on "__all__" is woken by ANY message — including
      //    background daemon/system chatter on unrelated channels and DMs to
      //    other agents. Previously the first such wake returned immediately
      //    (often "activité détectée" with nothing relevant), so in a live team
      //    the agent kept dropping the very message it was waiting for. Now we
      //    keep waiting until a message that passes matchesFilter actually
      //    arrives, or the timeout elapses.
      //
      //    The boundary is tracked by message id (not a time window): we return
      //    exactly the messages appended after what existed when we started, so
      //    nothing already seen is re-delivered. findLastIndex re-locates the
      //    boundary even if eviction shifted indices.
      const deadline = Date.now() + timeout;
      let baselineId = state.messages.length ? state.messages[state.messages.length - 1].id : null;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const arrived = await registerWaiter(sessionId, channel, remaining);
        if (!arrived) break; // genuine timeout

        if (since_id) {
          const idx = state.messages.findLastIndex(m => m.id === since_id || m.id.startsWith(since_id));
          if (idx >= 0) {
            const buffered = state.messages.slice(idx + 1).filter(matchesFilter);
            if (buffered.length > 0) return formatMsgList(buffered);
          }
        } else {
          const baseIdx = baselineId ? state.messages.findLastIndex(m => m.id === baselineId) : -1;
          const fresh = state.messages.slice(baseIdx + 1).filter(matchesFilter);
          if (fresh.length > 0) return formatMsgList(fresh);
        }
        // Spurious wake: nothing matched. Advance the baseline past everything
        // seen so far and keep waiting for the remaining time.
        baselineId = state.messages.length ? state.messages[state.messages.length - 1].id : baselineId;
      }
      return txt(`⏰ Timeout ${timeout / 1000}s — aucun message.\n💡 Relancez poll_messages.`);
    }
  );

  // ── poll (unified inbox) ──────────────────────────────────────────────────────
  // The turn-based agent's primitive: "poll, point." No target, no channel, no
  // cursor to manage. Returns EVERYTHING addressed to you (DMs, @mentions,
  // broadcasts) since your last poll — the cursor lives server-side keyed on your
  // identity, and is the SAME cursor the Stop-hook mailbox advances. So push and
  // pull never double-deliver and never drop. Optional long-poll for a sync
  // rendezvous; otherwise just call it and rendre la main — the hook brings the
  // rest at your next turn.
  server.tool(
    "poll",
    "Relève ta boîte : TOUT ce qui t'est adressé (DM, @mentions, broadcasts) depuis ton dernier poll. " +
    "Pas de cible, pas de canal — tu polls, point. Le curseur est tenu côté serveur sur ton identité et avance tout seul " +
    "(c'est le même que celui du hook boîte mail, donc jamais de doublon ni de manqué). " +
    "Avec timeout : attend une réponse (rendez-vous synchrone). Sans attente : snapshot immédiat puis rends la main, le hook t'apportera la suite au prochain tour.",
    {
      timeout_seconds: z.number().default(0).describe("Attente max si rien de neuf (0-120). 0 (défaut) = snapshot immédiat, pas d'attente bloquante."),
    },
    async ({ timeout_seconds }) => {
      const myName = getSessionName(sessionId);
      const session = state.sessions.get(sessionId);
      if (session) session.lastSeen = new Date();
      const timeout = Math.min(Math.max(timeout_seconds ?? 0, 0), 120) * 1000;

      // First poll under this identity → look back 10min to catch waiting mail;
      // afterwards → strictly since the server cursor.
      const cursor = recall(myName, "__inbox_cursor");
      const first = !cursor;
      const res = inboxFor(myName, { sinceId: cursor, sinceMinutes: first ? 10 : 0 });
      if (res.lastId) remember(myName, "__inbox_cursor", res.lastId);
      if (res.messages.length > 0) return formatMsgList(res.messages);

      if (timeout <= 0) {
        return txt(`📭 Rien de neuf pour toi.\n💡 Tu peux rendre la main — le hook boîte mail te livrera ce qui arrive à ton prochain tour. Ou poll(timeout_seconds=N) pour attendre maintenant.`);
      }

      // Long-poll : wait for a message that lands in MY inbox, re-waiting through
      // spurious wakeups (any channel activity wakes an "__all__" waiter).
      const deadline = Date.now() + timeout;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        const arrived = await registerWaiter(sessionId, "__all__", remaining);
        if (!arrived) break; // genuine timeout
        const cur = recall(myName, "__inbox_cursor");
        const r = inboxFor(myName, { sinceId: cur, sinceMinutes: 0 });
        if (r.lastId) remember(myName, "__inbox_cursor", r.lastId);
        if (r.messages.length > 0) return formatMsgList(r.messages);
      }
      return txt(`⏰ Rien de neuf (timeout ${timeout / 1000}s). Ta boîte est à jour — rends la main, le hook t'apportera la suite.`);
    }
  );

  // ── broadcast ───────────────────────────────────────────────────────────────

  server.tool(
    "broadcast",
    "Diffuser un message à TOUTES les sessions. À utiliser avec parcimonie.",
    {
      content: z.string().describe("Message à diffuser"),
      priority: z.enum(["info", "warning", "urgent"]).default("info"),
    },
    async ({ content, priority }) => {
      const emoji = { info: "ℹ️", warning: "⚠️", urgent: "🚨" }[priority];
      const msg = pushMessage({
        id: randomUUID(), from: sessionId, fromName: `${emoji} ${getSessionName(sessionId)}`,
        channel: "__broadcast__",
        content: `[BROADCAST ${priority.toUpperCase()}] ${content}`,
        timestamp: new Date(),
      });
      notify("__broadcast__", sessionId);
      return txt(`${emoji} Broadcast envoyé à ${state.sessions.size - 1} session(s). 🆔 ${msg.id.slice(0, 8)}`);
    }
  );

  // ── share_artifact ──────────────────────────────────────────────────────────

  server.tool(
    "share_artifact",
    "Partager un artefact (code, plan, données) sur un canal ou en DM.",
    {
      title: z.string().describe("Titre de l'artefact"),
      artifact_type: z.enum(["code", "text", "json", "diff", "plan", "other"]),
      content: z.string().describe("Contenu"),
      channel: z.string().default("general").describe("Canal ou '@Nom' pour DM"),
      language: z.string().optional().describe("Langage (pour le code)"),
    },
    async ({ title, artifact_type, content: body, channel, language }) => {
      const senderName = getSessionName(sessionId);
      let targetChannel = channel;
      let isDM = false;

      if (channel.startsWith("@")) {
        const res = resolveDMChannel(sessionId, channel.slice(1));
        if (res.error) return txt(`❌ ${res.error}`);
        targetChannel = res.channel;
        isDM = true;
      } else if (!state.channels.has(channel)) {
        // Auto-create channel : un share_artifact sur un canal libre/topic-driven
        // ne doit pas échouer (sinon les triggers channel_match sur des canaux
        // pas-encore-créés ne firent jamais).
        state.channels.set(channel, {
          name: channel,
          description: `Canal auto-créé par share_artifact (${senderName})`,
          createdBy: senderName,
          createdAt: new Date(),
        });
      }

      const msg = pushMessage({
        id: randomUUID(), from: sessionId, fromName: senderName,
        channel: targetChannel, timestamp: new Date(), isDM,
        content: `📎 [${artifact_type.toUpperCase()}] ${title}\n${"─".repeat(40)}\n${body}\n${"─".repeat(40)}${language ? `\n🗂️ ${language}` : ""}`,
      });
      notify(targetChannel, sessionId);

      const sp = getAgentStoragePath(sessionId);
      if (sp) {
        const safeTitle = title.replace(/[^a-z0-9]/gi, "_").slice(0, 40);
        writeAgentFile(sp, "artifacts", `${msg.id.slice(0, 8)}_${safeTitle}.md`,
          `# ${title}\n_type: ${artifact_type} | channel: ${targetChannel}_\n\n${body}`);
      }
      return txt(`📎 "${title}" partagé (${isDM ? `DM → ${channel}` : `#${targetChannel}`}). 🆔 ${msg.id.slice(0, 8)}`);
    }
  );

  // ── get_artifacts ───────────────────────────────────────────────────────────

  // ══ CHANNELS & SESSIONS ══════════════════════════════════════════════════════

  server.tool(
    "list_sessions",
    "Lister les sessions connectées. Avec `topic`, élargit aux agents offline pertinents (roster projets + axes KB) — utile pour trouver avec qui collaborer sur un sujet.",
    { topic: z.string().optional().describe("Filtrer / élargir aux agents travaillant sur ce sujet (online + offline pertinents)") },
    async ({ topic } = {}) => {
      const lines = [];

      // ── Online sessions (toujours listées) ──
      if (state.sessions.size === 0) {
        lines.push("(aucune session connectée)");
      } else {
        for (const [id, s] of state.sessions) {
          const me = id === sessionId ? " ← vous" : "";
          const eta = s.eta && new Date(s.eta) > new Date() ? ` ⏳ ${timeUntil(s.eta)}${s.etaReason ? ` (${s.etaReason})` : ""}` : "";
          const avail = s.availability && s.availability !== "available" ? ` [${s.availability}]` : "";
          const task = s.current_task ? `\n    📋 ${s.current_project ? s.current_project + " — " : ""}${s.current_task}` : "";
          const skills = s.skills?.length ? `\n    🔧 ${s.skills.join(", ")}` : "";
          lines.push(`  • ${s.name}${s.role ? ` [${s.role}]` : ""}${avail}${s.status ? ` 💬 "${s.status}"` : ""}${eta} — actif ${timeSince(s.lastSeen)}${me}${task}${skills}`);
        }
      }

      // ── Topic filter: offline contributors from project roster + KB ──
      if (topic) {
        const tl = topic.toLowerCase();
        const liveNames = new Set([...state.sessions.values()].map(s => s.name.toLowerCase()));
        const offline = new Map(); // name → { role, repo, project, source }

        // 1. Project roster: agents who worked on matching projects
        for (const proj of state.projects.values()) {
          const match = (proj.name || "").toLowerCase().includes(tl)
            || (proj.slug || "").toLowerCase().includes(tl)
            || (proj.description || "").toLowerCase().includes(tl);
          if (!match) continue;
          for (const [aname, ae] of Object.entries(proj.agents || {})) {
            if (!liveNames.has(aname.toLowerCase()) && !offline.has(aname)) {
              offline.set(aname, { role: ae.role, project: proj.name, source: "roster" });
            }
          }
        }

        // 2. KB axes: agents mentioned in axis files for this topic
        const _home = process.env.USERPROFILE || process.env.HOME || "";
        const KB_DIR = path.join(_home, ".wikichat", "knowledge");
        try {
          const matchedAxes = (await import("fs")).default
            .readdirSync(KB_DIR).filter(f => f.replace(/-axis\.md$/, "").includes(tl));
          for (const f of matchedAxes) {
            const raw = (await import("fs")).default.readFileSync(path.join(KB_DIR, f), "utf8");
            // Extract agent names from "producer:" frontmatter or @mentions
            for (const m of raw.matchAll(/producer:\s*(\S+)/g)) {
              const n = m[1].trim();
              if (!liveNames.has(n.toLowerCase()) && !offline.has(n))
                offline.set(n, { role: null, project: f.replace(/-axis\.md$/, ""), source: "KB" });
            }
          }
        } catch { /* KB dir absent or unreadable */ }

        if (offline.size > 0) {
          lines.push(`\n📴 Offline — pertinents pour "${topic}":`);
          for (const [name, info] of offline) {
            lines.push(`  • ${name}${info.role ? ` [${info.role}]` : ""} — ${info.project} (${info.source})`);
          }
          lines.push(`💡 contact_agent(target="<nom>", ...) pour les joindre`);
        }
      }

      const header = `📡 ${state.sessions.size} session(s) connectée(s)${topic ? ` + recherche topic "${topic}"` : ""}:`;
      return txt(`${header}\n\n${lines.join("\n")}`);
    }
  );

  server.tool("list_channels", "Lister les canaux de discussion.", {}, async () => {
    const chans = [...state.channels.entries()].filter(([n]) => !n.startsWith("dm:"))
      .map(([name, info]) => `  • #${name} — ${info.description} (${getChannelCount(name)} msg)`);
    return txt(`📺 Canaux:\n\n${chans.join("\n")}\n\n💡 @NomSession pour les DMs.`);
  });

  server.tool(
    "create_channel",
    "Créer un nouveau canal thématique.",
    {
      name: z.string().describe("Nom du canal"),
      description: z.string().optional().describe("Description"),
    },
    async ({ name, description }) => {
      const clean = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (state.channels.has(clean)) return txt(`❌ "#${clean}" existe déjà.`);
      state.channels.set(clean, {
        name: clean, description: description ?? `Canal ${clean}`,
        createdBy: getSessionName(sessionId), createdAt: new Date(),
      });
      try { const { saveChannels } = await import("./persistence.mjs"); saveChannels(); } catch {}
      sysMsg("system", `Nouveau canal: #${clean}${description ? ` — ${description}` : ""}`);
      notify("general");
      return txt(`✅ Canal "#${clean}" créé.`);
    }
  );

  // ══ COORDINATION ═════════════════════════════════════════════════════════════

  server.tool(
    "declare_capabilities",
    "Déclarer ses compétences, tâche et projet. Essentiel pour la coordination entre agents.",
    {
      skills: z.array(z.string()).describe("Compétences (ex: ['Python', 'FastAPI'])"),
      current_task: z.string().optional().describe("Tâche en cours"),
      current_project: z.string().optional().describe("Projet principal"),
      availability: z.enum(["available", "busy", "reviewing", "idle"]).default("available"),
    },
    async ({ skills, current_task, current_project, availability }) => {
      const session = state.sessions.get(sessionId);
      if (!session) return txt("❌ Session introuvable.");
      Object.assign(session, { skills, current_task: current_task ?? null, current_project: current_project ?? null, availability, lastSeen: new Date() });

      const sp = getAgentStoragePath(sessionId);
      if (sp) {
        const ctxFile = path.join(sp, "context.json");
        const ctx = fs.existsSync(ctxFile) ? JSON.parse(fs.readFileSync(ctxFile, "utf8")) : {};
        writeAgentFile(sp, "", "context.json", JSON.stringify({
          ...ctx, skills, current_task: current_task ?? null, current_project: current_project ?? null, availability, last_seen: new Date().toISOString(),
        }, null, 2));
      }

      sysMsg("system", `${getSessionName(sessionId)} [${availability}]${current_project ? ` — ${current_project}` : ""}${current_task ? ` | ${current_task}` : ""} | ${skills.join(", ")}`);
      notify("general", sessionId);
      return txt(`✅ Capacités déclarées.\n🔧 Skills: ${skills.join(", ")}\n📋 Tâche: ${current_task ?? "aucune"}\n📁 Projet: ${current_project ?? "aucun"}\n💡 Trouvable via who_can() ou who_works_on().`);
    }
  );

  server.tool(
    "declare_delay",
    "Déclarer un délai avant de répondre. duration_minutes=0 pour annuler.",
    {
      duration_minutes: z.number().describe("Durée en minutes (0 = disponible maintenant)"),
      reason: z.string().optional().describe("Raison (ex: 'analyse', 'rédaction')"),
    },
    async ({ duration_minutes, reason }) => {
      const session = state.sessions.get(sessionId);
      const name = getSessionName(sessionId);
      if (!session) return txt("❌ Session introuvable.");

      if (duration_minutes === 0) {
        session.eta = null; session.etaReason = null;
        sysMsg("system", `${name} est maintenant disponible.`);
        notify("general", sessionId);
        return txt("✅ Disponibilité rétablie.");
      }

      session.eta = new Date(Date.now() + duration_minutes * 60 * 1000);
      session.etaReason = reason ?? null;
      session.lastSeen = new Date();

      const cronExpr = cronInMinutes(duration_minutes);
      const cronPrompt = `Ton délai wikichat de ${duration_minutes}min est écoulé. Appelle poll_messages(timeout_seconds=60) pour lire les messages en attente et répondre. Si tu as terminé, appelle declare_delay(duration_minutes=0) et CronDelete avec ton job_id.`;

      sysMsg("system", `${name} répond ${timeUntil(session.eta)}${reason ? ` — ${reason}` : ""}.`);
      notify("general", sessionId);
      return txt(
        `⏳ Délai: ${duration_minutes}min${reason ? ` (${reason})` : ""}.\n` +
        `Retour: ~${session.eta.toLocaleTimeString("fr-FR")}\n\n` +
        `📅 Rappel cron (one-shot):\n  CronCreate(cron="${cronExpr}", prompt="${cronPrompt}", recurring=false)\n\n` +
        `Puis: register_cron(<job_id>) pour lier.`
      );
    }
  );

  // ══ TASKS ════════════════════════════════════════════════════════════════════

  server.tool(
    "claim_task",
    "Revendiquer une tâche sur un projet.",
    {
      project: z.string(), task: z.string().describe("ID court (ex: 'virtual-path-resolver')"),
      description: z.string().describe("Description de ce qui va être fait"),
    },
    async ({ project, task, description }) => {
      const name = getSessionName(sessionId);
      if (!state.projects.has(project)) {
        state.projects.set(project, { name: project, description: "", repo: null, stack: [], relations: [], status: "active", decisions: [], open_questions: [], blockers: [], tasks: new Map(), closure: null, createdBy: name, createdAt: new Date() });
      }
      const proj = state.projects.get(project);
      const existing = proj.tasks.get(task);
      if (existing?.status === "active") {
        return txt(`⚠️ Tâche "${task}" déjà revendiquée par ${existing.claimedBy} (${timeSince(existing.claimedAt)}).\n💡 Coordonnez-vous avant de reprendre.`);
      }
      const expiresAt = new Date(Date.now() + 90 * 60 * 1000);
      proj.tasks.set(task, { id: task, description, claimedBy: name, claimedAt: new Date(), status: "active", outcome: null, claim_expires_at: expiresAt });
      proj.updatedAt = new Date();
      trackAgentOnProject(sessionId, project, `claim:${task}`);
      saveProject(proj);

      const sp = getAgentStoragePath(sessionId);
      if (sp) writeAgentFile(sp, "tasks", `${task}.json`, JSON.stringify({ id: task, project, description, claimedAt: new Date().toISOString(), status: "active", claim_expires_at: expiresAt }, null, 2));

      sysMsg("coordination", `${name} revendique "${task}" sur ${project}: ${description}`);
      notify("coordination", sessionId);
      return txt(
        `✅ Tâche "${task}" revendiquée sur ${project}.\n📋 ${description}\n⏰ TTL: 90min (declare_progress() pour prolonger)\n\n` +
        `📅 Rappel toutes les 30min:\n  CronCreate(cron="${cronInMinutes(30)}", prompt="Rapport sur '${task}' (${project}): appelle declare_progress() ou release_task().", recurring=true)`
      );
    }
  );

  server.tool(
    "release_task",
    "Libérer une tâche terminée ou abandonnée.",
    {
      project: z.string(), task: z.string(),
      outcome: z.string().describe("Résultat ou raison d'abandon"),
      status: z.enum(["done", "abandoned", "blocked"]).default("done"),
    },
    async ({ project, task, outcome, status }) => {
      const name = getSessionName(sessionId);
      const proj = state.projects.get(project);
      if (!proj?.tasks.has(task)) return txt(`❌ Tâche "${task}" introuvable sur ${project}.`);
      const t = proj.tasks.get(task);
      Object.assign(t, { status, outcome, completedAt: new Date() });
      if (status === "done") proj.decisions.push(`[${new Date().toLocaleDateString("fr-FR")}] ${task}: ${outcome}`);
      else if (status === "blocked") proj.blockers.push(`${task}: ${outcome}`);
      proj.updatedAt = new Date();
      trackAgentOnProject(sessionId, project, `release:${task}:${status}`);
      saveProject(proj);

      const sp = getAgentStoragePath(sessionId);
      if (sp) {
        const file = path.join(sp, "tasks", `${task}.json`);
        const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { id: task, project };
        writeAgentFile(sp, "tasks", `${task}.json`, JSON.stringify({ ...existing, status, outcome, completedAt: new Date().toISOString() }, null, 2));
      }

      const emoji = { done: "✅", abandoned: "🚫", blocked: "🔴" }[status];
      sysMsg("coordination", `${emoji} ${name} — "${task}" sur ${project} [${status}]: ${outcome}`);
      notify("coordination", sessionId);

      const session = state.sessions.get(sessionId);
      const cronHint = session?.cron_job_id ? `\n⏰ Cron actif → CronDelete("${session.cron_job_id}") pour l'arrêter.` : "";
      return txt(`${emoji} Tâche "${task}" [${status}].\n📝 ${outcome}${cronHint}`);
    }
  );

  // ══ PROJECTS ═════════════════════════════════════════════════════════════════

  server.tool(
    "declare_project",
    "Déclarer ou mettre à jour un projet dans la base de connaissance partagée.",
    {
      name: z.string(), description: z.string(),
      repo: z.string().optional(), stack: z.array(z.string()).optional(),
      relations: z.array(z.string()).optional(), status: z.string().optional(),
    },
    async ({ name, description, repo, stack, relations, status }) => {
      const ownerName = getSessionName(sessionId);
      const existing = state.projects.get(name);
      const proj = existing ?? { name, tasks: new Map(), decisions: [], open_questions: [], blockers: [], closure: null, createdBy: ownerName, createdAt: new Date() };
      Object.assign(proj, { description, repo: repo ?? proj.repo, stack: stack ?? proj.stack ?? [], relations: relations ?? proj.relations ?? [], status: status ?? proj.status, updatedAt: new Date(), updatedBy: ownerName });
      state.projects.set(name, proj);
      trackAgentOnProject(sessionId, name, existing ? "update_project" : "declare_project");
      saveProject(proj);
      // Auto-create a dedicated channel for the project (slug = lowercase, spaces → hyphens).
      // Having a project channel means agents don't fallback to #coordination (which is generic
      // and shared by all projects), and decisions/updates stay contextualised to the project.
      const projectSlug = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      if (!state.channels.has(projectSlug)) {
        state.channels.set(projectSlug, {
          name: projectSlug,
          description: `Canal dédié au projet ${name}`,
          createdBy: ownerName,
          createdAt: new Date(),
        });
      }
      sysMsg("coordination", `${existing ? "📝 Projet mis à jour" : "🆕 Nouveau projet"}: ${name} — ${description}`);
      notify("coordination", sessionId);
      const channelHint = existing ? "" : `\n📢 Canal projet créé : #${projectSlug}`;
      return txt(`${existing ? "📝 Mis à jour" : "✅ Déclaré"}: "${name}"\n${description}${repo ? `\n🔗 ${repo}` : ""}${stack?.length ? `\n🔧 ${stack.join(", ")}` : ""}${channelHint}`);
    }
  );

  // ── Project meta (régie schema) ─────────────────────────────────────────────
  // Enriches a project with the régie fields :
  //   purpose   : free-text "why this exists"
  //   axes      : KB axes this project contributes to / draws from
  //   lifecycle : ideation | mvp | active | maintenance | archived | closed
  //   publish   : { github, package, deployed, license } — visibility / release state
  //   relations : structured links to other projects (depends-on / provides-to / sibling-of / superseded-by)
  // All fields optional ; partial updates merged into existing meta (deep for `publish`).
  // `health` is deliberately NOT settable here — populated by RepoAuditor.

  server.tool(
    "set_project_meta",
    "Enrichit un projet avec les champs de régie : purpose, axes, lifecycle, publish, relations. " +
    "Mise à jour partielle — seuls les champs fournis sont écrasés. publish est mergé en deep. " +
    "Utilise pour structurer un projet : pourquoi il existe, à quels axes KB il contribue, son stade de vie, " +
    "son état de publication (GitHub / package registry / déploiement / licence), et ses relations avec d'autres projets. " +
    "Le champ `health` est calculé automatiquement par RepoAuditor — non settable ici.",
    {
      project: z.string().describe("Nom du projet (clé dans state.projects)"),
      purpose: z.string().optional().describe("Pourquoi ce projet existe — phrase ou paragraphe"),
      axes: z.array(z.string()).optional().describe("Axes KB ('grist', 'auth', 'wikichat-triggers', etc.)"),
      lifecycle: z.enum(["ideation", "mvp", "active", "maintenance", "archived", "closed"]).optional()
        .describe("Stade de vie : ideation = idée brute, mvp = scope MVP en cours, active = dev courant, maintenance = stable + patches, archived = inactif mais préservé, closed = clôturé via close_project"),
      publish: z.object({
        github: z.object({
          visibility: z.enum(["public", "private", "none"]).optional(),
          url: z.string().optional(),
        }).optional(),
        package: z.object({
          registry: z.enum(["npm", "pypi", "cargo", "other"]).optional(),
          status: z.enum(["unpublished", "draft", "published"]).optional(),
          name: z.string().optional(),
          version: z.string().optional(),
        }).optional(),
        deployed: z.object({
          url: z.string().optional(),
          env: z.enum(["prod", "staging", "preview"]).optional(),
        }).optional(),
        license: z.string().optional().describe("Identifiant SPDX ('MIT', 'Apache-2.0', ...) ou 'proprietary'"),
      }).optional(),
      relations: z.array(z.object({
        type: z.enum(["depends-on", "provides-to", "sibling-of", "superseded-by", "fork-of"]),
        project: z.string(),
        note: z.string().optional(),
      })).optional().describe("Liens typés vers d'autres projets — remplace l'ancien array de strings non structuré"),
    },
    async ({ project, purpose, axes, lifecycle, publish, relations }) => {
      const name = getSessionName(sessionId);
      let proj = state.projects.get(project);
      if (!proj) {
        return txt(`❌ Projet "${project}" introuvable. Crée-le via declare_project() d'abord.`);
      }
      const before = {
        purpose: proj.purpose, lifecycle: proj.lifecycle,
        axes: proj.axes ? [...proj.axes] : [], publish: proj.publish,
      };
      const changes = [];
      if (purpose !== undefined) { proj.purpose = purpose; changes.push("purpose"); }
      if (axes !== undefined) { proj.axes = axes; changes.push("axes"); }
      if (lifecycle !== undefined) { proj.lifecycle = lifecycle; changes.push("lifecycle"); }
      if (publish !== undefined) {
        // Deep-merge publish so a partial update doesn't wipe sibling subfields
        proj.publish = proj.publish || {};
        for (const k of Object.keys(publish)) {
          if (publish[k] === null) { delete proj.publish[k]; continue; }
          if (typeof publish[k] === "object" && !Array.isArray(publish[k])) {
            proj.publish[k] = { ...(proj.publish[k] || {}), ...publish[k] };
          } else {
            proj.publish[k] = publish[k];
          }
        }
        changes.push("publish");
      }
      if (relations !== undefined) { proj.relations = relations; changes.push("relations"); }
      if (changes.length === 0) {
        return txt(`⚠️ set_project_meta("${project}") — aucun champ fourni, rien à mettre à jour.`);
      }
      proj.updatedAt = new Date();
      proj.updatedBy = name;
      trackAgentOnProject(sessionId, project, `meta:${changes.join(",")}`);
      saveProject(proj);

      // Surface the change on the project channel — the régie is a transparent system
      const slug = project.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const channelTarget = state.channels.has(slug) ? slug : "coordination";
      sysMsg(channelTarget, `📐 ${name} a mis à jour la meta de ${project} : ${changes.join(", ")}${lifecycle && lifecycle !== before.lifecycle ? ` (lifecycle: ${before.lifecycle || "—"} → ${lifecycle})` : ""}`);
      notify(channelTarget, sessionId);

      const lines = [`📐 Meta mise à jour : "${project}"`];
      if (purpose !== undefined) lines.push(`  Purpose : ${purpose}`);
      if (axes !== undefined) lines.push(`  Axes : ${axes.length ? axes.join(", ") : "(none)"}`);
      if (lifecycle !== undefined) lines.push(`  Lifecycle : ${lifecycle}`);
      if (publish !== undefined) {
        const p = proj.publish || {};
        const pub = [];
        if (p.github?.visibility) pub.push(`github=${p.github.visibility}${p.github.url ? ` (${p.github.url})` : ""}`);
        if (p.package?.status) pub.push(`${p.package.registry || "package"}=${p.package.status}${p.package.version ? `@${p.package.version}` : ""}`);
        if (p.deployed?.url) pub.push(`deployed=${p.deployed.env || "?"} ${p.deployed.url}`);
        if (p.license) pub.push(`license=${p.license}`);
        if (pub.length) lines.push(`  Publish : ${pub.join(" · ")}`);
      }
      if (relations !== undefined) lines.push(`  Relations : ${relations.length} link(s)`);
      lines.push(`\n💡 list_projects() pour voir le projet enrichi.`);
      return txt(lines.join("\n"));
    }
  );

  server.tool(
    "add_project_note",
    "Ajoute une note permanente à un projet (décision, blocker, question ouverte). " +
    "Écrit dans project-state.json — cross-sessions, cross-agents. " +
    "PRÉFÉRER À remember() pour tout ce qui concerne un projet car remember est lié à une identité d'agent. " +
    "Types : 'decision' = choix acté, 'blocker' = bloquant à résoudre, 'question' = point ouvert, 'note' (défaut) = info utile.",
    {
      project: z.string().describe("Nom du projet (clé dans state.projects)"),
      content: z.string().describe("Contenu de la note (une ligne suffisante, soyez précis)"),
      type: z.enum(["decision", "blocker", "question", "note"]).default("note")
        .describe("decision = choix acté | blocker = bloquant | question = point ouvert | note = information"),
    },
    async ({ project, content, type }) => {
      const name = getSessionName(sessionId);
      const date = `[${new Date().toLocaleDateString("fr-FR")}]`;
      let proj = state.projects.get(project);
      if (!proj) {
        // Auto-create project if it doesn't exist yet — avoids friction
        proj = { name: project, tasks: new Map(), decisions: [], open_questions: [], blockers: [], closure: null, createdBy: name, createdAt: new Date() };
        state.projects.set(project, proj);
        // Auto-create channel
        const slug = project.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        if (!state.channels.has(slug)) {
          state.channels.set(slug, { name: slug, description: `Canal dédié au projet ${project}`, createdBy: name, createdAt: new Date() });
        }
      }
      const entry = `${date} ${name}: ${content}`;
      // Route to the correct array based on type
      if (type === "decision" || type === "note") {
        proj.decisions.push(entry);
      } else if (type === "blocker") {
        proj.blockers.push(entry);
      } else if (type === "question") {
        proj.open_questions.push(entry);
      }
      proj.updatedAt = new Date();
      proj.updatedBy = name;
      trackAgentOnProject(sessionId, project, `note:${type}`);
      saveProject(proj);
      // Notify the project channel (auto-created above if needed) + coordination
      const slug = project.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
      const channelTarget = state.channels.has(slug) ? slug : "coordination";
      const emoji = { decision: "✅", blocker: "🔴", question: "❓", note: "📌" }[type];
      pushMessage({
        id: randomUUID(), from: sessionId, fromName: name,
        channel: channelTarget,
        content: `${emoji} [${type.toUpperCase()}] ${project}: ${content}`,
        timestamp: new Date(),
      });
      notify(channelTarget, sessionId);
      return txt(`${emoji} Note ajoutée au projet "${project}" [${type}].\n📝 ${content}\n📁 Persisté dans project-state.json — visible par tous les agents sur ce projet.\n💡 À la prochaine session sur ${project} : recall via list_projects() ou close_project().`);
    }
  );

  server.tool("list_projects", "Lister tous les projets — affiche meta de régie (lifecycle, axes, publish) si présentes.", {}, async () => {
    if (!state.projects.size) return txt("📭 Aucun projet.\n💡 declare_project() pour en créer un.");
    const lifecycleEmoji = {
      ideation: "💡", mvp: "🌱", active: "🟢", maintenance: "🔧", archived: "📦", closed: "🏁",
    };
    const lines = [...state.projects.values()].map(p => {
      const agents = [...state.sessions.values()].filter(s => s.current_project?.toLowerCase() === p.name.toLowerCase());
      const active = [...p.tasks.values()].filter(t => t.status === "active").length;
      const closedFlag = p.closure ? " | 🏁 closed" : "";
      const lifecycleFlag = p.lifecycle ? ` | ${lifecycleEmoji[p.lifecycle] || ""} ${p.lifecycle}` : "";
      const axesFlag = p.axes?.length ? ` | 🏷️ ${p.axes.slice(0, 4).join(", ")}${p.axes.length > 4 ? "+" : ""}` : "";
      // Publish summary : github visibility + package status + deployed url
      const pubBits = [];
      if (p.publish?.github?.visibility && p.publish.github.visibility !== "none") {
        pubBits.push(`gh:${p.publish.github.visibility}`);
      }
      if (p.publish?.package?.status === "published") {
        pubBits.push(`${p.publish.package.registry || "pkg"}@${p.publish.package.version || "?"}`);
      }
      if (p.publish?.deployed?.url) pubBits.push(`🚀${p.publish.deployed.env || "deployed"}`);
      const pubFlag = pubBits.length ? ` | 📡 ${pubBits.join(" ")}` : "";
      const purposeLine = p.purpose ? `\n    🎯 ${p.purpose}` : "";
      return `  • **${p.name}** — ${p.description}${agents.length ? ` | 👥 ${agents.map(a => a.name).join(", ")}` : ""}${active ? ` | 📋 ${active} tâche(s)` : ""}${lifecycleFlag}${axesFlag}${pubFlag}${closedFlag}${purposeLine}${p.status && !p.lifecycle ? `\n    📊 ${p.status}` : ""}`;
    });
    return txt(`🗺️ ${state.projects.size} projet(s):\n\n${lines.join("\n\n")}\n\n💡 what_is(projet) pour le détail · set_project_meta() pour enrichir un projet`);
  });

  server.tool(
    "close_project",
    "Clôturer un projet : capture documentation/livrables/rétro/capitalisation, marque status='closed', broadcast un artifact de clôture sur #library pour absorption par le Librarian. " +
    "Si auto=true (défaut), spawne un agent Closer headless qui lit l'état du projet + artefacts et remplit les sections manquantes. " +
    "Sinon, fournir directement les 4 sections via le paramètre `closure`.",
    {
      project: z.string().describe("Nom du projet (clé dans state.projects)"),
      auto: z.boolean().default(true).describe("Si true, spawne un agent Closer pour rédiger les sections. Sinon utilise `closure` directement."),
      closure: z.object({
        documentation: z.string().describe("Ce qui est documenté, où le trouver"),
        deliverables: z.string().describe("Ce qui a été livré, statut de chaque livrable"),
        retro: z.string().describe("Ce qui a marché, ce qui n'a pas marché, leçons"),
        capitalisation: z.string().describe("Ce qui est réutilisable ailleurs (patterns, snippets, décisions transférables)"),
      }).optional(),
      repo_path: z.string().optional().describe("Chemin du repo si auto=true (sinon process.cwd())"),
    },
    async ({ project, auto, closure, repo_path }) => {
      const name = getSessionName(sessionId);
      const proj = state.projects.get(project);
      if (!proj) return txt(`❌ Projet "${project}" introuvable. Liste avec list_projects().`);
      if (proj.closure) return txt(`⚠️ Projet "${project}" déjà clôturé le ${new Date(proj.closure.closedAt).toLocaleDateString("fr-FR")} par ${proj.closure.closedBy}.\n💡 Pour ré-ouvrir, édite manuellement projects/${project}.json.`);

      // Mode auto : spawn Closer headless qui audite et remplit les 4 sections.
      if (auto && !closure) {
        const repo = repo_path || process.cwd();
        const closerPrompt =
          `Tu es Closer, agent de clôture WikiChat. Lis docs/roles/closer.md.\n\n` +
          `MISSION : produire un artifact de clôture pour le projet "${project}".\n\n` +
          `BOUCLE :\n` +
          `1. register(name="Closer-${project.slice(0,12)}", role="closer", agent_type="headless")\n` +
          `2. Lis projects/${project}.json (tasks, decisions, blockers, open_questions)\n` +
          `3. Lis .wikichat/artifacts/ (artefacts produits pendant le projet)\n` +
          `4. Produis 4 sections dans un seul artifact markdown :\n` +
          `   ## Documentation\n   ## Livrables\n   ## Rétrospective\n   ## Capitalisation\n` +
          `5. share_artifact(channel="library", title="Closure: ${project}", artifact_type="text", content=<les 4 sections>)\n` +
          `6. Appelle close_project(project="${project}", auto=false, closure={ documentation, deliverables, retro, capitalisation })\n` +
          `7. Sors.`;
        const ticketId = randomUUID().slice(0, 8);
        state.spawnTickets.set(ticketId, {
          id: ticketId, name: `Closer-${project.slice(0,12)}`, mode: "headless", repo,
          spawnedBy: name, spawnerId: sessionId,
          status: "running", createdAt: new Date(),
          completedAt: null, result: null,
        });
        spawnHeadless(repo, closerPrompt, { name: `Closer-${project.slice(0,12)}`, role: "closer", spawnedBy: name }).then(res => {
          const t = state.spawnTickets.get(ticketId);
          if (t) {
            t.status = res.success ? "completed" : "failed";
            t.completedAt = new Date();
            t.result = { success: res.success, exitCode: res.exitCode };
          }
          notify("__tickets__", null);
        }).catch(() => {});
        sysMsg("coordination", `🏁 ${name} déclenche la clôture de "${project}" — Closer spawné (ticket ${ticketId}).`);
        notify("coordination", sessionId);
        return txt(`🏁 Clôture lancée pour "${project}".\n🤖 Closer headless spawné (ticket ${ticketId}).\n📋 Le Closer va auditer le projet, produire un artifact sur #library, et rappeler close_project(auto=false) pour persister la clôture.\n💡 Suis l'avancée via list_spawned() ou poll_ticket("${ticketId}").`);
      }

      // Mode manuel : closure fournie directement.
      if (!closure) return txt(`❌ Si auto=false, le paramètre 'closure' est requis (4 sections : documentation, deliverables, retro, capitalisation).`);

      proj.closure = {
        documentation: closure.documentation,
        deliverables: closure.deliverables,
        retro: closure.retro,
        capitalisation: closure.capitalisation,
        closedBy: name,
        closedAt: new Date().toISOString(),
      };
      proj.status = "closed";
      proj.updatedAt = new Date();
      proj.updatedBy = name;
      trackAgentOnProject(sessionId, project, "close");
      saveProject(proj);

      // Capitalisation distante : publie le snapshot mémoire si configuré
      // (WIKICHAT_MEMORY_REPO). Non-bloquant — la clôture n'attend pas le push.
      triggerMemoryPublish(`close_project:${project}`);

      // Broadcast sur #library pour que le Librarian absorbe la capitalisation.
      if (!state.channels.has("library")) {
        state.channels.set("library", { name: "library", description: "Knowledge base et closures de projets", createdBy: "system", createdAt: new Date() });
      }
      pushMessage({
        id: randomUUID(),
        from: sessionId, fromName: name,
        channel: "library",
        content:
          `📎 Closure: ${project}\n${"─".repeat(40)}\n` +
          `## Documentation\n${closure.documentation}\n\n` +
          `## Livrables\n${closure.deliverables}\n\n` +
          `## Rétrospective\n${closure.retro}\n\n` +
          `## Capitalisation\n${closure.capitalisation}\n` +
          `${"─".repeat(40)}`,
        type: "artifact",
        timestamp: new Date(),
      });
      notify("library", sessionId);

      sysMsg("coordination", `🏁 ${name} a clôturé le projet "${project}".`);
      notify("coordination", sessionId);
      return txt(`🏁 Projet "${project}" clôturé.\n📚 Closure persistée dans projects/${project}.json.\n📡 Artifact partagé sur #library — le Librarian l'absorbera dans la KB transverse au prochain digest.`);
    }
  );

  // ══ PROJECT AGENT ROSTER ═════════════════════════════════════════════════════
  // Per-project list of agents who have contributed (auto-tracked via
  // trackAgentOnProject). Enables bringing the team back when revisiting
  // a project later, even after machine reboots.

  server.tool(
    "list_project_agents",
    "Liste les agents qui ont contribué à un projet (auto-trackés via claim_task / release_task / add_project_note / declare_project / close_project). " +
    "Affiche pour chacun : online/offline, rôle, type, claude_session_id (pour --resume), dernière contribution. " +
    "Sert à savoir qui a travaillé sur quoi avant un respawn.",
    {
      project: z.string().describe("Nom du projet"),
    },
    async ({ project }) => {
      const proj = state.projects.get(project);
      if (!proj) return txt(`❌ Projet "${project}" introuvable. list_projects() pour voir la liste.`);
      const agents = proj.agents || {};
      const names = Object.keys(agents);
      if (names.length === 0) return txt(`📭 Aucun agent tracké pour "${project}".\n💡 Les agents sont auto-trackés au premier claim_task/release_task/add_project_note/declare_project sous une identité non-anonyme.`);
      const liveByName = new Map();
      for (const s of state.sessions.values()) liveByName.set(s.name?.toLowerCase(), s);
      const lines = names.map(n => {
        const e = agents[n];
        const live = liveByName.get(n.toLowerCase());
        const onlineFlag = live ? "🟢 online" : "⚪ offline";
        const role = e.role ? ` (${e.role})` : "";
        const type = e.agent_type || "interactive";
        const resumable = e.claude_session_id ? " 🔁resumable" : "";
        const lastSeen = e.last_seen ? timeSince(e.last_seen) : "?";
        const contribCount = (e.contributions || []).length;
        const lastContrib = (e.contributions || []).slice(-1)[0] || "—";
        return `  • **${n}**${role} [${type}] — ${onlineFlag}${resumable}\n    📅 ${lastSeen} · ${contribCount} contribution(s) · last: ${lastContrib}`;
      });
      const onlineCount = names.filter(n => liveByName.has(n.toLowerCase())).length;
      const resumableCount = names.filter(n => agents[n].claude_session_id).length;
      return txt(
        `👥 ${names.length} agent(s) sur "${project}" — 🟢 ${onlineCount} online, ⚪ ${names.length - onlineCount} offline, 🔁 ${resumableCount} resumable\n\n` +
        lines.join("\n\n") +
        `\n\n💡 respawn_project_agents("${project}", mode="resume_only") pour ré-éveiller les agents resumables.`
      );
    }
  );

  server.tool(
    "respawn_project_agents",
    "Ré-spawne les agents offline d'un projet, capé pour préserver les ressources. " +
    "mode='resume_only' (défaut) : seulement ceux avec claude_session_id, en --resume (continue leur historique). " +
    "mode='fresh' : tous, headless one-shot avec contexte projet. " +
    "mode='daemon' : daemon persistant (réservé principal/service). " +
    "max=3 par défaut. names=[...] filtre la liste. Respecte budget global + quota owner.",
    {
      project: z.string().describe("Nom du projet"),
      mode: z.enum(["resume_only", "fresh", "daemon"]).default("resume_only")
        .describe("resume_only = headless --resume si claude_session_id ; fresh = headless one-shot ; daemon = persistant (principal/service uniquement)"),
      names: z.array(z.string()).optional().describe("Filtrer aux noms listés (défaut : tous les agents offline)"),
      max: z.number().default(3).describe("Cap dur de respawns simultanés pour préserver les ressources"),
    },
    async ({ project, mode, names: filterNames, max }) => {
      const requester = getSessionName(sessionId);
      const proj = state.projects.get(project);
      if (!proj) return txt(`❌ Projet "${project}" introuvable.`);
      const agents = proj.agents || {};
      const allNames = Object.keys(agents);
      if (allNames.length === 0) return txt(`📭 Aucun agent tracké sur "${project}".`);

      // Online check (current sessions)
      const liveByName = new Map();
      for (const s of state.sessions.values()) liveByName.set(s.name?.toLowerCase(), s);

      // Build candidate list (offline only — never re-spawn already-online agents)
      let candidates = allNames.filter(n => !liveByName.has(n.toLowerCase()));
      if (filterNames && filterNames.length > 0) {
        const wanted = new Set(filterNames.map(s => s.toLowerCase()));
        candidates = candidates.filter(n => wanted.has(n.toLowerCase()));
      }
      if (candidates.length === 0) {
        return txt(`📭 Aucun agent offline à ré-spawner sur "${project}" (filtre appliqué : ${filterNames?.length ? filterNames.join(",") : "tous offline"}).`);
      }

      // Resource preservation : hard cap, prioritise resumables for resume_only mode
      if (mode === "resume_only") {
        candidates = candidates.filter(n => agents[n].claude_session_id);
        if (candidates.length === 0) {
          return txt(`📭 Aucun agent resumable (avec claude_session_id) offline sur "${project}". Essaie mode="fresh".`);
        }
      }
      const batch = candidates.slice(0, max);
      const skipped = candidates.slice(max);

      // Resolve canonical repo path : registry > project.repo > agent's tracked path.
      // The registry is authoritative ; tracked agent paths can point to wikichat's own
      // storage dir for service-spawned agents.
      let projectRepo = null;
      try {
        const reg = loadRegistry();
        const lower = project.toLowerCase();
        const slug = lower.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
        const match = reg.projects.find(p => (p.name && p.name.toLowerCase() === lower) || (p.slug && p.slug.toLowerCase() === slug));
        if (match?.path && fs.existsSync(match.path)) projectRepo = match.path;
      } catch { /* registry optional */ }
      if (!projectRepo && proj.repo && fs.existsSync(proj.repo)) projectRepo = proj.repo;

      const spawned = [];
      const failed = [];
      for (const n of batch) {
        const e = agents[n];
        const repoPath = projectRepo || (e.repo_path && fs.existsSync(e.repo_path) ? e.repo_path : null);
        if (!repoPath) {
          failed.push({ name: n, reason: `repo_path indisponible (registry/proj.repo/agent.repo_path tous absents)` });
          continue;
        }
        try {
          if (mode === "daemon") {
            const r = spawnDaemon(repoPath, {
              name: n, role: e.role || "agent",
              port: parseInt(process.env.PORT || "3777"),
              spawnedBy: requester,
              sessionId: e.claude_session_id || undefined,
            });
            if (r.success) spawned.push({ name: n, mode: "daemon", pid: r.pid });
            else failed.push({ name: n, reason: r.error });
          } else {
            // resume_only or fresh : both headless. resume_only passes resumeSessionId.
            const prompt = mode === "resume_only"
              ? `Tu reprends ta session sur le projet "${project}". register(name="${n}"${e.role ? `, role="${e.role}"` : ""}). Lis #${project.toLowerCase().replace(/\s+/g, "-")} pour les dernières updates. Si tu reprends une tâche en cours, continue. Sinon, attends instructions via poll_messages(timeout_seconds=60).`
              : `Tu rejoins le projet "${project}" (déjà contribué auparavant). register(name="${n}"${e.role ? `, role="${e.role}"` : ""}). Brièvement : list_projects() pour récupérer le contexte, poll_messages(timeout_seconds=30) pour les messages en attente, puis sors si rien d'urgent.`;
            // Fire-and-forget — don't block on the headless spawn
            spawnHeadless(repoPath, prompt, {
              name: n, role: e.role || "agent",
              port: parseInt(process.env.PORT || "3777"),
              spawnedBy: requester,
              resumeSessionId: mode === "resume_only" ? e.claude_session_id : null,
            }).catch(() => { /* logged in registry */ });
            spawned.push({ name: n, mode, resumed: mode === "resume_only" });
          }
        } catch (err) {
          failed.push({ name: n, reason: err.message });
        }
      }

      sysMsg("coordination", `🔁 ${requester} ré-spawne ${spawned.length}/${candidates.length} agent(s) sur "${project}" (mode=${mode}).`);
      notify("coordination", sessionId);

      const lines = [
        `🔁 Respawn sur "${project}" (mode=${mode}, max=${max})`,
        `  ✅ Spawned : ${spawned.length}`,
        ...spawned.map(s => `    • ${s.name}${s.resumed ? " 🔁" : ""}${s.pid ? ` (PID ${s.pid})` : ""}`),
      ];
      if (failed.length) {
        lines.push(`  ❌ Failed : ${failed.length}`);
        lines.push(...failed.map(f => `    • ${f.name} — ${f.reason}`));
      }
      if (skipped.length) {
        lines.push(`  ⏭  Skipped (cap max=${max}) : ${skipped.length}`);
        lines.push(`    ${skipped.join(", ")}`);
      }
      lines.push(`\n💡 list_project_agents("${project}") dans ~30s pour voir qui est revenu en ligne.`);
      return txt(lines.join("\n"));
    }
  );

  server.tool(
    "purge_registry",
    "Retire du registry (~/.wikichat/registry.json) les projets non-substantiels : pas de CLAUDE.md sérieux (<200 chars) ET aucun artefact dans .wikichat/artifacts/. " +
    "Par défaut dry_run=true : retourne la liste sans modifier. dry_run=false applique. Réduit drastiquement le coût des cleanup ticks.",
    {
      dry_run: z.boolean().default(true).describe("Si true, retourne la liste sans modifier le registry. Si false, applique."),
      min_claude_md_bytes: z.number().default(200).describe("Seuil au-dessous duquel un CLAUDE.md est considéré non-substantiel"),
    },
    async ({ dry_run, min_claude_md_bytes }) => {
      const registry = loadRegistry();
      const keep = [];
      const drop = [];
      for (const p of registry.projects) {
        if (!p.path) { drop.push({ slug: p.slug, reason: "no path" }); continue; }
        if (!fs.existsSync(p.path)) { drop.push({ slug: p.slug, reason: "path missing" }); continue; }
        // Substantial CLAUDE.md ?
        const claudeMdPath = path.join(p.path, "CLAUDE.md");
        let claudeMdSize = 0;
        try { claudeMdSize = fs.statSync(claudeMdPath).size; } catch { /* absent */ }
        // Non-empty .wikichat/artifacts ?
        const artifactsDir = path.join(p.path, ".wikichat", "artifacts");
        let artifactCount = 0;
        try { artifactCount = fs.readdirSync(artifactsDir).filter(f => /\.(md|json|txt)$/.test(f)).length; } catch { /* absent */ }
        // Keep if EITHER signal is positive
        if (claudeMdSize >= min_claude_md_bytes || artifactCount > 0) {
          keep.push({ slug: p.slug, claudeMdSize, artifactCount });
        } else {
          drop.push({ slug: p.slug, reason: `claudeMd=${claudeMdSize}B artifacts=${artifactCount}` });
        }
      }
      let summary = `📦 Registry: ${registry.projects.length} projets total\n` +
                    `  ✅ Keep: ${keep.length}\n` +
                    `  🗑️  Drop: ${drop.length}\n\n`;
      summary += "**Drop list (top 30):**\n";
      summary += drop.slice(0, 30).map(d => `  • ${d.slug} — ${d.reason}`).join("\n");
      if (drop.length > 30) summary += `\n  …et ${drop.length - 30} autres.`;
      if (dry_run) {
        summary = `🔍 **DRY RUN** — registry non modifié. Re-appelle avec dry_run=false pour appliquer.\n\n` + summary;
        return txt(summary);
      }
      // Apply : keep only the kept slugs.
      const keepSet = new Set(keep.map(k => k.slug));
      registry.projects = registry.projects.filter(p => keepSet.has(p.slug));
      saveRegistry(registry);
      sysMsg("coordination", `🗑️ ${getSessionName(sessionId)} a purgé le registry : ${drop.length} projets retirés (kept ${keep.length}).`);
      notify("coordination", sessionId);
      return txt(`✅ **APPLIQUÉ** — ${drop.length} projets retirés du registry, ${keep.length} conservés.\n\n` + summary);
    }
  );

  server.tool(
    "search_knowledge",
    "Cherche en full-text dans la KB : ~/.wikichat/knowledge/*.md (Compiled Truth transverse) + <projet>/.wikichat/knowledge/*.md (par projet du registry). " +
    "Scoring : termes dans titre (×3), headers (×2), corps (×1). Retourne top-K avec extrait contexte.",
    {
      query: z.string().describe("Requête en mots-clés (ex: 'grist widget standalone', 'mcp tools consolidés')"),
      scope: z.enum(["central", "projects", "all"]).default("all").describe("'central' = ~/.wikichat/knowledge/ uniquement, 'projects' = par-projet uniquement, 'all' = les deux"),
      limit: z.number().default(5).describe("Top-K résultats à retourner"),
    },
    async ({ query, scope, limit }) => {
      const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
      if (terms.length === 0) return txt("⚠️ Query vide ou trop courte.");

      const candidates = [];
      const seenPaths = new Set(); // dedup by absolute path (e.g. project="Omen" with path=~ collides with central)
      const addCandidate = (source, p) => {
        let abs;
        try { abs = fs.realpathSync(p); } catch { abs = path.resolve(p); }
        if (seenPaths.has(abs)) return;
        seenPaths.add(abs);
        candidates.push({ source, path: abs });
      };
      // 1. Central knowledge dir
      const homeDir = process.env.USERPROFILE || process.env.HOME || ".";
      const centralDir = path.join(homeDir, ".wikichat", "knowledge");
      if (scope === "central" || scope === "all") {
        try {
          for (const entry of fs.readdirSync(centralDir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith(".md")) {
              addCandidate("central", path.join(centralDir, entry.name));
            }
          }
        } catch { /* central dir absent */ }
      }
      // 2. Per-project knowledge dirs (via registry)
      if (scope === "projects" || scope === "all") {
        try {
          const reg = loadRegistry();
          for (const p of reg.projects) {
            if (!p.path) continue;
            const projKb = path.join(p.path, ".wikichat", "knowledge");
            try {
              for (const entry of fs.readdirSync(projKb, { withFileTypes: true })) {
                if (entry.isFile() && entry.name.endsWith(".md")) {
                  addCandidate(p.slug || p.name, path.join(projKb, entry.name));
                }
              }
            } catch { /* project has no knowledge/ */ }
          }
        } catch { /* registry empty */ }
      }

      if (candidates.length === 0) return txt(`📭 Aucun fichier de connaissance trouvé (scope=${scope}).\n💡 Vérifier ~/.wikichat/knowledge/ ou les .wikichat/knowledge/ des projets du registry.`);

      // 3. Score each candidate
      const results = [];
      for (const c of candidates) {
        let content;
        try { content = fs.readFileSync(c.path, "utf8"); } catch { continue; }
        const lower = content.toLowerCase();
        // Extract title (first H1 or filename)
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : path.basename(c.path, ".md");
        // Score
        let score = 0;
        const headers = [...content.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].toLowerCase());
        for (const term of terms) {
          // Title weight ×3
          if (title.toLowerCase().includes(term)) score += 3;
          // Headers weight ×2
          for (const h of headers) if (h.includes(term)) score += 2;
          // Body weight ×1 (count occurrences, capped to 10 per term to avoid spam)
          const matches = lower.split(term).length - 1;
          score += Math.min(matches, 10);
        }
        if (score === 0) continue;
        // Build excerpt around first match
        let excerptStart = -1;
        for (const term of terms) {
          const idx = lower.indexOf(term);
          if (idx >= 0 && (excerptStart < 0 || idx < excerptStart)) excerptStart = idx;
        }
        const excerptFrom = Math.max(0, excerptStart - 80);
        const excerpt = content.slice(excerptFrom, excerptFrom + 280).replace(/\s+/g, " ").trim();
        results.push({ source: c.source, path: c.path, title, score, excerpt });
      }

      results.sort((a, b) => b.score - a.score);
      const top = results.slice(0, limit);

      if (top.length === 0) return txt(`🔍 Aucun match pour "${query}" (scope=${scope}, ${candidates.length} fichier(s) scannés).`);

      const lines = top.map((r, i) =>
        `**${i + 1}. ${r.title}** (score=${r.score})\n   📁 [${r.source}] ${r.path}\n   📄 …${r.excerpt}…`
      );
      return txt(`🔍 ${top.length}/${results.length} match(s) pour "${query}" (${candidates.length} fichier(s) KB scannés) :\n\n${lines.join("\n\n")}`);
    }
  );

  // ══ IDEAS (régie idea pool) ══════════════════════════════════════════════════
  // Ideas are first-class objects living outside projects (~/.wikichat/ideas/).
  // Capture them as you have them ; the Harmonizer routine clusters them later ;
  // the Bootstrapper agent (next phase) turns scoped ideas into project skeletons.
  // Status flow : raw → clustered → scoped → started | shelved.

  server.tool(
    "add_idea",
    "Capture une idée dans le idea pool. Stocké dans ~/.wikichat/ideas/<id>.json (cross-projet, persistant). " +
    "Tag avec axes (mots-clés KB) + related_projects (projets connectés). Statut initial 'raw'. " +
    "À utiliser dès qu'une intuition apparaît — pas besoin de la scoper. La Harmonizer routine la clustera plus tard. " +
    "PRÉFÉRER À remember() pour les idées : remember est lié à l'identité d'agent ; idea pool est partagé.",
    {
      title: z.string().describe("Headline court (1 phrase) — phrase active de préférence"),
      body: z.string().optional().describe("Description plus longue ; libre"),
      axes: z.array(z.string()).optional().describe("Axes KB ('grist', 'auth', 'wikichat-triggers'…). Aide la harmonisation."),
      related_projects: z.array(z.string()).optional().describe("Noms de projets existants connectés à l'idée"),
      source: z.enum(["user", "channel", "closure", "git-signal", "harmonizer"]).optional()
        .describe("D'où vient l'idée — par défaut 'user'"),
    },
    async ({ title, body, axes, related_projects, source }) => {
      const name = getSessionName(sessionId);
      try {
        const idea = createIdea({ title, body, axes, related_projects, source, created_by: name });
        // Surface on #ideation if it exists (channel auto-created in J5)
        if (state.channels.has("ideation")) {
          pushMessage({
            id: randomUUID(), from: sessionId, fromName: name,
            channel: "ideation",
            content: `💡 Nouvelle idée [${idea.id}] : ${idea.title}${idea.axes.length ? ` · 🏷️ ${idea.axes.join(", ")}` : ""}${idea.related_projects.length ? ` · 🔗 ${idea.related_projects.join(", ")}` : ""}`,
            timestamp: new Date(),
          });
          notify("ideation", sessionId);
        }
        const lines = [
          `💡 Idée capturée [${idea.id}]`,
          `   ${idea.title}`,
        ];
        if (idea.body) lines.push(`   ${idea.body.slice(0, 120)}${idea.body.length > 120 ? "…" : ""}`);
        if (idea.axes.length) lines.push(`   🏷️ ${idea.axes.join(", ")}`);
        if (idea.related_projects.length) lines.push(`   🔗 ${idea.related_projects.join(", ")}`);
        lines.push(`\n💡 list_ideas() pour voir le pool · update_idea("${idea.id}", status="scoped") quand prête à devenir projet.`);
        return txt(lines.join("\n"));
      } catch (err) {
        return txt(`❌ add_idea échoué : ${err.message}`);
      }
    }
  );

  server.tool(
    "list_ideas",
    "Liste les idées du pool, filtres optionnels. Trié par updated_at desc. " +
    "Sans filtre, affiche les 20 plus récentes + stats globales (par status, par axis).",
    {
      status: z.enum(["raw", "clustered", "scoped", "started", "shelved"]).optional()
        .describe("Filtrer par status"),
      axis: z.string().optional().describe("Filtrer aux idées qui touchent cet axe"),
      project: z.string().optional().describe("Filtrer aux idées liées à ce projet"),
      since_days: z.number().optional().describe("Seulement les idées modifiées dans les N derniers jours"),
      limit: z.number().default(20).describe("Cap résultats (défaut 20)"),
      query: z.string().optional().describe("Recherche keyword sur title+body+axes (court-circuite les autres filtres)"),
    },
    async ({ status, axis, project, since_days, limit, query }) => {
      const stats = ideaStats();
      if (stats.total === 0) {
        return txt(`💡 Idea pool vide.\n   add_idea(title="...", axes=[...], related_projects=[...]) pour capturer une idée.`);
      }
      let out;
      if (query) {
        out = searchIdeas(query, { limit });
      } else {
        out = listIdeas({ status, axis, project, since_days, limit });
      }
      if (out.length === 0) {
        return txt(`📭 Aucune idée ne matche le filtre.\n   Pool total : ${stats.total} (${Object.entries(stats.by_status).map(([k,v]) => `${k}=${v}`).join(", ")})`);
      }
      const statusEmoji = { raw: "📥", clustered: "🧩", scoped: "🎯", started: "🚀", shelved: "📦" };
      const lines = out.map(i => {
        const e = statusEmoji[i.status] || "•";
        const tagsBits = [];
        if (i.axes?.length) tagsBits.push(`🏷️ ${i.axes.slice(0, 3).join(", ")}`);
        if (i.related_projects?.length) tagsBits.push(`🔗 ${i.related_projects.slice(0, 2).join(", ")}`);
        if (i.cluster_id) tagsBits.push(`🧩 cluster=${i.cluster_id.slice(0, 6)}`);
        const tags = tagsBits.length ? `\n    ${tagsBits.join(" · ")}` : "";
        return `  ${e} **[${i.id}]** ${i.title} _(${timeSince(i.updated_at)} · ${i.created_by})_${tags}`;
      });
      const statsLine = `📊 Pool : ${stats.total} idée(s) — ${Object.entries(stats.by_status).map(([k,v]) => `${k}:${v}`).join(", ")}`;
      const filterDesc = [
        query && `query="${query}"`,
        status && `status=${status}`,
        axis && `axis=${axis}`,
        project && `project=${project}`,
        since_days && `since_days=${since_days}`,
      ].filter(Boolean).join(", ");
      const filterHint = filterDesc ? ` (filtre : ${filterDesc})` : "";
      return txt(`💡 ${out.length} idée(s)${filterHint} :\n\n${lines.join("\n\n")}\n\n${statsLine}\n💡 update_idea(id, status="...") · get_idea(id) pour le détail`);
    }
  );

  server.tool(
    "update_idea",
    "Met à jour une idée existante. Champs partiels — seuls ceux fournis sont écrasés. " +
    "Statuts : raw (initial) → clustered (Harmonizer l'a regroupée) → scoped (prête à devenir projet) → started (projet créé) | shelved (mise au placard, pas de projet).",
    {
      id: z.string().describe("ID de l'idée (12 chars, retourné par add_idea / list_ideas)"),
      title: z.string().optional(),
      body: z.string().optional(),
      axes: z.array(z.string()).optional(),
      related_projects: z.array(z.string()).optional(),
      status: z.enum(["raw", "clustered", "scoped", "started", "shelved"]).optional(),
    },
    async ({ id, ...patch }) => {
      const name = getSessionName(sessionId);
      try {
        const updated = updateIdea(id, patch);
        if (!updated) return txt(`❌ Idée [${id}] introuvable.`);
        if (state.channels.has("ideation") && patch.status) {
          const statusEmoji = { raw: "📥", clustered: "🧩", scoped: "🎯", started: "🚀", shelved: "📦" };
          pushMessage({
            id: randomUUID(), from: sessionId, fromName: name,
            channel: "ideation",
            content: `${statusEmoji[patch.status] || "•"} ${name} a marqué [${id}] comme ${patch.status} : ${updated.title}`,
            timestamp: new Date(),
          });
          notify("ideation", sessionId);
        }
        const changed = Object.keys(patch).filter(k => patch[k] !== undefined);
        return txt(`✅ Idée [${id}] mise à jour (${changed.join(", ")}).\n   ${updated.title}\n   Status : ${updated.status}`);
      } catch (err) {
        return txt(`❌ update_idea échoué : ${err.message}`);
      }
    }
  );

  server.tool(
    "get_idea",
    "Récupère le détail complet d'une idée par id.",
    { id: z.string().describe("ID de l'idée (12 chars)") },
    async ({ id }) => {
      const idea = getIdea(id);
      if (!idea) return txt(`❌ Idée [${id}] introuvable.`);
      const lines = [
        `💡 **[${idea.id}] ${idea.title}**`,
        `   Status : ${idea.status} · Source : ${idea.source} · Auteur : ${idea.created_by}`,
        `   Créée : ${timeSince(idea.created_at)} · Mise à jour : ${timeSince(idea.updated_at)}`,
      ];
      if (idea.body) lines.push(`\n${idea.body}`);
      if (idea.axes?.length) lines.push(`\n🏷️ Axes : ${idea.axes.join(", ")}`);
      if (idea.related_projects?.length) lines.push(`🔗 Projets liés : ${idea.related_projects.join(", ")}`);
      if (idea.cluster_id) lines.push(`🧩 Cluster : ${idea.cluster_id}`);
      if (idea.similar_to?.length) lines.push(`🔄 Similaires : ${idea.similar_to.join(", ")}`);
      return txt(lines.join("\n"));
    }
  );

  // ══ REPO AUDIT (régie health) ════════════════════════════════════════════════
  // Computes the project.health snapshot from filesystem + git. The score is a
  // coarse 0-100 mix of doc completeness, hygiene, recent activity, and sync state.
  // `set_project_meta` refuses the health field on purpose — it lives here.

  server.tool(
    "audit_project",
    "Audite un projet : calcule sa health (README/LICENSE/.gitignore/tests/CI + git status/last commit/ahead-behind) et écrit le résultat dans project.health. " +
    "Score 0-100 + warnings textuels. Pour batch (tout le registry), utiliser audit_all_projects.",
    {
      project: z.string().describe("Nom du projet (clé dans state.projects)"),
      persist: z.boolean().default(true).describe("Si true (défaut), écrit le résultat dans project.health (saveProject). Si false, retourne juste l'audit."),
    },
    async ({ project, persist }) => {
      const proj = state.projects.get(project);
      if (!proj) return txt(`❌ Projet "${project}" introuvable.`);
      // Resolve repo path : project.repo > registry path > agent's tracked path
      let repoPath = proj.repo;
      if (!repoPath) {
        try {
          const reg = loadRegistry();
          const lower = project.toLowerCase();
          const slug = lower.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
          const match = reg.projects.find(p => (p.name && p.name.toLowerCase() === lower) || (p.slug && p.slug.toLowerCase() === slug));
          if (match?.path) repoPath = match.path;
        } catch { /* */ }
      }
      if (!repoPath) return txt(`❌ Aucun repo_path connu pour "${project}". Set proj.repo via declare_project ou enregistre le projet dans le registry.`);

      const audit = await auditProject(repoPath);
      if (persist) {
        proj.health = audit;
        proj.updatedAt = new Date();
        proj.updatedBy = getSessionName(sessionId);
        saveProject(proj);
      }

      const lines = [
        `🩺 Audit : "${project}"`,
        `   📁 ${audit.repo_path}`,
      ];
      if (!audit.exists) {
        lines.push(`   ❌ ${audit.error || "repo missing"}`);
      } else {
        lines.push(`   📊 Score : ${audit.score}/100`);
        const docBits = [];
        docBits.push(audit.readme_present ? `README (${audit.readme_age_days}d)` : "no README");
        docBits.push(audit.claude_md_present ? "CLAUDE.md ✓" : "no CLAUDE.md");
        if (audit.license) docBits.push(`license=${audit.license}`);
        lines.push(`   📚 ${docBits.join(" · ")}`);
        const hygBits = [];
        hygBits.push(audit.gitignore_present ? ".gitignore ✓" : "no .gitignore");
        hygBits.push(audit.has_tests ? "tests ✓" : "no tests");
        if (audit.ci) hygBits.push(`ci=${audit.ci}`);
        lines.push(`   🧹 ${hygBits.join(" · ")}`);
        if (audit.is_git_repo) {
          const gitBits = [];
          if (audit.branch) gitBits.push(`branch=${audit.branch}`);
          if (audit.last_commit_age_days !== null) gitBits.push(`last_commit=${audit.last_commit_age_days}d ago`);
          if (audit.uncommitted) gitBits.push(`${audit.uncommitted} uncommitted`);
          if (audit.ahead_of_remote) gitBits.push(`+${audit.ahead_of_remote} ahead`);
          if (audit.behind_remote) gitBits.push(`-${audit.behind_remote} behind`);
          lines.push(`   🌳 ${gitBits.join(" · ")}`);
        }
        if (audit.warnings?.length) {
          lines.push(`   ⚠️ ${audit.warnings.join(" · ")}`);
        }
      }
      if (persist) lines.push(`\n💾 Persisté dans project-state.json (project.health).`);
      return txt(lines.join("\n"));
    }
  );

  server.tool(
    "harmonize_ideas",
    "Lance une passe de harmonisation : cluster les idées par similarité (Jaccard sur title+body+axes+related_projects), " +
    "met à jour cluster_id + similar_to sur chaque idée, et propose des syntheses sur #ideation. " +
    "Idempotent : re-rouler stabilise les clusters tant que les idées n'ont pas changé. " +
    "À déclencher manuellement ou via cron (register_trigger type=cron).",
    {
      threshold: z.number().default(0.25).describe("Seuil Jaccard min pour lier deux idées (0.0-1.0). Défaut 0.25."),
      min_cluster_size: z.number().default(2).describe("Taille min d'un cluster pour être reporté. Défaut 2."),
      post_to_channel: z.boolean().default(true).describe("Si true (défaut), poste un summary sur #ideation."),
      statuses: z.array(z.enum(["raw", "clustered", "scoped", "started", "shelved"])).optional()
        .describe("Statuses à inclure dans le scan. Défaut : raw + clustered."),
    },
    async ({ threshold, min_cluster_size, post_to_channel, statuses }) => {
      const name = getSessionName(sessionId);
      const report = await runHarmonizer({ threshold, min_cluster_size, statuses });
      const summary = formatHarmonizerSummary(report);
      if (post_to_channel && state.channels.has("ideation") && report.clusters.length > 0) {
        pushMessage({
          id: randomUUID(), from: sessionId, fromName: name,
          channel: "ideation",
          content: summary,
          timestamp: new Date(),
        });
        notify("ideation", sessionId);
      }
      const meta = `\n📊 ${report.total_ideas} idée(s) scannée(s) · ${report.links_found} lien(s) au seuil ${report.threshold} · ${report.clusters.length} cluster(s) ≥ ${report.min_cluster_size}`;
      return txt(summary + meta);
    }
  );

  server.tool(
    "audit_all_projects",
    "Audite tous les projets du registry en batch (concurrence cap=4). Persistance optionnelle. " +
    "Coûteux — ~50-200ms par projet. Pour 132 projets, attendre ~5-10s. Préférer audit_project pour les check ponctuels.",
    {
      persist: z.boolean().default(false).describe("Si true, écrit chaque audit dans project-state.json. Défaut false (read-only)."),
      concurrency: z.number().default(4).describe("Nombre d'audits parallèles. 4 = bon équilibre."),
      min_score: z.number().optional().describe("Filtrer la sortie aux projets dont le score est ≤ ce seuil"),
      limit: z.number().default(20).describe("Cap du résultat affiché"),
    },
    async ({ persist, concurrency, min_score, limit }) => {
      const reg = loadRegistry();
      const projects = reg.projects.filter(p => p.path && p.name).map(p => ({ name: p.name, path: p.path }));
      if (projects.length === 0) return txt(`📭 Aucun projet avec path dans le registry.`);

      const startedAt = Date.now();
      const audits = await auditMany(projects, concurrency);
      const elapsed = Date.now() - startedAt;

      // Persist to project-state if requested
      if (persist) {
        for (const [name, audit] of audits) {
          const proj = state.projects.get(name);
          if (proj && audit.exists) {
            proj.health = audit;
            proj.updatedAt = new Date();
            proj.updatedBy = getSessionName(sessionId);
            saveProject(proj);
          }
        }
      }

      // Build summary, optionally filtered by min_score
      const rows = [...audits.entries()]
        .filter(([, a]) => a.exists)
        .map(([name, a]) => ({ name, score: a.score, warnings: a.warnings, last_commit_age_days: a.last_commit_age_days }))
        .filter(r => min_score === undefined || r.score <= min_score)
        .sort((a, b) => a.score - b.score);

      const missing = [...audits.entries()].filter(([, a]) => !a.exists).map(([n]) => n);
      const top = rows.slice(0, limit);

      const lines = [
        `🩺 Audit batch terminé : ${audits.size} projets en ${elapsed}ms${persist ? " (persisté)" : " (read-only)"}`,
        `   📊 Scores : min=${rows[0]?.score ?? "—"} max=${rows[rows.length - 1]?.score ?? "—"} avg=${rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : "—"}`,
      ];
      if (missing.length) lines.push(`   ⚠️ ${missing.length} projet(s) avec path manquant : ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}`);
      if (top.length === 0) {
        lines.push(`\n📭 Aucun projet ne matche le filtre (min_score=${min_score}).`);
      } else {
        lines.push(`\n${min_score !== undefined ? `Top ${top.length} avec score ≤ ${min_score}` : `Top ${top.length} (par score croissant) :`}\n`);
        for (const r of top) {
          const w = r.warnings?.length ? ` — ${r.warnings.slice(0, 3).join(" · ")}${r.warnings.length > 3 ? "…" : ""}` : "";
          lines.push(`  ${r.score < 30 ? "🔴" : r.score < 60 ? "🟡" : "🟢"} ${r.score}/100  ${r.name}${w}`);
        }
      }
      lines.push(`\n💡 audit_project("<name>") pour le détail · set_project_meta() pour enrichir purpose/axes/lifecycle.`);
      return txt(lines.join("\n"));
    }
  );

  // ══ SPAWN ═════════════════════════════════════════════════════════════════════

  server.tool(
    "contact_agent",
    "Joindre un agent en déposant un message dans SA maison (canal-projet), en le @mentionnant. " +
    "Async par défaut : il le relève à son prochain tour via son hook boîte mail — qu'il soit en ligne ou pas, tu ne bloques jamais. Sa réponse te reviendra dans TA maison. " +
    "wake=true pour réveiller activement un agent offline (reprise --resume). " +
    "Avec `also_invite` + `thread` : crée un canal partagé multi-parties.",
    {
      target: z.string().describe("Nom de l'agent principal à contacter"),
      message: z.string().describe("Le message / la demande à transmettre"),
      expects_reply: z.boolean().optional().describe("Si true, on demande explicitement une réponse"),
      wake: z.boolean().optional().describe("Si true et l'agent est offline : le réveiller activement (spawn --resume). Défaut false = livraison async, il verra à son retour."),
      repo_path: z.string().optional().describe("Override du repo (sinon auto-résolu)"),
      also_invite: z.array(z.string()).optional().describe("Autres agents à inviter dans la discussion (multi-parties)"),
      thread: z.string().optional().describe("Nom du canal partagé à créer/réutiliser (ex: 'zebra-qgis-filter'). Si absent avec also_invite, auto-généré."),
    },
    async ({ target, message, expects_reply, wake, repo_path, also_invite, thread }) => {
      const senderName = getSessionName(sessionId);
      const resolution = resolveAgentName(target);
      const name = resolution.name;
      if (name.toLowerCase() === senderName.toLowerCase()) return txt(`❌ Tu ne peux pas te contacter toi-même.`);

      // ── MULTI-PARTY THREAD : also_invite → canal partagé + invitations ────────
      const allParticipants = also_invite?.length ? [name, ...also_invite] : null;
      if (allParticipants) {
        // Create or reuse the shared channel
        const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const channelSlug = thread
          ? thread.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40)
          : `thread-${name.toLowerCase().replace(/[^a-z0-9]/g, "")}-${date}`;

        if (!state.channels.has(channelSlug)) {
          state.channels.set(channelSlug, {
            name: channelSlug,
            description: `Discussion ${senderName} + ${allParticipants.join(", ")}${thread ? ` — ${thread}` : ""}`,
            createdBy: senderName, createdAt: new Date(),
          });
          try { const { saveChannels } = await import("./persistence.mjs"); saveChannels(); } catch {}
        }

        // Post opening message on the shared channel
        pushMessage({
          id: randomUUID(), from: sessionId, fromName: senderName,
          channel: channelSlug, content: message, timestamp: new Date(),
          expects_reply: expects_reply ?? true, status: "over",
        });
        notify(channelSlug, sessionId);

        // Invite each participant via DM (online) or contact (offline)
        const results = [];
        for (const pName of allParticipants) {
          const res = resolveAgentName(pName);
          const pResolved = res.name;
          const pFound = getSessionByName(pResolved);
          const pLive = pFound ? state.sessions.get(pFound.id) : null;
          const pOnline = pLive && pLive.availability !== "stale" &&
            (!pLive.lastSeen || Date.now() - new Date(pLive.lastSeen).getTime() < 5 * 60 * 1000) &&
            pFound?.id !== sessionId;
          const invite = `📬 ${senderName} t'invite sur #${channelSlug} — rejoins la discussion et poste via send_message(channel="${channelSlug}").`;
          if (pOnline) {
            const dm = resolveDMChannel(sessionId, pResolved);
            pushMessage({ id: randomUUID(), from: sessionId, fromName: senderName, channel: dm.channel, content: invite, timestamp: new Date(), isDM: true, expects_reply: true, status: "over" });
            notify(dm.channel, sessionId);
            results.push(`  📩 ${pResolved} (online) — DM d'invitation envoyé`);
          } else {
            // Best-effort offline contact — fire and forget
            const csid = recall(pResolved, "__claude_session_id");
            const stripWk = p => p ? p.replace(/[\\/]\.wikichat[\\/]?$/, "") : null;
            const pRepo = repo_path || recall(pResolved, "__cwd")
              || stripWk(pLive?.storage_path)
              || (() => { const e = loadSpawnRegistry().find(x => x.name === pResolved); return stripWk(e?.storage_path); })()
              || (() => { for (const p of state.projects.values()) { const a = p.agents?.[pResolved]; if (a?.repo_path) return a.repo_path; } return null; })();
            if (pRepo && fs.existsSync(pRepo)) {
              const spawnPrompt = `📨 ${senderName} t'invite sur #${channelSlug} :\n\n${message}\n\nregister(name="${pResolved}") puis poste sur #${channelSlug} via send_message(channel="${channelSlug}", ..., status="over").`;
              spawnHeadless(pRepo, spawnPrompt, { name: pResolved, role: pLive?.role || "agent", port: parseInt(process.env.PORT || "3777"), spawnedBy: senderName, resumeSessionId: csid || null }).catch(() => {});
              results.push(`  🔁 ${pResolved} (offline) — spawn ${csid ? "--resume" : "frais"}`);
            } else {
              results.push(`  ⚠️ ${pResolved} — offline, repo inconnu (relance-le d'abord)`);
            }
          }
        }
        return txt(
          `🧵 Canal #${channelSlug} ouvert — ${allParticipants.length} participant(s) invité(s):\n${results.join("\n")}\n\n` +
          `💬 Poste sur #${channelSlug} via send_message(channel="${channelSlug}", ...)\n` +
          `👁️ Chaque participant reçoit les nouveaux messages via son hook boîte mail.`
        );
      }

      const found = getSessionByName(name);
      const live = found ? state.sessions.get(found.id) : null;
      const online = live && live.availability !== "stale" &&
        (!live.lastSeen || Date.now() - new Date(live.lastSeen).getTime() < 5 * 60 * 1000) &&
        found.id !== sessionId;

      // ── DEFAULT : deposit in the recipient's HOME (project channel), @mentioning
      //    them. This is the stable address the volatile display name never was —
      //    it works identically online or offline (the hook delivers at their next
      //    turn), and their reply lands in YOUR home. No blocking, no spawn, no
      //    fresh-lineage hallucination. ──────────────────────────────────────────
      const targetHome = homeChannelFor(name);
      if (targetHome) {
        let ch = state.channels.get(targetHome);
        if (!ch) {
          ch = { name: targetHome, description: `🏠 Maison projet — agents y vivent et s'y joignent par @mention`, createdBy: name, createdAt: new Date(), participants: [name.toLowerCase()] };
          state.channels.set(targetHome, ch);
          try { const { saveChannels } = await import("./persistence.mjs"); saveChannels(); } catch { /* */ }
        }
        const msg = pushMessage({
          id: randomUUID(), from: sessionId, fromName: senderName,
          channel: targetHome, content: `@${name} ${message}`, timestamp: new Date(),
          expects_reply: expects_reply ?? true, status: "over",
        });
        notify(targetHome, sessionId);

        // Optionally wake an offline agent so it answers now instead of at its
        // next human-driven turn. Opt-in (wake=true) so we never silently spawn a
        // fresh lineage that invents context.
        let wakeNote = "";
        if (!online && wake) {
          const csid0 = recall(name, "__claude_session_id");
          const stripWk0 = p => p ? p.replace(/[\\/]\.wikichat[\\/]?$/, "") : null;
          const repo0 = repo_path || recall(name, "__cwd")
            || stripWk0(live?.storage_path)
            || (() => { const e = loadSpawnRegistry().find(x => x.name === name); return stripWk0(e?.storage_path); })();
          if (repo0 && fs.existsSync(repo0)) {
            const wakePrompt = `📨 ${senderName} t'a déposé un message dans ta maison #${targetHome} :\n\n${message}\n\nTu es "${name}". ${csid0 ? "Reprends ta session — garde ton contexte. " : ""}register(name="${name}") si besoin, lis via poll(), réponds via send_message(channel="@${senderName}"${expects_reply ? ", expects_reply=true" : ""}, status="over").`;
            spawnHeadless(repo0, wakePrompt, { name, role: live?.role || "agent", port: parseInt(process.env.PORT || "3777"), spawnedBy: senderName, resumeSessionId: csid0 || null }).catch(() => {});
            wakeNote = `\n🔁 Réveil ${csid0 ? "--resume" : "frais"} lancé (wake=true).`;
          } else {
            wakeNote = `\n⚠️ wake demandé mais repo inconnu — il verra le message à son retour.`;
          }
        }

        const stateNote = online
          ? `Il est EN LIGNE — il le relèvera à son prochain tour (hook).`
          : `Il est offline — le message l'attend dans sa maison, livré dès son retour.${wake ? "" : " (wake=true pour le réveiller maintenant.)"}`;
        return txt(
          `📬 Déposé dans la maison de ${name} → #${targetHome} (🆔 ${msg.id.slice(0, 8)}), il est @mentionné.\n${stateNote}${wakeNote}\n` +
          `↩️ Sa réponse te reviendra dans TA maison — relève avec poll().`
        );
      }

      // ── FALLBACK : home unknown (cwd/projet jamais reporté) → legacy. Online =
      //    DM direct ; offline = reprise seulement si wake (sinon on ne peut rien
      //    faire d'utile sans adresse stable). ──────────────────────────────────
      if (online) {
        const dm = resolveDMChannel(sessionId, name);
        const msg = pushMessage({
          id: randomUUID(), from: sessionId, fromName: senderName,
          channel: dm.channel, content: message, timestamp: new Date(),
          isDM: true, expects_reply: expects_reply ?? null, status: "over",
        });
        notify(dm.channel, sessionId);
        return txt(`📩 ${name} est EN LIGNE (maison inconnue) — DM envoyé (🆔 ${msg.id.slice(0, 8)}). Il le relèvera à son prochain tour.`);
      }

      if (!wake) {
        return txt(`📭 ${name} est offline et sa maison (canal-projet) est inconnue — rien à quoi l'adresser de stable.\n💡 Passe wake=true pour le réveiller (reprise --resume), ou repo_path=... pour fixer son repo.`);
      }

      // ── OFFLINE + wake → reprise (--resume) ou spawn frais ──
      const csid = recall(name, "__claude_session_id");
      const stripWk = p => p ? p.replace(/[\\/]\.wikichat[\\/]?$/, "") : null;
      let repo = repo_path
        || recall(name, "__cwd")
        || stripWk(live?.storage_path)
        || (() => { const e = loadSpawnRegistry().find(x => x.name === name); return stripWk(e?.storage_path); })()
        || (() => { for (const p of state.projects.values()) { const a = p.agents?.[name]; if (a?.repo_path) return a.repo_path; } return null; })();

      if (!repo || !fs.existsSync(repo)) {
        return txt(`❌ ${name} est offline et je ne sais pas où reprendre sa session (cwd/registry/roster introuvables). Relance-le une fois pour qu'il s'enregistre, ou passe repo_path=...`);
      }

      const prompt =
        `📨 Message direct de ${senderName} (via WikiChat) :\n\n${message}\n\n` +
        `Tu es "${name}". ${csid ? "Tu reprends ta session précédente — garde ton contexte. " : ""}` +
        `register(name="${name}") si tu n'es pas déjà enregistré, puis réponds à ${senderName} via ` +
        `send_message(channel="@${senderName}"${expects_reply ? ", expects_reply=true" : ""}, status="over"). ` +
        `Si rien à ajouter, send_message(..., status="done").`;

      const ticketId = randomUUID().slice(0, 8);
      state.spawnTickets.set(ticketId, {
        id: ticketId, name, mode: "contact", repo: path.basename(repo),
        spawnedBy: senderName, spawnerId: sessionId,
        status: "running", createdAt: new Date(), completedAt: null, result: null,
      });

      const resumed = !!csid;
      sysMsg("coordination", `📨 ${senderName} contacte "${name}" (offline) → ${resumed ? "reprise --resume" : "spawn frais"} [ticket:${ticketId}]`);
      notify("coordination", sessionId);

      spawnHeadless(repo, prompt, {
        name, role: live?.role || "agent",
        port: parseInt(process.env.PORT || "3777"),
        spawnedBy: senderName,
        resumeSessionId: csid || null,
      }).then(result => {
        const t = state.spawnTickets.get(ticketId);
        if (t) { t.status = result.success ? "completed" : "failed"; t.completedAt = new Date(); t.result = { success: result.success, exitCode: result.exitCode }; }
        notifyWaiters("__tickets__", null);
      }).catch(() => {
        const t = state.spawnTickets.get(ticketId);
        if (t) { t.status = "failed"; t.completedAt = new Date(); }
        notifyWaiters("__tickets__", null);
      });

      return txt(
        `🔁 ${name} est OFFLINE → ${resumed ? "reprise de SA session (--resume) " : "spawn frais "}avec ton message [ticket:${ticketId}].\n` +
        `${resumed ? "Il continue à la suite de son historique." : "⚠️ Pas de claude_session_id connu → contexte neuf (il se ré-enregistre)."}\n` +
        `💡 poll_ticket("${ticketId}") ou poll_messages(channel="@${name}") pour sa réponse.`
      );
    }
  );

  server.tool(
    "spawn_session",
    "Lancer une nouvelle session Claude Code dans un repo donné. " +
    "Par défaut mode='headless' (recommandé): claude -p, one-shot, résultat dans .wikichat/artifacts/. " +
    "mode='interactive' ouvre une fenêtre terminal persistante (à éviter sauf besoin explicite).",
    {
      repo_path: z.string().describe("Chemin absolu vers le repo"),
      name: z.string().describe("Nom que la session utilisera"),
      role: z.string().optional(),
      initial_task: z.string().optional(),
      mode: z.enum(["headless", "daemon", "interactive"]).default("headless")
        .describe("headless = claude -p one-shot; daemon = persistant en background (recommandé pour chat); interactive = fenêtre terminal"),
    },
    async ({ repo_path, name, role, initial_task, mode = "headless" }) => {
      if (!fs.existsSync(repo_path)) return txt(`❌ Répertoire introuvable: "${repo_path}"`);
      const launcherName = getSessionName(sessionId);
      const repoName = path.basename(repo_path);

      // ── HEADLESS MODE (default) ───────────────────────────────────────────
      if (mode === "headless") {
        const prompt = initial_task
          ? PROMPT_TEMPLATES.task(name, initial_task, { projectPath: repo_path, role: role })
          : PROMPT_TEMPLATES.task(name, `Rejoindre le réseau wikichat, te présenter sur #coordination, et attendre des instructions via poll_messages.`, { projectPath: repo_path, role: role });

        // Create spawn ticket
        const ticketId = randomUUID().slice(0, 8);
        const ticket = {
          id: ticketId, name, mode, repo: repoName,
          spawnedBy: launcherName, spawnerId: sessionId,
          status: "running", createdAt: new Date(),
          completedAt: null, result: null,
        };
        state.spawnTickets.set(ticketId, ticket);

        sysMsg("coordination", `🚀 ${launcherName} lance "${name}" en mode headless dans ${repoName}${role ? ` (${role})` : ""} [ticket:${ticketId}]`);
        notify("coordination", sessionId);

        // Fire-and-forget: result goes to .wikichat/artifacts/
        spawnHeadless(repo_path, prompt, {
          name, role: role ?? "agent",
          port: parseInt(process.env.PORT || "3777"),
          spawnedBy: launcherName,
        }).then(result => {
          const status = result.success ? "✅ terminé" : `❌ échec (exit ${result.exitCode})`;
          ticket.status = result.success ? "completed" : "failed";
          ticket.completedAt = new Date();
          ticket.result = { success: result.success, exitCode: result.exitCode };
          sysMsg("coordination", `${status} — headless "${name}" dans ${repoName} [ticket:${ticketId}]`);
          // DM the spawner on pre-flight failures so they know what happened
          if (!result.success && result.exitCode < 0) {
            const reason =
              result.exitCode === -2 ? `Budget atteint — trop de sessions actives` :
              result.exitCode === -3 ? `Profondeur de spawn maximale atteinte` :
              result.exitCode === -4 ? `Quota quotidien/concurrent atteint` :
              result.stderr?.slice(0, 200) || "Échec inconnu";
            const spawnerSession = getSessionByName(launcherName);
            const dmKey = dmChannelKey("Système", launcherName);
            if (!state.channels.has(dmKey)) {
              state.channels.set(dmKey, {
                name: dmKey, description: `DM Système → ${launcherName}`,
                createdBy: "system", createdAt: new Date(),
                isDM: true, participants: ["système", launcherName.toLowerCase()],
              });
            }
            pushMessage({
              id: randomUUID(), from: "system", fromName: "🔔 Système",
              channel: dmKey, isDM: true,
              content: `❌ Spawn échoué pour "${name}" (exit ${result.exitCode}): ${reason}`,
              timestamp: new Date(),
            });
            if (spawnerSession) notify(dmKey, null);
          }
          notifyWaiters("__tickets__", null);
        }).catch(() => {
          ticket.status = "failed";
          ticket.completedAt = new Date();
          ticket.result = { success: false, error: "spawn crashed" };
          notifyWaiters("__tickets__", null);
        });

        return txt(
          `🚀 "${name}" lancé en mode headless dans ${repoName}.\n\n` +
          `🎫 Ticket: ${ticketId} — poll_ticket("${ticketId}") pour suivre\n` +
          `📄 Résultat → .wikichat/artifacts/ (récupéré automatiquement dans 2min)\n` +
          `📡 Progression visible sur #coordination\n` +
          `📊 Dashboard: http://localhost:${process.env.PORT || 3777}/dashboard`
        );
      }

      // ── DAEMON MODE (persistent background agent) ────────────────────────
      if (mode === "daemon") {
        const ticketId = randomUUID().slice(0, 8);
        const ticket = {
          id: ticketId, name, mode, repo: repoName,
          spawnedBy: launcherName, spawnerId: sessionId,
          status: "starting", createdAt: new Date(),
          completedAt: null, result: null,
        };
        state.spawnTickets.set(ticketId, ticket);

        sysMsg("coordination", `🚀 ${launcherName} lance "${name}" en mode daemon dans ${repoName}${role ? ` (${role})` : ""} [ticket:${ticketId}]`);
        notify("coordination", sessionId);

        const result = spawnDaemon(repo_path, {
          name, role: role ?? "agent", task: initial_task,
          port: parseInt(process.env.PORT || "3777"),
          spawnedBy: launcherName,
        });

        if (result.success) {
          ticket.status = "running";
          ticket.result = { pid: result.pid };
          return txt(
            `🟢 "${name}" lancé en mode daemon (PID ${result.pid}) dans ${repoName}.\n\n` +
            `🎫 Ticket: ${ticketId}\n` +
            `📡 Il va register() et boucler sur poll_messages.\n` +
            `💬 Envoie-lui des messages via send_message ou depuis le cockpit.\n` +
            `📊 Dashboard: http://localhost:${process.env.PORT || 3777}/dashboard`
          );
        } else {
          ticket.status = "failed";
          ticket.completedAt = new Date();
          ticket.result = { success: false, error: result.error };
          // DM the spawner so they know why the daemon failed to start
          const dmKey = dmChannelKey("Système", launcherName);
          if (!state.channels.has(dmKey)) {
            state.channels.set(dmKey, {
              name: dmKey, description: `DM Système → ${launcherName}`,
              createdBy: "system", createdAt: new Date(),
              isDM: true, participants: ["système", launcherName.toLowerCase()],
            });
          }
          pushMessage({
            id: randomUUID(), from: "system", fromName: "🔔 Système",
            channel: dmKey, isDM: true,
            content: `❌ Spawn daemon échoué pour "${name}": ${result.error}`,
            timestamp: new Date(),
          });
          const spawnerSession = getSessionByName(launcherName);
          if (spawnerSession) notify(dmKey, null);
          return txt(`❌ Échec daemon "${name}": ${result.error}`);
        }
      }

      // ── INTERACTIVE MODE ──────────────────────────────────────────────────
      // .mcp.json
      const mcpJsonPath = path.join(repo_path, ".mcp.json");
      if (!fs.existsSync(mcpJsonPath)) {
        writeAgentFile(repo_path, "", ".mcp.json", JSON.stringify({
          mcpServers: { wikichat: { type: "sse", url: `http://localhost:${process.env.PORT || 3777}/sse` } }
        }, null, 2));
      }

      // .claude/wikichat/
      const claudeDir = path.join(repo_path, ".claude");
      const wikichatDir = path.join(claudeDir, "wikichat");
      for (const d of ["", "messages", "artifacts", "tasks"]) {
        fs.mkdirSync(path.join(wikichatDir, d), { recursive: true });
      }
      writeAgentFile(wikichatDir, "", "context.json", JSON.stringify({
        name, role: role ?? null, type: "spawned",
        spawned_by: launcherName, repo_path, project: repoName,
        storage_path: wikichatDir, registered_at: new Date().toISOString(),
      }, null, 2));

      // settings.local.json — whitelist filesystem reads/wikichat writes + all wikichat MCP tools
      writeAgentFile(claudeDir, "", "settings.local.json", JSON.stringify({
        permissions: {
          allow: [
            "Read(**)", "Glob(**)", "Grep(**)", "LS(**)",
            "Write(.wikichat/**)", "Edit(.wikichat/**)",
            "mcp__wikichat__*",
          ]
        },
        enabledMcpjsonServers: ["wikichat"],
      }, null, 2));

      // CLAUDE.md
      const claudeMdPath = path.join(claudeDir, "CLAUDE.md");
      const launcherDisplay = launcherName.startsWith("session-") ? "un agent wikichat" : launcherName;
      const claudeMd = [
        `# Agent: ${name}`,
        ``,
        `## Identité`,
        `- **Nom**: ${name}`,
        role ? `- **Rôle**: ${role}` : null,
        `- **Projet**: ${repoName}`,
        `- **Invoqué par**: ${launcherDisplay} via WikiChat`,
        ``,
        `## Mission`,
        initial_task ?? `Rejoindre le réseau wikichat, te présenter, et attendre des instructions.`,
        ``,
        `## Protocole WikiChat`,
        `Tu fais partie d'un réseau multi-agents (MCP WikiChat, localhost:${process.env.PORT || 3777}).`,
        `À chaque démarrage :`,
        `1. \`register\` (name: "${name}"${role ? `, role: "${role}"` : ""})`,
        `2. \`declare_capabilities\` (current_project: "${repoName}", availability: "available")`,
        `3. Message de confirmation sur #coordination`,
        `4. \`poll_messages(timeout_seconds=60, types=["message","direct_message","broadcast","artifact"])\` — BOUCLE INFINIE`,
        ``,
        `## Règle absolue`,
        `Tu ne termines JAMAIS ta session. Tu boucles: poll → répondre → poll → ...`,
        `Timeout = relancer poll_messages immédiatement. Jamais de question "dois-je continuer ?".`,
      ].filter(l => l !== null).join("\n");

      const existing = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, "utf8") : null;
      if (!existing) writeAgentFile(claudeDir, "", "CLAUDE.md", claudeMd);
      else if (!existing.includes("Protocole WikiChat")) writeAgentFile(claudeDir, "", "CLAUDE.md", existing + "\n\n" + claudeMd);

      // Spawn registry
      const spawnEntry = { name, role: role ?? null, repo_path, storage_path: wikichatDir, initial_task: initial_task ?? null, spawned_by: launcherName, spawned_at: new Date().toISOString(), status: "starting" };
      writeAgentFile(claudeDir, "", "wikichat_spawn.json", JSON.stringify(spawnEntry, null, 2));
      upsertSpawnRegistry(spawnEntry);

      // Launch interactive session via claude.exe native
      const claudeBin = findClaudeBin();
      if (!claudeBin) {
        upsertSpawnRegistry({ ...spawnEntry, status: "failed", failed_at: new Date().toISOString() });
        return txt(`❌ claude CLI introuvable. Installez via: irm https://claude.ai/install.ps1 | iex`);
      }

      const winPath = repo_path.replace(/\//g, "\\");
      const mcpConfigPath = path.join(repo_path, ".mcp.json");
      const claudeArgs = [`"${claudeBin}"`, `--name`, `"${name}"`];
      if (fs.existsSync(mcpConfigPath)) claudeArgs.push(`--mcp-config`, `"${mcpConfigPath.replace(/\//g, "\\\\")}"`);

      try {
        const batFile = path.join(process.env.TEMP ?? "C:\\Windows\\Temp", `wc_${randomUUID().slice(0, 8)}.bat`);
        fs.writeFileSync(batFile, `@echo off\ncd /d "${winPath}"\n${claudeArgs.join(" ")}\n`);
        const batWin = batFile.replace(/\//g, "\\");
        const child = spawn("cmd", ["/c", "start", "cmd", "/k", batWin], { detached: true, stdio: "ignore", shell: true });
        child.unref();
        upsertSpawnRegistry({ ...spawnEntry, status: "running", started_at: new Date().toISOString() });
      } catch (err) {
        upsertSpawnRegistry({ ...spawnEntry, status: "failed", failed_at: new Date().toISOString() });
        return txt(`❌ Spawn de "${name}" échoué: ${err.message}`);
      }

      sysMsg("coordination", `🚀 ${launcherName} a lancé "${name}" dans ${repoName}${role ? ` (${role})` : ""}${initial_task ? ` — ${initial_task}` : ""}`);
      notify("coordination", sessionId);

      return txt(
        `🚀 Session "${name}" lancée dans ${repoName}.\n\n` +
        `📡 Apparaîtra sur #coordination dans 1-2min.\n` +
        `📂 Contexte: ${wikichatDir}\n\n` +
        `💡 poll_messages(channel="coordination") pour sa confirmation.\n` +
        `📊 Suivre en temps réel: http://localhost:${process.env.PORT || 3777}/dashboard`
      );
    }
  );

  // respawn handled by watchdog auto-respawn
  // (removed: respawn_session tool — watchdog handles daemon respawn automatically)

  // ── kill_spawn — owner-only kill of a tracked spawn ─────────────────────────
  // Governance rule:
  //   - You can kill a spawn you launched (entry.spawned_by == your name)
  //   - You can kill any spawn if you are the principal agent (env
  //     WIKICHAT_PRINCIPAL_AGENT matches your name, default "Claude-Code")
  //   - Workers spawned by triggers (entry.spawned_by starts with "trigger:")
  //     are owned by the wikichat service — only the principal agent can kill
  //     them
  server.tool(
    "kill_spawn",
    "Tuer un spawn que tu possèdes. Tu ne peux killer que tes propres spawns, sauf si tu es l'agent principal (WIKICHAT_PRINCIPAL_AGENT).",
    { name: z.string().describe("Nom de l'agent à tuer") },
    async ({ name }) => {
      const caller = getSessionName(sessionId);
      const principalName = process.env.WIKICHAT_PRINCIPAL_AGENT || "Claude-Code";
      const isPrincipal = caller === principalName;

      const reg = loadSpawnRegistry();
      const entry = reg.find(e => e.name === name);
      if (!entry) return txt(`❌ "${name}" introuvable dans le spawn registry.`);
      if (!entry.pid) return txt(`❌ "${name}" n'a pas de PID enregistré.`);

      const isWorker = typeof entry.spawned_by === "string" && entry.spawned_by.startsWith("trigger:");
      const isOwner = entry.spawned_by === caller;

      if (isWorker && !isPrincipal) {
        return txt(`🚫 "${name}" est un worker WikiChat (spawned_by: ${entry.spawned_by}). Seul l'agent principal (${principalName}) peut le killer.`);
      }
      if (!isOwner && !isPrincipal) {
        return txt(`🚫 "${name}" est owned par ${entry.spawned_by}, pas par toi (${caller}).`);
      }

      try {
        process.kill(entry.pid, "SIGTERM");
        upsertSpawnRegistry({
          ...entry,
          status: "ended",
          ended_at: new Date().toISOString(),
          ended_reason: `killed_by:${caller}`,
        });
        return txt(`🗑️  "${name}" (pid ${entry.pid}) killed par ${caller}.`);
      } catch (err) {
        // Process probably already gone — reconcile registry
        upsertSpawnRegistry({
          ...entry,
          status: "ended",
          ended_at: new Date().toISOString(),
          ended_reason: "already_dead",
        });
        return txt(`⚠️ "${name}" déjà mort (${err.code || err.message}). Registry mis à jour.`);
      }
    }
  );

  server.tool("list_spawned", "Lister les sessions spawnées par ce client.", {}, async () => {
    const callerName = getSessionName(sessionId);
    const mine = loadSpawnRegistry().filter(e => e.spawned_by === callerName);
    if (!mine.length) return txt(`Aucune session spawnée par ${callerName}.`);
    const lines = mine.map(e => {
      const live = [...state.sessions.values()].find(s => s.name === e.name);
      return `• **${e.name}** — ${live ? `🟢 connecté` : "⚫ offline"} — ${path.basename(e.repo_path)}${e.role ? ` — ${e.role}` : ""}${e.initial_task ? `\n  tâche: ${e.initial_task}` : ""}`;
    });
    return txt(`Sessions spawnées par **${callerName}** (${mine.length}):\n\n${lines.join("\n")}`);
  });

  // ── poll_ticket ──────────────────────────────────────────────────────────────

  server.tool(
    "poll_ticket",
    "Suivre un spawn ticket. Attend que l'agent spawnée change de status (completed/failed). Retourne immédiatement si déjà terminé.",
    {
      ticket_id: z.string().describe("ID du ticket retourné par spawn_session"),
      timeout_seconds: z.number().default(30).describe("Timeout en secondes (max: 120)"),
    },
    async ({ ticket_id, timeout_seconds }) => {
      const ticket = state.spawnTickets.get(ticket_id);
      if (!ticket) {
        // List available tickets for this spawner
        const mine = [...state.spawnTickets.values()].filter(t => t.spawnerId === sessionId);
        const hint = mine.length > 0
          ? `\nVos tickets: ${mine.map(t => `${t.id} (${t.name}: ${t.status})`).join(", ")}`
          : "";
        return txt(`❌ Ticket "${ticket_id}" introuvable.${hint}`);
      }

      // Already done
      if (ticket.status === "completed" || ticket.status === "failed") {
        const duration = ticket.completedAt
          ? `${Math.round((new Date(ticket.completedAt) - new Date(ticket.createdAt)) / 1000)}s`
          : "?";
        return txt(
          `🎫 Ticket ${ticket_id} — ${ticket.status === "completed" ? "✅" : "❌"} ${ticket.status}\n` +
          `  Agent: ${ticket.name} (${ticket.mode}) dans ${ticket.repo}\n` +
          `  Durée: ${duration}\n` +
          `  Résultat: ${JSON.stringify(ticket.result)}`
        );
      }

      // Wait for completion via long-poll on __tickets__ channel
      const timeout = Math.min(timeout_seconds, 120) * 1000;
      await registerWaiter(sessionId, "__tickets__", timeout);

      // Re-check after wakeup
      if (ticket.status === "completed" || ticket.status === "failed") {
        const duration = ticket.completedAt
          ? `${Math.round((new Date(ticket.completedAt) - new Date(ticket.createdAt)) / 1000)}s`
          : "?";
        return txt(
          `🎫 Ticket ${ticket_id} — ${ticket.status === "completed" ? "✅" : "❌"} ${ticket.status}\n` +
          `  Agent: ${ticket.name} (${ticket.mode}) dans ${ticket.repo}\n` +
          `  Durée: ${duration}\n` +
          `  Résultat: ${JSON.stringify(ticket.result)}`
        );
      }

      return txt(
        `⏰ Timeout ${timeout_seconds}s — ticket ${ticket_id} toujours ${ticket.status}\n` +
        `  Agent: ${ticket.name} (${ticket.mode}) dans ${ticket.repo}\n` +
        `  Relancez poll_ticket("${ticket_id}") pour continuer à attendre.`
      );
    }
  );

  // ══ ROUTINES (Phase 6) ══════════════════════════════════════════════════════

  server.tool(
    "register_routine",
    "Enregistre un workflow nommé multi-étapes (spawn, broadcast, wait, summarize, sleep). Idempotent par run_key. Persisté.",
    {
      id: z.string().describe("Identifiant stable de la routine"),
      description: z.string().optional(),
      steps: z.any().describe("Tableau d'étapes [{action, params}], avec interpolation {param} et {stepN.field}"),
      params: z.any().optional().describe("Schéma des paramètres attendus"),
      cache_seconds: z.number().optional(),
    },
    async (spec) => {
      try {
        const def = registerRoutine(spec);
        return txt(`✅ Routine "${def.id}" enregistrée (${def.steps.length} step(s)).`);
      } catch (err) {
        return txt(`❌ ${err.message}`);
      }
    }
  );

  server.tool(
    "list_routines",
    "Lister les routines disponibles avec stats (run_count, last_run).",
    {},
    async () => {
      const rs = listRoutines();
      if (rs.length === 0) return txt("(aucune routine)");
      const lines = rs.map(r =>
        `${r.enabled ? "🟢" : "⚫"} ${r.id} (${r.steps.length} steps) — ${r.description || "(no desc)"}\n` +
        `   ran ${r.run_count}× | last: ${r.last_run_at || "never"} (${r.last_run_status || "-"})`
      );
      return txt(`📋 ${rs.length} routine(s):\n\n${lines.join("\n\n")}`);
    }
  );

  server.tool(
    "run_routine",
    "Exécuter une routine avec des paramètres. Idempotent si run_key fourni (re-run dans la fenêtre de cache renvoie le résultat précédent).",
    {
      id: z.string(),
      params: z.any().optional(),
      run_key: z.string().optional().describe("Clé d'idempotence — réexécuter avec la même clé renvoie le résultat caché si dans cache_seconds"),
    },
    async ({ id, params, run_key }) => {
      const callerName = getSessionName(sessionId);
      const result = await runRoutine(id, params || {}, {
        run_key, spawnedBy: callerName, routineId: id,
      });
      if (result.error) return txt(`❌ ${result.error}`);
      const summary = `runId: ${result.runId}\nstatus: ${result.status}\nduration: ${result.durationMs}ms\nsteps: ${result.steps.length}${result.cached ? " (cached)" : ""}`;
      const stepLines = result.steps.map(s =>
        `  ${s.error ? "❌" : "✓"} step ${s.step} (${s.action}): ${s.error || JSON.stringify(s.output).slice(0, 100)}`
      ).join("\n");
      return txt(`🚀 Routine "${id}":\n${summary}\n\n${stepLines}`);
    }
  );

  server.tool(
    "delete_routine",
    "Supprimer une routine.",
    { id: z.string() },
    async ({ id }) => {
      const ok = deleteRoutine(id);
      return txt(ok ? `🗑️  Supprimé: ${id}` : `❌ Routine "${id}" introuvable.`);
    }
  );

  // ══ TRIGGERS (Phase 5) ══════════════════════════════════════════════════════

  server.tool(
    "register_trigger",
    "Enregistre un trigger qui exécutera une action quand son événement survient. " +
    "Types : cron (schedule cron), lifecycle (au boot), file_watch (chokidar sur paths), " +
    "mention (@Name dans message), channel_match (regex sur message d'un canal), webhook (POST endpoint). " +
    "Actions : spawn_session, broadcast, run_routine. Persisté dans ~/.wikichat/triggers.json.",
    {
      id: z.string().optional().describe("ID stable (sinon UUID auto)"),
      type: z.enum(["cron", "lifecycle", "file_watch", "mention", "channel_match", "webhook"]).describe("Type d'événement"),
      config: z.any().optional().describe("Config spécifique : cron→{schedule}, file_watch→{paths,debounce_ms,depth}, mention→{target_name}, channel_match→{channel,pattern,flags}"),
      action_type: z.enum(["spawn_session", "broadcast", "run_routine"]).describe("Type d'action à exécuter"),
      action_params: z.any().optional().describe("Paramètres de l'action (ex: {channel, content} pour broadcast, {id} pour run_routine)"),
      cooldown_s: z.number().optional().describe("Délai minimum entre 2 fires (défaut 30s)"),
      max_per_day: z.number().optional().describe("Cap quotidien (défaut 100)"),
      description: z.string().optional(),
    },
    async ({ action_type, action_params, ...rest }) => {
      try {
        const spec = { ...rest, action: { type: action_type, params: action_params || {} } };
        const t = registerTrigger(spec);
        return txt(`✅ Trigger "${t.id}" enregistré (${t.type}, ${t.enabled ? "actif" : "inactif"}).`);
      } catch (err) {
        return txt(`❌ Échec: ${err.message}`);
      }
    }
  );

  server.tool(
    "list_triggers",
    "Lister tous les triggers enregistrés et leur état (last_fired, fire_count, enabled).",
    {},
    async () => {
      const ts = listTriggers();
      if (ts.length === 0) return txt("(aucun trigger enregistré)");
      const lines = ts.map(t =>
        `${t.enabled ? "🟢" : "⚫"} ${t.id} [${t.type}] — ${t.description || "(no desc)"}\n` +
        `   action: ${t.action?.type}(${t.action?.params?.name || "?"}) | ` +
        `fired ${t.fire_count}× | last: ${t.last_fired || "never"}`
      );
      return txt(`📋 ${ts.length} trigger(s):\n\n${lines.join("\n\n")}`);
    }
  );

  server.tool(
    "fire_trigger",
    "Déclencher manuellement un trigger (utile pour tester). Respecte cooldown sauf si force=true.",
    {
      id: z.string().describe("ID du trigger"),
      force: z.boolean().optional().describe("Bypass cooldown/quota (défaut false)"),
    },
    async ({ id, force }) => {
      const result = await fireTrigger(id, { force: !!force, source: "manual" });
      if (result.ok) return txt(`✅ Trigger "${id}" exécuté.`);
      return txt(`❌ Refusé: ${result.reason}${result.detail ? ` — ${typeof result.detail === "string" ? result.detail : JSON.stringify(result.detail)}` : ""}`);
    }
  );

  server.tool(
    "set_trigger_enabled",
    "Activer ou désactiver un trigger sans le supprimer.",
    {
      id: z.string(),
      enabled: z.boolean(),
    },
    async ({ id, enabled }) => {
      const ok = setEnabled(id, enabled);
      return txt(ok ? `${enabled ? "🟢 Activé" : "⚫ Désactivé"}: ${id}` : `❌ Trigger "${id}" introuvable.`);
    }
  );

  server.tool(
    "delete_trigger",
    "Supprimer un trigger définitivement.",
    { id: z.string() },
    async ({ id }) => {
      const ok = deleteTrigger(id);
      return txt(ok ? `🗑️  Supprimé: ${id}` : `❌ Trigger "${id}" introuvable.`);
    }
  );

  // ══ CARTOGRAPHY ═════════════════════════════════════════════════════════════

  server.tool(
    "run_cartography",
    "Run a full cartography cycle: scan projects, detect changes, generate island map",
    {},
    async () => {
      try {
        const result = await runCartography({
          log: msg => console.log(msg),
          share: async ({ title, content, channel }) => {
            sysMsg(channel || "cartography", `📊 ${title}\n\n${content}`);
          },
        });
        return txt(
          `📊 Cartography terminée\n\n` +
          `Scannés: ${result.scanned} | Changés: ${result.changed}\n` +
          `Carte: ${result.mapPath}`
        );
      } catch (err) {
        return txt(`❌ Cartography échouée: ${err.message}`);
      }
    }
  );

  server.tool(
    "run_clustering",
    "Run inter-project similarity clustering based on deps, langs, and tags (pure JS, no LLM)",
    {},
    async () => {
      try {
        const result = await runClustering({
          log: msg => console.log(msg),
          share: async ({ title, content, channel }) => {
            sysMsg(channel || "cartography", `🔗 ${title}\n\n${content}`);
          },
        });
        return txt(
          `🔗 Clustering terminé\n\n` +
          `Projets: ${result.projects} | Liaisons: ${result.edges} | Clusters: ${result.clusters}\n` +
          `Fichier: ${result.path}`
        );
      } catch (err) {
        return txt(`❌ Clustering échoué: ${err.message}`);
      }
    }
  );

  // ══ PROJECT DISCOVERY ═══════════════════════════════════════════════════════

  server.tool(
    "scan_projects",
    "Scan the local machine for Claude projects and update the WikiChat registry",
    {
      roots: z.array(z.string()).optional().describe("Paths to scan (default: from config)"),
    },
    async ({ roots }) => {
      try {
        const config = loadConfig();
        const scanRoots = roots || config.roots;
        const scanned = await scanForProjects(scanRoots, config.maxDepth);
        const registry = loadRegistry();
        const updated = mergeProjects(registry.projects, scanned);
        registry.projects = updated;
        registry.lastScan = new Date().toISOString();
        saveRegistry(registry);

        // Inject overlay into each discovered project
        let injected = 0;
        for (const p of updated.filter(p => p.status !== "missing")) {
          try {
            await injectProject(p);
            injected++;
          } catch { /* non-blocking */ }
        }

        const newCount = updated.filter(p => p.status === "discovered").length;
        const missingCount = updated.filter(p => p.status === "missing").length;

        return txt(
          `✅ Scan terminé\n\n` +
          `📁 Racines scannées: ${scanRoots.join(", ")}\n` +
          `🔍 Projets trouvés: ${scanned.length}\n` +
          `📋 Total registre: ${updated.length} (${newCount} discovered, ${missingCount} missing)\n` +
          `💉 Overlays injectés: ${injected}\n` +
          `⏱  Scan effectué: ${registry.lastScan}\n\n` +
          `Projets découverts:\n` +
          scanned.map(p => `  • ${p.name} (${p.slug}) — ${p.stack?.join(", ") || "stack inconnu"}\n    ${p.path}`).join("\n")
        );
      } catch (err) {
        return txt(`❌ Erreur lors du scan: ${err.message}`);
      }
    }
  );

}
