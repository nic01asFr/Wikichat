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
  dmChannelKey, timeSince, timeUntil, cronInMinutes, overlapScore, getEtaSummary,
  getChannelCount,
} from "./state.mjs";
import { scanForProjects } from "./scanner.mjs";
import { loadRegistry, loadConfig, saveRegistry, mergeProjects } from "./registry.mjs";
import { injectProject } from "./injector.mjs";
import { notifyWaiters, registerWaiter } from "./notifier.mjs";
import {
  saveSnapshot, loadSnapshot, saveProject, loadSpawnRegistry,
  upsertSpawnRegistry, getAgentStoragePath, writeAgentFile,
  SESSION_STORE,
} from "./persistence.mjs";
import { pushDashboardUpdate } from "./dashboard.mjs";
import { recordHeartbeat, loadCronRegistry, saveCronRegistry, upsertCron, deleteCron } from "./resilience.mjs";
import { spawnHeadless, spawnDaemon, findClaudeBin, PROMPT_TEMPLATES } from "./sampler.mjs";
import { restoreIdentity, remember, recall, forgetKey } from "./identity.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function txt(text) { return { content: [{ type: "text", text }] }; }

function notify(channel, excludeId) {
  notifyWaiters(channel, excludeId);
  pushDashboardUpdate();
}

