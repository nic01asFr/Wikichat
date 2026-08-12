/**
 * identity.mjs — Persistent agent identity keyed by display name.
 *
 * Two parts:
 *  1. Auto-restore: at register(name), pull skills/current_project/availability
 *     from the latest snapshot and merge into the session object.
 *  2. Memory store: free-form key/value memories per agent name, exposed via
 *     remember()/recall() tools. Persisted atomically.
 *
 * Identity is keyed by *name*, not session id, because the goal is continuity
 * across sessions/processes that re-register with the same display name.
 */

import fs from "fs";
import path from "path";
import { writeAtomicJSON, loadSnapshot } from "./persistence.mjs";

const MEMORIES_FILE = path.join(process.cwd(), ".wikichat", "memories.json");

/** Map<agentName, { [key]: { value, updatedAt } }> */
const _memories = new Map();
let _saveTimer = null;

function _flush() {
  _saveTimer = null;
  try {
    writeAtomicJSON(MEMORIES_FILE, Object.fromEntries(_memories));
  } catch { /* non-blocking */ }
}

function _saveDebounced() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(_flush, 2000);
}

export function loadMemories() {
  try {
    if (!fs.existsSync(MEMORIES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(MEMORIES_FILE, "utf8"));
    for (const [name, kv] of Object.entries(raw)) _memories.set(name, kv);
  } catch { /* ignore */ }
}

export function flushMemories() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _flush();
}

export function remember(name, key, value) {
  if (!name || !key) return false;
  const store = _memories.get(name) || {};
  store[key] = { value, updatedAt: new Date().toISOString() };
  _memories.set(name, store);
  _saveDebounced();
  return true;
}

export function recall(name, key) {
  const store = _memories.get(name);
  if (!store) return null;
  if (key) return store[key]?.value ?? null;
  return Object.fromEntries(Object.entries(store).map(([k, v]) => [k, v.value]));
}

/**
 * Noms d'agents ayant une identité mémorisée — la liste de ceux qu'on sait
 * réveiller. Exclut les sessions anonymes, qui n'ont pas d'identité durable.
 */
export function knownAgentNames() {
  return [..._memories.keys()].filter(n => n && !n.startsWith("session-"));
}

export function forgetKey(name, key) {
  const store = _memories.get(name);
  if (!store || !(key in store)) return false;
  delete store[key];
  if (Object.keys(store).length === 0) _memories.delete(name);
  _saveDebounced();
  return true;
}

/**
 * Restore identity into a session object at register().
 * Merges snapshot fields (skills, current_project, availability) when missing.
 * Returns a summary for the register response.
 */
export function restoreIdentity(session, name) {
  const snap = loadSnapshot(name);
  if (!snap) return { restored: false };

  const restored = [];
  if (snap.skills?.length && (!session.skills || session.skills.length === 0)) {
    session.skills = snap.skills;
    restored.push(`skills (${snap.skills.length})`);
  }
  if (snap.current_project && !session.current_project) {
    session.current_project = snap.current_project;
    restored.push(`projet "${snap.current_project}"`);
  }
  if (snap.availability && !session.availability) {
    session.availability = snap.availability;
  }

  const memCount = Object.keys(_memories.get(name) || {}).length;
  if (memCount > 0) restored.push(`${memCount} mémoire(s)`);

  return {
    restored: restored.length > 0,
    summary: restored.join(", "),
    snapshotAge: snap.savedAt,
    lastInterlocutors: snap.last_interlocutors || [],
  };
}
