/**
 * state.mjs — Shared state store with message cap
 * Inspired by pixel-agents' centralized OfficeState pattern.
 */

import { randomUUID } from "crypto";

export const MAX_MESSAGES = parseInt(process.env.MAX_MESSAGES || "2000");

export const state = {
  /** Map<sessionId, SessionObject> */
  sessions: new Map(),
  /** Map<channelName, ChannelObject> */
  channels: new Map(),
  /** Message[] — capped at MAX_MESSAGES, evicts oldest */
  messages: [],
  /** Map<sessionId, resolver[]> — long-polling waiters */
  waiters: new Map(),
  /** Map<messageId, Set<readerName>> — read receipts */
  reads: new Map(),
  /** Map<projectName, ProjectObject> */
  projects: new Map(),
  /** Map<ticketId, SpawnTicket> — tracks spawned agent lifecycle */
  spawnTickets: new Map(),
  /** Last user-relevant activity (push message, named session register, MCP tool call). */
  lastActivityAt: Date.now(),
};

/** Mark user-relevant activity. Used by idle-gating to skip cleanup cycles when nothing is happening. */
export function markActivity() { state.lastActivityAt = Date.now(); }
/** Has there been activity in the last `windowMs`? */
export function recentlyActive(windowMs = 5 * 60 * 1000) { return (Date.now() - state.lastActivityAt) < windowMs; }

// Default channels
for (const [name, description] of [
  ["general", "Canal par défaut pour les discussions générales"],
  ["coordination", "Canal pour la coordination de tâches entre agents"],
  ["system", "Événements système : connexions, déconnexions, statuts"],
  ["ideation", "Idea pool : capture (add_idea), harmonisation (harmonize_ideas), scoping vers projets"],
]) {
  state.channels.set(name, {
    name, description, createdBy: "system",
    createdAt: new Date(),
    isSystem: name === "system",
  });
}

/** Channel message count cache — O(1) lookup instead of filtering */
const _channelCounts = new Map();
export function getChannelCount(channel) { return _channelCounts.get(channel) || 0; }
/** Rebuild channel counts from current messages (call after loading persisted messages) */
export function rebuildChannelCounts() {
  _channelCounts.clear();
  for (const m of state.messages) {
    if (m.channel) _channelCounts.set(m.channel, (_channelCounts.get(m.channel) || 0) + 1);
  }
}

/** Hook for persistence — set by persistence.mjs at boot */
let _onMessagePush = null;
export function setOnMessagePush(fn) { _onMessagePush = fn; }
/** Listeners notified with each new message (msg) — used by triggers (channel_match, mention). */
const _messageListeners = [];
export function addMessageListener(fn) { _messageListeners.push(fn); }

/** Add a message and evict oldest if over cap */
export function pushMessage(msg) {
  // Update channel count cache
  const ch = msg.channel;
  if (ch) _channelCounts.set(ch, (_channelCounts.get(ch) || 0) + 1);

  // Mark activity — but skip pure system noise (queue/artifact recovery, dashboard pings)
  // to avoid keeping the service "active" forever just because background jobs poke channels.
  if (msg.from !== "system") state.lastActivityAt = Date.now();

  state.messages.push(msg);
  if (state.messages.length > MAX_MESSAGES) {
    const evict = Math.floor(MAX_MESSAGES * 0.1);
    const evicted = state.messages.splice(0, evict);
    // Clean up read receipts and channel counts for evicted messages
    for (const m of evicted) {
      state.reads.delete(m.id);
      if (m.channel) {
        const c = _channelCounts.get(m.channel);
        if (c > 1) _channelCounts.set(m.channel, c - 1);
        else _channelCounts.delete(m.channel);
      }
    }
  }
  if (_onMessagePush) _onMessagePush();
  for (const fn of _messageListeners) {
    try { fn(msg); } catch { /* listener errors must not break the message bus */ }
  }
  return msg;
}