function formatMsgList(msgs) {
  const lines = msgs.map(msg => {
    const t = new Date(msg.timestamp).toLocaleTimeString("fr-FR");
    const ch = msg.isDM ? "📩DM" : `#${msg.channel}`;
    const re = msg.replyTo ? ` ↩️${msg.replyTo.slice(0, 8)}` : "";
    const readers = state.reads.get(msg.id);
    const ack = readers?.size > 0 ? ` ✓${[...readers].join(",")}` : "";
    return `[${t}] [${ch}] ${msg.fromName}: ${msg.content}${re}\n  └─ id:${msg.id.slice(0, 8)}${ack}`;
  });
  const lastId = msgs.at(-1).id;
  return txt(`🔔 ${msgs.length} nouveau(x) message(s):\n\n${lines.join("\n\n")}\n\n🔖 Dernier: ${lastId.slice(0, 8)}`);
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

  // Filter messages visible to this session
  let msgs = state.messages.filter(m =>
    !m.isDM || (state.channels.get(m.channel)?.participants ?? []).includes(sessionId)
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

/** Resolve or create a DM channel, return channel key */
function resolveDMChannel(sessionId, targetName) {
  const target = getSessionByName(targetName);
  if (!target) return { error: `Session "${targetName}" introuvable. Sessions: ${[...state.sessions.values()].map(s => s.name).join(", ")}` };
  const key = dmChannelKey(sessionId, target.id);
  if (!state.channels.has(key)) {
    const senderName = getSessionName(sessionId);
    state.channels.set(key, {
      name: key, description: `DM entre ${senderName} et ${targetName}`,
      createdBy: "system", createdAt: new Date(),
      isDM: true, participants: [sessionId, target.id],
    });
  }
  return { channel: key };
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
      claude_session_id: z.string().optional().describe("ID de session Claude Code, persisté pour permettre --resume aux prochains spawns daemon."),
    },
    async ({ name, role, claude_session_id }) => {
      const conflict = getSessionByName(name);
      if (conflict && conflict.id !== sessionId) {
        return txt(`❌ Le nom "${name}" est déjà pris.`);
      }

      const session = state.sessions.get(sessionId);
      if (!session) return txt("❌ Session introuvable.");

      const oldName = session.name;
      session.name = name;
      session.role = role ?? null;
      session.lastSeen = new Date();

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
      const resumeHint = identity.restored
        ? `\n\n📦 Identité restaurée (${timeSince(identity.snapshotAge)}): ${identity.summary}.` +
          (identity.lastInterlocutors.length
            ? `\n   Derniers interlocuteurs: ${identity.lastInterlocutors.slice(0, 3).join(", ")}`
            : "")
        : "";

      const isCurator = role && /curator|curateur|meta|méta/i.test(role);
      const workflow = isCurator
        ? `🔍 Mode Méta-Curateur: get_context → list_projects → read_agent_history → analyser → share_artifact\n⚠️  Pas besoin de poll_messages.`
        : `💡 Workflow: declare_capabilities → send_message → poll_messages(since_id) — boucle\n   Partage structuré: share_artifact | Urgence: broadcast()`;

      return txt(
        `✅ Enregistré: "${name}"${role ? ` (${role})` : ""}\n\n` +
        `📡 ${state.sessions.size} session(s)${others ? ":\n" + others : " (vous êtes seul)"}\n\n` +
        `Canaux: ${[...state.channels.keys()].filter(c => !c.startsWith("dm:")).map(c => `#${c}`).join(", ")}\n\n` +
        workflow + resumeHint
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
    "Mémoriser une donnée persistante associée à ton identité (clé/valeur). Survit aux sessions et redémarrages.",
    {
      key: z.string().describe("Clé courte (ex: 'preferred_stack', 'current_pr')"),
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

  // ── get_context (legacy — delegates to buildBriefing) ───────────────────────

  server.tool(
    "get_context",
    "Résumé complet de l'état du réseau. Idéal en début de session. Préférez get_briefing() pour un contexte filtré.",
    {},
    async () => buildBriefing(sessionId, {})
  );

  // ── get_briefing ───────────────────────────────────────────────────────────

  server.tool(
    "get_briefing",
    "Briefing intelligent filtré. Détecte vos @mentions, filtre par date/mission, sépare messages prioritaires du flux. Remplace get_context().",
    {
      since: z.string().optional().describe("ISO timestamp ou ID message. Défaut: votre lastSeen"),
      mission: z.string().optional().describe("Votre mission pour filtrer le contexte (ex: 'review sampler.mjs')"),
    },
    async ({ since, mission }) => buildBriefing(sessionId, { since, mission })
  );

  // ══ MESSAGING ═══════════════════════════════════════════════════════════════

  server.tool(
    "send_message",
    "Envoyer un message sur un canal ou en DM. Utilisez '@NomSession' comme canal pour un message direct.",
    {
      content: z.string().describe("Contenu du message"),
      channel: z.string().default("general").describe("Canal cible ou '@Nom' pour un DM"),
      reply_to: z.string().optional().describe("ID du message auquel répondre"),
    },
    async ({ content, channel, reply_to }) => {
      const senderName = getSessionName(sessionId);
      let targetChannel = channel;
      let isDM = false;

      if (channel.startsWith("@")) {
        const res = resolveDMChannel(sessionId, channel.slice(1));
        if (res.error) return txt(`❌ ${res.error}`);
        targetChannel = res.channel;
        isDM = true;
      } else if (!state.channels.has(channel)) {
        return txt(`❌ Canal "#${channel}" inexistant. Disponibles: ${[...state.channels.keys()].filter(c => !c.startsWith("dm:")).map(c => `#${c}`).join(", ")}.`);
      }

      const msg = pushMessage({
        id: randomUUID(), from: sessionId, fromName: senderName,
        channel: targetChannel, content, timestamp: new Date(),
        replyTo: reply_to ?? null, isDM,
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

      return txt(`${isDM ? `📩 DM envoyé à ${channel}` : `📤 Envoyé sur #${channel}`}\n🆔 ${msg.id.slice(0, 8)} ⏱️ ${new Date().toLocaleTimeString("fr-FR")}${cronHint}\n\n⚡ Lance poll_messages pour attendre la réponse.`);
    }
  );

  // ── read_messages ───────────────────────────────────────────────────────────

  server.tool(
    "read_messages",
    "Lire les messages récents. Filtrage par canal, expéditeur ou période.",
    {
      channel: z.string().optional().describe("Canal ('__all__' pour tout)"),
      from_session: z.string().optional().describe("Filtrer par expéditeur"),
      since_minutes: z.number().default(30).describe("Messages des N dernières minutes"),
      limit: z.number().default(50).describe("Nombre max"),
      since_id: z.string().optional().describe("Messages après cet ID"),
    },
    async ({ channel, from_session, since_minutes, limit, since_id }) => {
      const cutoff = new Date(Date.now() - since_minutes * 60 * 1000);
      let sinceFound = !since_id;

      const filtered = state.messages.filter(msg => {
        if (!sinceFound) {
          if (msg.id === since_id || msg.id.startsWith(since_id)) sinceFound = true;
          return false;
        }
        if (new Date(msg.timestamp) < cutoff) return false;
        if (channel && channel !== "__all__" && msg.channel !== channel) return false;
        if (msg.isDM) {
          const ci = state.channels.get(msg.channel);
          if (ci?.participants && !ci.participants.includes(sessionId)) return false;
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
        return `[${t}] [${ch}] ${msg.fromName}: ${msg.content}${re}\n  └─ id:${msg.id.slice(0, 8)}`;
      });
      return txt(`📬 ${filtered.length} message(s):\n\n${lines.join("\n\n")}\n\n🔖 Dernier: ${filtered.at(-1).id.slice(0, 8)}`);
    }
  );

  // ── poll_messages ───────────────────────────────────────────────────────────

  server.tool(
    "poll_messages",
    "Attendre de nouveaux messages (long-polling). Pour agents actifs dans une conversation. Les curateurs n'en ont PAS besoin — utilisez read_messages().",
    {
      channel: z.string().default("__all__").describe("Canal à surveiller (défaut: tous)"),
      timeout_seconds: z.number().default(30).describe("Timeout en secondes (max: 120)"),
      since_id: z.string().optional().describe("Attendre les messages après cet ID"),
      types: z.array(z.enum(["message", "direct_message", "system", "broadcast", "artifact"])).optional()
        .describe("Filtrer par types. Ex: ['direct_message','broadcast'] pour ignorer les events système."),
    },
    async ({ channel, timeout_seconds, since_id, types }) => {
      const timeout = Math.min(timeout_seconds, 120) * 1000;

      const session = state.sessions.get(sessionId);
      if (session) session.lastSeen = new Date();

      function matchesFilter(msg) {
        // System channel filtered by default unless explicitly requested
        if (msg.channel === "system" && channel !== "system") {
          if (!types?.includes("system")) return false;
        }
        // Channel filter
        if (channel !== "__all__" && msg.channel !== channel && msg.channel !== "__broadcast__") return false;
        // DM visibility
        if (msg.isDM) {
          const ci = state.channels.get(msg.channel);
          if (ci?.participants && !ci.participants.includes(sessionId)) return false;
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

      // Check buffered messages since since_id — scan from end (O(recent) not O(all))
      if (since_id) {
        const idx = state.messages.findLastIndex(m => m.id === since_id || m.id.startsWith(since_id));
        if (idx >= 0) {
          const buffered = state.messages.slice(idx + 1).filter(matchesFilter);
          if (buffered.length > 0) return formatMsgList(buffered);
        }
      }

      // Long-poll
      const arrived = await registerWaiter(sessionId, channel, timeout);

      if (!arrived) {
        return txt(`⏰ Timeout ${timeout / 1000}s — aucun message.\n💡 Relancez poll_messages.`);
      }

      // Messages in the last 5 seconds — scan from end only
      const cutoff = Date.now() - 5000;
      const recent = [];
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];
        if (new Date(msg.timestamp).getTime() < cutoff) break;
        if (matchesFilter(msg)) recent.unshift(msg);
      }
      return recent.length > 0
        ? formatMsgList(recent)
        : txt("🔔 Activité détectée. Relancez poll_messages.");
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
        return txt(`❌ Canal "#${channel}" inexistant.`);
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

  server.tool("list_sessions", "Lister toutes les sessions connectées.", {}, async () => {
    if (state.sessions.size === 0) return txt("📡 Aucune session connectée.");
    const lines = [...state.sessions.entries()].map(([id, s]) => {
      const me = id === sessionId ? " ← vous" : "";
      const eta = s.eta && new Date(s.eta) > new Date() ? ` ⏳ ${timeUntil(s.eta)}${s.etaReason ? ` (${s.etaReason})` : ""}` : "";
      const avail = s.availability && s.availability !== "available" ? ` [${s.availability}]` : "";
      const task = s.current_task ? `\n    📋 ${s.current_project ? s.current_project + " — " : ""}${s.current_task}` : "";
      const skills = s.skills?.length ? `\n    🔧 ${s.skills.join(", ")}` : "";
      return `  • ${s.name}${s.role ? ` [${s.role}]` : ""}${avail}${s.status ? ` 💬 "${s.status}"` : ""}${eta} — actif ${timeSince(s.lastSeen)}${me}${task}${skills}`;
    });
    return txt(`📡 ${state.sessions.size} session(s):\n\n${lines.join("\n")}`);
  });

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
        state.projects.set(project, { name: project, description: "", repo: null, stack: [], relations: [], status: "active", decisions: [], open_questions: [], blockers: [], tasks: new Map(), createdBy: name, createdAt: new Date() });
      }
      const proj = state.projects.get(project);
      const existing = proj.tasks.get(task);
      if (existing?.status === "active") {
        return txt(`⚠️ Tâche "${task}" déjà revendiquée par ${existing.claimedBy} (${timeSince(existing.claimedAt)}).\n💡 Coordonnez-vous avant de reprendre.`);
      }
      const expiresAt = new Date(Date.now() + 90 * 60 * 1000);
      proj.tasks.set(task, { id: task, description, claimedBy: name, claimedAt: new Date(), status: "active", outcome: null, claim_expires_at: expiresAt });
      proj.updatedAt = new Date();
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
      const proj = existing ?? { name, tasks: new Map(), decisions: [], open_questions: [], blockers: [], createdBy: ownerName, createdAt: new Date() };
      Object.assign(proj, { description, repo: repo ?? proj.repo, stack: stack ?? proj.stack ?? [], relations: relations ?? proj.relations ?? [], status: status ?? proj.status, updatedAt: new Date(), updatedBy: ownerName });
      state.projects.set(name, proj);
      saveProject(proj);
      sysMsg("coordination", `${existing ? "📝 Projet mis à jour" : "🆕 Nouveau projet"}: ${name} — ${description}`);
      notify("coordination", sessionId);
      return txt(`${existing ? "📝 Mis à jour" : "✅ Déclaré"}: "${name}"\n${description}${repo ? `\n🔗 ${repo}` : ""}${stack?.length ? `\n🔧 ${stack.join(", ")}` : ""}`);
    }
  );

  server.tool("list_projects", "Lister tous les projets.", {}, async () => {
    if (!state.projects.size) return txt("📭 Aucun projet.\n💡 declare_project() pour en créer un.");
    const lines = [...state.projects.values()].map(p => {
      const agents = [...state.sessions.values()].filter(s => s.current_project?.toLowerCase() === p.name.toLowerCase());
      const active = [...p.tasks.values()].filter(t => t.status === "active").length;
      return `  • **${p.name}** — ${p.description}${agents.length ? ` | 👥 ${agents.map(a => a.name).join(", ")}` : ""}${active ? ` | 📋 ${active} tâche(s)` : ""}${p.status ? `\n    📊 ${p.status}` : ""}`;
    });
    return txt(`🗺️ ${state.projects.size} projet(s):\n\n${lines.join("\n\n")}\n\n💡 what_is(projet) pour le détail`);
  });

  // ══ SPAWN ═════════════════════════════════════════════════════════════════════

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
          ? PROMPT_TEMPLATES.task(name, initial_task)
          : PROMPT_TEMPLATES.task(name, `Rejoindre le réseau wikichat, te présenter sur #coordination, et attendre des instructions via poll_messages.`);

        sysMsg("coordination", `🚀 ${launcherName} lance "${name}" en mode headless dans ${repoName}${role ? ` (${role})` : ""}`);
        notify("coordination", sessionId);

        // Fire-and-forget: result goes to .wikichat/artifacts/
        spawnHeadless(repo_path, prompt, {
          name, role: role ?? "agent",
          port: parseInt(process.env.PORT || "3777"),
          spawnedBy: launcherName,
        }).then(result => {
          const status = result.success ? "✅ terminé" : `❌ échec (exit ${result.exitCode})`;
          sysMsg("coordination", `${status} — headless "${name}" dans ${repoName}`);
          pushDashboardUpdate();
        }).catch(() => {});

        return txt(
          `🚀 "${name}" lancé en mode headless dans ${repoName}.\n\n` +
          `📄 Résultat → .wikichat/artifacts/ (récupéré automatiquement dans 2min)\n` +
          `📡 Progression visible sur #coordination\n` +
          `📊 Dashboard: http://localhost:${process.env.PORT || 3777}/dashboard`
        );
      }

      // ── DAEMON MODE (persistent background agent) ────────────────────────
      if (mode === "daemon") {
        sysMsg("coordination", `🚀 ${launcherName} lance "${name}" en mode daemon dans ${repoName}${role ? ` (${role})` : ""}`);
        notify("coordination", sessionId);

        const result = spawnDaemon(repo_path, {
          name, role: role ?? "agent", task: initial_task,
          port: parseInt(process.env.PORT || "3777"),
          spawnedBy: launcherName,
        });

        if (result.success) {
          return txt(
            `🟢 "${name}" lancé en mode daemon (PID ${result.pid}) dans ${repoName}.\n\n` +
            `📡 Il va register() et boucler sur poll_messages.\n` +
            `💬 Envoie-lui des messages via send_message ou depuis le cockpit.\n` +
            `📊 Dashboard: http://localhost:${process.env.PORT || 3777}/dashboard`
          );
        } else {
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

      // settings.local.json
      writeAgentFile(claudeDir, "", "settings.local.json", JSON.stringify({
        permissions: {
          allow: [
            "Read(**)", "Glob(**)", "Grep(**)", "LS(**)",
            "Write(.wikichat/**)", "Edit(.wikichat/**)",
            "mcp__wikichat__register", "mcp__wikichat__declare_capabilities",
            "mcp__wikichat__send_message", "mcp__wikichat__read_messages",
            "mcp__wikichat__poll_messages", "mcp__wikichat__list_sessions",
            "mcp__wikichat__list_channels", "mcp__wikichat__get_context",
            "mcp__wikichat__set_status", "mcp__wikichat__share_artifact",
            "mcp__wikichat__ack_message", "mcp__wikichat__declare_delay",
            "mcp__wikichat__broadcast", "mcp__wikichat__create_channel",
          ]
        }
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
