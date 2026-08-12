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

/**
 * Étiquette lisible d'un message pour l'affichage.
 *
 * `__broadcast__` est un canal interne : l'exposer tel quel donne des lignes
 * comme « [#__broadcast__] … » dans les boîtes et les hooks, où le lecteur
 * n'a aucune idée de ce qu'il regarde.
 */
export function channelLabel(msg) {
  if (msg?.isDM) return "📩DM";
  if (msg?.channel === "__broadcast__") return "📢 diffusion";
  return `#${msg?.channel ?? "?"}`;
}

/**
 * Normalise un nom de canal saisi par un agent.
 *
 * L'affichage préfixe les canaux d'un `#` décoratif (`[#insights] …`). Un agent
 * qui recopie ce qu'il lit envoie alors sur "#insights", et le serveur crée un
 * canal distinct de "insights" — deux salons pour un même sujet, dont un que
 * les triggers `channel_match` ne voient pas. On enlève les dièses de tête à
 * l'entrée : le nom canonique n'en porte jamais.
 *
 * Les DM (`dm:…`) et les canaux internes (`__broadcast__`) passent inchangés.
 */
export function normalizeChannel(name) {
  if (typeof name !== "string") return name;
  const trimmed = name.trim();
  if (trimmed.startsWith("@") || trimmed.startsWith("dm:") || trimmed.startsWith("__")) return trimmed;
  return trimmed.replace(/^#+/, "");
}
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

/**
 * Resolve an arbitrary DM target string to a canonical registered session name.
 *
 * DM channels are keyed by agent NAME, and visibility is an exact key/participant
 * match. So if the sender types a name that differs even slightly from the
 * recipient's registered name ("Bob" vs "Bob-Dev", "session-abc123" vs the real
 * name), the message is keyed on a channel the recipient never reads — it's sent
 * but invisible. This resolver maps the typed target to the recipient's actual
 * name BEFORE the key is computed, applied identically on send and on read/poll
 * so both sides agree on the same channel.
 *
 * Resolution order (first hit wins, ambiguity falls through to literal):
 *   1. exact case-insensitive match on a known session name
 *   2. `session-XXXXXX` form → that session's current name (may be a real name now)
 *   3. unique prefix match among real names ("Bob" → "Bob-Dev" if it's the only one)
 *   4. unique substring match
 *   5. literal target (async DM to an agent not yet connected under this name)
 *
 * @returns {{ name: string, matched: boolean, online: boolean }}
 *   name    — canonical name to key the DM on
 *   matched — a known session resolved this target (vs. literal fallback)
 *   online  — the resolved session is currently connected
 */
export function resolveAgentName(target) {
  const fallback = { name: String(target ?? ""), matched: false, online: false };
  if (!target) return fallback;
  const tl = String(target).trim().toLowerCase();
  if (!tl) return fallback;

  const isOnline = (s) => s.availability !== "stale" &&
    (!s.lastSeen || Date.now() - new Date(s.lastSeen).getTime() < 5 * 60 * 1000);

  // 1) exact case-insensitive match
  for (const s of state.sessions.values()) {
    if (s.name && s.name.toLowerCase() === tl) {
      return { name: s.name, matched: true, online: isOnline(s) };
    }
  }
  // 2) session-XXXXXX → resolve to that session's current name
  const anon = /^session-([a-f0-9]{6})$/i.exec(tl);
  if (anon) {
    const prefix = anon[1];
    for (const [sid, s] of state.sessions) {
      if (sid.slice(0, 6) === prefix) {
        return { name: s.name, matched: true, online: isOnline(s) };
      }
    }
    return fallback;
  }
  // 3) unique prefix match among real (non-anonymous) names
  const realSessions = [...state.sessions.values()].filter(s => s.name && !s.name.startsWith("session-"));
  const prefixHits = realSessions.filter(s => s.name.toLowerCase().startsWith(tl));
  if (prefixHits.length === 1) {
    return { name: prefixHits[0].name, matched: true, online: isOnline(prefixHits[0]) };
  }
  // 4) unique substring match
  const subHits = realSessions.filter(s => s.name.toLowerCase().includes(tl));
  if (subHits.length === 1) {
    return { name: subHits[0].name, matched: true, online: isOnline(subHits[0]) };
  }
  // 5) literal fallback — async DM, delivered when target registers under this name
  return fallback;
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

/**
 * inboxFor — the single source of truth for "what is addressed to this agent".
 *
 * One filter, shared by the Stop-hook endpoint (/api/inbox) and the `poll` MCP
 * tool, so a message is delivered under exactly the same rule whether it reaches
 * the agent by push (hook at turn boundary) or pull (explicit poll). "Addressed
 * to me" = a DM where I'm a participant, a broadcast, or a message that @mentions
 * me. Ambient channel chatter is deliberately NOT inbox — it stays readable on
 * demand via read_messages, so a turn-based agent's signal isn't drowned.
 *
 * Cursor is the caller's concern: pass the last id you delivered as `sinceId`
 * and store the returned `lastId` as your new cursor. Resolution:
 *   - sinceId present & found → slice strictly after it
 *   - sinceId present & EVICTED → { resynced:true }, empty (never replay history)
 *   - no sinceId, sinceMinutes>0 → lookback window (first activation catch-up)
 *   - no sinceId, no window → { baseline:true }, empty (arm cursor, no replay)
 *
 * @param {string} name canonical agent name
 * @returns {{ messages: object[], lastId: string|null, resynced?: boolean, baseline?: boolean }}
 */
export function inboxFor(name, { sinceId = null, sinceMinutes = 0 } = {}) {
  const agentLc = String(name || "").toLowerCase();
  const newestId = state.messages.at(-1)?.id ?? null;
  if (!agentLc) return { messages: [], lastId: newestId };

  let candidates;
  if (sinceId) {
    const idx = state.messages.findIndex(m => m.id === sinceId);
    if (idx >= 0) candidates = state.messages.slice(idx + 1);
    else return { messages: [], lastId: newestId, resynced: true };
  } else if (sinceMinutes > 0) {
    const cutoff = Date.now() - sinceMinutes * 60 * 1000;
    candidates = state.messages.filter(m => new Date(m.timestamp).getTime() >= cutoff);
  } else {
    return { messages: [], lastId: newestId, baseline: true };
  }

  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`(^|[^\\w@])@${escaped}([^\\w-]|$)`, "i");
  const messages = candidates.filter(m => {
    if (m.from === "system") return false;
    if (m.fromName && m.fromName.toLowerCase() === agentLc) return false; // never my own
    if (m.isDM) {
      const ci = state.channels.get(m.channel);
      return isAgentInDMChannel(m.channel, name) || !!ci?.participants?.includes(agentLc);
    }
    if (m.channel === "__broadcast__") return true;
    return mention.test(m.content || "");
  });
  return { messages, lastId: newestId ?? sinceId };
}
