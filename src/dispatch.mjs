/**
 * dispatch.mjs — Intent-based routing.
 *
 * Caller declares an intent ("review this diff", "audit panoramax3d") plus
 * optional context. The dispatcher chooses the best executor :
 *
 *   1. Score live agents who declared matching capabilities/skills
 *   2. Adjust score by track record (success ratio on similar past intents)
 *   3. Consider availability (not stale, not on a conflicting task)
 *   4. If a viable live candidate exists → send a DM with the intent
 *      (messagerie route — the agent picks it up via poll_messages)
 *   5. Otherwise → spawn an ad-hoc headless agent with the intent as task
 *
 * Track record persisted in ~/.wikichat/dispatch-record.json :
 *   { agent_name: { capability: { successes, failures, last_used } } }
 *
 * Dispatch log persisted append-only in ~/.wikichat/dispatch.jsonl
 * (used by `explain_dispatch` to show how a decision was made).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { writeAtomicJSON } from "./persistence.mjs";
import { state } from "./state.mjs";

const RECORD_FILE = path.join(os.homedir(), ".wikichat", "dispatch-record.json");
const LOG_FILE = path.join(os.homedir(), ".wikichat", "dispatch.jsonl");

const _record = new Map(); // Map<agentName, Map<capability, {ok, fail, lastUsed}>>

let _ctx = {
  spawn: null,         // (params) => Promise<{ success, ticketId, ... }>
  sendDM: null,        // ({to, content}) => { id }
};

let _saveTimer = null;
function _saveDebounced() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(_flush, 1500);
}
function _flush() {
  _saveTimer = null;
  try {
    const obj = {};
    for (const [agent, caps] of _record) {
      obj[agent] = Object.fromEntries(caps);
    }
    writeAtomicJSON(RECORD_FILE, obj);
  } catch { /* */ }
}

export function configureDispatch(ctx) {
  _ctx = { ..._ctx, ...ctx };
}