/** Create a system message and push it */
export function sysMsg(channel, content) {
  return pushMessage({
    id: randomUUID(), from: "system", fromName: "🔔 Système",
    channel, content, timestamp: new Date(),
  });
}

/** Find session by display name (case-insensitive) */
export function getSessionByName(name) {
  for (const [id, s] of state.sessions) {
    if (s.name.toLowerCase() === name.toLowerCase()) return { id, ...s };
  }
  return null;
}

/** Get display name for a session ID */
export function getSessionName(sessionId) {
  return state.sessions.get(sessionId)?.name ?? `session-${sessionId.slice(0, 6)}`;
}

/** Build a stable DM channel key between two AGENTS (by name).
 *
 * IMPORTANT : we key by AGENT NAME, not session-id. An agent that disconnects
 * and reconnects keeps the same DM history because the channel name is derived
 * from the agent's stable identity, not its ephemeral session-id.
 *
 * Format : `dm:alice__bob` (sorted, double-underscore separator to avoid
 * ambiguity when names contain hyphens like "claude-code").
 *
 * Anonymous sessions (`session-XXX`) fall back to id-based keying since they
 * have no stable identity.
 */
export function dmChannelKey(idOrNameA, idOrNameB) {
  function nameOf(idOrName) {
    if (!idOrName) return idOrName;
    const session = state.sessions.get(idOrName);
    if (session && session.name && !session.name.startsWith("session-")) {
      return session.name.toLowerCase();
    }
    return String(idOrName).toLowerCase();
  }
  const [a, b] = [nameOf(idOrNameA), nameOf(idOrNameB)].sort();
  // Sanitize : keep only alphanum + hyphen, max 32 chars per side. Separator is __
  const safe = (s) => String(s).replace(/[^a-z0-9-]/g, "").slice(0, 32);
  return `dm:${safe(a)}__${safe(b)}`;
}

/** Returns true if the given agent name is one of the participants in the DM channel.
 *  E.g. "alice" is in "dm:alice__bob" but not in "dm:carol__dave". */
export function isAgentInDMChannel(channelName, agentName) {
  if (!channelName?.startsWith("dm:") || !agentName) return false;
  const safe = String(agentName).toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 32);
  const parts = channelName.slice(3).split("__");
  return parts.includes(safe);
}

/** Time helpers */
export function timeSince(date) {
  const s = Math.floor((Date.now() - new Date(date)) / 1000);
  if (s < 60) return `il y a ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m}min`;
  const h = Math.floor(m / 60);
  return `il y a ${h}h${m % 60}min`;
}

export function timeUntil(date) {
  const s = Math.floor((new Date(date) - Date.now()) / 1000);
  if (s <= 0) return "maintenant";
  if (s < 60) return `dans ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `dans ${m}min`;
  const h = Math.floor(m / 60);
  return `dans ${h}h${m % 60}min`;
}

/** Cron expression for "in N minutes from now" */
export function cronInMinutes(n) {
  const t = new Date(Date.now() + n * 60 * 1000);
  return `${t.getMinutes()} ${t.getHours()} ${t.getDate()} ${t.getMonth() + 1} *`;
}

/** Word-overlap score for duplicate task detection */
export function overlapScore(a = "", b = "") {
  const words = s => new Set(s.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wa = words(a), wb = words(b);
  const inter = [...wa].filter(w => wb.has(w)).length;
  return inter / Math.max(1, Math.min(wa.size, wb.size));
}

/** Summary of active ETAs (excluding a session) */
export function getEtaSummary(excludeId) {
  const now = Date.now();
  return [...state.sessions.values()]
    .filter(s => s.sessionId !== excludeId && s.eta && new Date(s.eta) > now)
    .map(s => `  ⏳ ${s.name}: ${timeUntil(s.eta)}${s.etaReason ? ` (${s.etaReason})` : ""}`);
}