export function loadDispatchRecord() {
  try {
    if (!fs.existsSync(RECORD_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(RECORD_FILE, "utf8"));
    for (const [agent, caps] of Object.entries(raw)) {
      _record.set(agent, new Map(Object.entries(caps)));
    }
  } catch { /* */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Capability scoring
// ─────────────────────────────────────────────────────────────────────────────

function _extractKeywords(text) {
  return new Set(
    String(text || "").toLowerCase()
      .split(/[^a-z0-9_]+/i)
      .filter(w => w.length > 2)
  );
}

function _capabilityMatch(intentKeywords, agent) {
  // Score via Jaccard between intent keywords and agent's declared skills + role + current_project
  const declared = new Set();
  for (const s of (agent.skills || [])) _extractKeywords(s).forEach(k => declared.add(k));
  if (agent.role) _extractKeywords(agent.role).forEach(k => declared.add(k));
  if (agent.current_project) _extractKeywords(agent.current_project).forEach(k => declared.add(k));

  if (declared.size === 0) return 0;
  let inter = 0;
  for (const k of intentKeywords) if (declared.has(k)) inter++;
  return inter / (intentKeywords.size + declared.size - inter);
}

function _trackRecordBoost(agentName, intentKeywords) {
  const caps = _record.get(agentName);
  if (!caps) return 1.0;
  // Average success ratio on capabilities matching this intent
  let total = 0, count = 0;
  for (const [cap, stats] of caps) {
    if (intentKeywords.has(cap.toLowerCase())) {
      const tot = (stats.ok || 0) + (stats.fail || 0);
      if (tot > 0) {
        total += stats.ok / tot;
        count++;
      }
    }
  }
  if (count === 0) return 1.0;
  return 0.5 + (total / count); // multiplier 0.5–1.5
}

function _availabilityBoost(agent) {
  if (!agent) return 0;
  if (agent.availability === "stale") return 0;
  if (agent.current_task) return 0.3; // busy, can still take but penalized
  return 1.0;
}

/**
 * Pick the best live agent for an intent. Returns { agent, score, breakdown } or null.
 */
function _pickAgent(intent, prefer) {
  const intentKeywords = _extractKeywords(intent);
  const candidates = [];
  for (const session of state.sessions.values()) {
    if (!session.name || session.name.startsWith("session-")) continue;
    if (session.agent_type === "headless") continue; // headless are one-shot, can't take intents
    const capScore = _capabilityMatch(intentKeywords, session);
    const trackBoost = _trackRecordBoost(session.name, intentKeywords);
    const avail = _availabilityBoost(session);
    const score = capScore * trackBoost * avail;
    candidates.push({
      agent: { name: session.name, role: session.role, agent_type: session.agent_type, availability: session.availability, current_task: session.current_task },
      score,
      breakdown: { capability: capScore, trackRecord: trackBoost, availability: avail },
    });
  }

  // Prefer override: if specified and present, give it a +0.2 boost
  if (prefer) {
    const c = candidates.find(c => c.agent.name === prefer);
    if (c) c.score += 0.2;
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length === 0 || candidates[0].score < 0.05) return { best: null, ranked: candidates };
  return { best: candidates[0], ranked: candidates };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Dispatch an intent. Returns:
 *   { dispatched_to, strategy: "live_match" | "spawned" | "no_executor", ticket_id?, dispatch_id, score?, breakdown?, ranked? }
 */
export async function dispatch({ intent, context, prefer, spawnedBy = "wikichat-service" }) {
  const dispatchId = randomUUID().slice(0, 8);
  const startedAt = new Date().toISOString();

  const { best, ranked } = _pickAgent(intent, prefer);

  let result;
  if (best && best.score >= 0.15) {
    // Route via DM (messagerie path)
    if (_ctx.sendDM) {
      _ctx.sendDM({
        to: best.agent.name,
        content: `🎯 [DISPATCH ${dispatchId}] ${intent}${context ? "\n\nContext: " + JSON.stringify(context) : ""}`,
      });
    }
    result = {
      dispatch_id: dispatchId,
      strategy: "live_match",
      dispatched_to: best.agent.name,
      score: best.score,
      breakdown: best.breakdown,
      ranked: ranked.slice(0, 5).map(c => ({ name: c.agent.name, score: c.score })),
    };
  } else {
    // Spawn ad-hoc headless
    if (_ctx.spawn) {
      const spawnRes = await _ctx.spawn({
        name: `Dispatcher-${dispatchId}`,
        role: "ad-hoc",
        mode: "headless",
        task: `Mission dispatchée: ${intent}${context ? "\n\nContext: " + JSON.stringify(context) : ""}\n\nFais la mission, share_artifact, termine.`,
        spawnedBy,
      });
      result = {
        dispatch_id: dispatchId,
        strategy: spawnRes?.success ? "spawned" : "no_executor",
        dispatched_to: spawnRes?.success ? `Dispatcher-${dispatchId}` : null,
        ticket_id: spawnRes?.ticketId || null,
        ranked: ranked.slice(0, 5).map(c => ({ name: c.agent.name, score: c.score })),
        spawn_error: spawnRes?.error,
      };
    } else {
      result = {
        dispatch_id: dispatchId,
        strategy: "no_executor",
        dispatched_to: null,
        ranked: ranked.slice(0, 5).map(c => ({ name: c.agent.name, score: c.score })),
        error: "No spawn handler configured",
      };
    }
  }

  // Append to log
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, JSON.stringify({ ...result, intent, context, prefer, startedAt }) + "\n");
  } catch { /* */ }

  return result;
}

/**
 * Record the outcome of a dispatched task to update the agent's track record.
 * Called externally when an agent reports completion (success/failure).
 */
export function recordOutcome({ agentName, capabilities, success }) {
  if (!agentName || !Array.isArray(capabilities)) return;
  let agentCaps = _record.get(agentName);
  if (!agentCaps) { agentCaps = new Map(); _record.set(agentName, agentCaps); }
  for (const cap of capabilities) {
    const key = String(cap).toLowerCase();
    const stats = agentCaps.get(key) || { ok: 0, fail: 0, lastUsed: null };
    if (success) stats.ok++; else stats.fail++;
    stats.lastUsed = new Date().toISOString();
    agentCaps.set(key, stats);
  }
  _saveDebounced();
}

/**
 * Read the most recent N dispatch log entries.
 */
export function readDispatchLog(limit = 20) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function getRecord() {
  const obj = {};
  for (const [agent, caps] of _record) obj[agent] = Object.fromEntries(caps);
  return obj;
}
