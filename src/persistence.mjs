/**
 * persistence.mjs — File I/O with atomic writes.
 * Inspired by pixel-agents' layoutPersistence: tmp-file + rename to prevent corruption.
 */

import fs from "fs";
import path from "path";
import { state } from "./state.mjs";
import { getSessionName } from "./state.mjs";

export const SESSION_STORE = path.join(process.cwd(), "sessions");
export const PROJECT_STORE = path.join(process.cwd(), "projects");
export const SPAWN_REGISTRY = path.join(process.cwd(), "spawn_registry.json");
export const AGENTS_DIR = path.join(process.cwd(), "agents");
export const CHANNELS_FILE = path.join(process.cwd(), ".wikichat", "channels.json");
export const MESSAGES_FILE = path.join(process.cwd(), ".wikichat", "messages.json");

// Ensure dirs exist
for (const dir of [SESSION_STORE, PROJECT_STORE, AGENTS_DIR, path.join(process.cwd(), ".wikichat")]) {
  fs.mkdirSync(dir, { recursive: true });
}

// ── Channel persistence ──────────────────────────────────────────────────────

export function saveChannels() {
  const channels = [...state.channels.entries()].map(([name, ch]) => ({
    name, description: ch.description, createdBy: ch.createdBy,
    isSystem: ch.isSystem || false,
  }));
  try { writeAtomicJSON(CHANNELS_FILE, channels); } catch { /* non-blocking */ }
}

export function loadChannels() {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) return;
    const channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, "utf8"));
    for (const ch of channels) {
      if (!state.channels.has(ch.name)) {
        state.channels.set(ch.name, {
          name: ch.name, description: ch.description,
          createdBy: ch.createdBy || "system",
          createdAt: new Date(), isSystem: ch.isSystem || false,
        });
      }
    }
  } catch { /* non-blocking */ }
}

// ── Message persistence (last N messages) ────────────────────────────────────

const PERSIST_MSG_COUNT = 200;
let _msgSaveTimer = null;

function _flushMessages() {
  _msgSaveTimer = null;
  try {
    const msgs = state.messages.slice(-PERSIST_MSG_COUNT).map(m => ({
      id: m.id, from: m.from, fromName: m.fromName,
      channel: m.channel, content: m.content,
      type: m.type, timestamp: m.timestamp,
    }));
    writeAtomicJSON(MESSAGES_FILE, msgs);
  } catch { /* non-blocking */ }
}

export function saveMessagesDebounced() {
  if (_msgSaveTimer) return;
  _msgSaveTimer = setTimeout(_flushMessages, 5000);
}
// Expose flush for graceful shutdown
saveMessagesDebounced.flush = () => {
  if (_msgSaveTimer) { clearTimeout(_msgSaveTimer); }
  _flushMessages();
};

export function loadMessages() {
  try {
    if (!fs.existsSync(MESSAGES_FILE)) return;
    const msgs = JSON.parse(fs.readFileSync(MESSAGES_FILE, "utf8"));
    // Only load if state is empty (fresh boot)
    if (state.messages.length === 0) {
      for (const m of msgs) {
        state.messages.push({ ...m, timestamp: new Date(m.timestamp) });
      }
    }
  } catch { /* non-blocking */ }
}

// ── Atomic write (like pixel-agents: write .tmp then rename) ──────────────────

export function writeAtomic(filePath, content) {
  const tmp = filePath + ".tmp";
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function writeAtomicJSON(filePath, obj) {
  writeAtomic(filePath, JSON.stringify(obj, null, 2));
}

// ── Agent file helpers ────────────────────────────────────────────────────────

export function getAgentStoragePath(sessionId) {
  const session = state.sessions.get(sessionId);
  if (session?.storage_path) return session.storage_path;
  const name = getSessionName(sessionId);
  const reg = loadSpawnRegistry();
  return reg.find(e => e.name === name)?.storage_path ?? null;
}

export function writeAgentFile(storagePath, subdir, filename, content, append = false) {
  if (!storagePath) return;
  try {
    const dir = subdir ? path.join(storagePath, subdir) : storagePath;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, filename);
    if (append) {
      fs.appendFileSync(file, content, "utf8");
    } else {
      writeAtomic(file, content);
    }
  } catch { /* non-blocking */ }
}

// ── Session snapshots ─────────────────────────────────────────────────────────

export function saveSnapshot(session) {
  if (!session.name || session.name.startsWith("session-")) return;
  const involved = state.messages.filter(m =>
    m.from === session.sessionId ||
    (m.isDM && state.channels.get(m.channel)?.participants?.includes(session.sessionId))
  ).slice(-30);
  const interlocutors = [...new Set(
    involved.map(m => m.fromName).filter(n => n !== session.name && !n.includes("Système"))
  )];
  const snapshot = {
    name: session.name, role: session.role, savedAt: new Date().toISOString(),
    status: session.status, skills: session.skills || [],
    current_task: session.current_task, current_project: session.current_project,
    availability: session.availability,
    last_message_id: involved.at(-1)?.id ?? null,
    last_interlocutors: interlocutors,
    recent_messages: involved.map(m => ({
      id: m.id.slice(0, 8), from: m.fromName,
      channel: m.isDM ? "DM" : m.channel,
      content: m.content.slice(0, 200), timestamp: m.timestamp,
    })),
  };
  try {
    writeAtomicJSON(path.join(SESSION_STORE, `${session.name}.json`), snapshot);
  } catch { /* ignore */ }
}

export function loadSnapshot(name) {
  const file = path.join(SESSION_STORE, `${name}.json`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// ── Projects ──────────────────────────────────────────────────────────────────

export function saveProject(project) {
  const data = { ...project, tasks: Object.fromEntries(project.tasks) };
  writeAtomicJSON(path.join(PROJECT_STORE, `${project.name}.json`), data);
}

export function loadProjects() {
  try {
    for (const f of fs.readdirSync(PROJECT_STORE).filter(f => f.endsWith(".json"))) {
      const data = JSON.parse(fs.readFileSync(path.join(PROJECT_STORE, f), "utf8"));
      data.tasks = new Map(Object.entries(data.tasks || {}));
      state.projects.set(data.name, data);
    }
  } catch { /* ignore */ }
}

// ── Spawn registry ────────────────────────────────────────────────────────────

// Cached spawn registry — avoid disk I/O on every spawn
let _spawnCache = null;
let _spawnDirty = false;
let _spawnFlushTimer = null;

export function loadSpawnRegistry() {
  if (_spawnCache) return _spawnCache;
  try {
    _spawnCache = fs.existsSync(SPAWN_REGISTRY)
      ? JSON.parse(fs.readFileSync(SPAWN_REGISTRY, "utf8"))
      : [];
  } catch { _spawnCache = []; }
  return _spawnCache;
}

export function upsertSpawnRegistry(entry) {
  const reg = loadSpawnRegistry();
  const idx = reg.findIndex(e => e.name === entry.name);
  if (idx >= 0) reg[idx] = { ...reg[idx], ...entry }; else reg.push(entry);
  _spawnDirty = true;
  // Debounced write — max once per 2 seconds
  if (!_spawnFlushTimer) {
    _spawnFlushTimer = setTimeout(() => {
      _spawnFlushTimer = null;
      if (_spawnDirty) {
        _spawnDirty = false;
        try { writeAtomicJSON(SPAWN_REGISTRY, _spawnCache); } catch { /* */ }
      }
    }, 2000);
  }
}

export function flushSpawnRegistry() {
  if (_spawnFlushTimer) clearTimeout(_spawnFlushTimer);
  _spawnFlushTimer = null;
  if (_spawnDirty && _spawnCache) {
    _spawnDirty = false;
    try { writeAtomicJSON(SPAWN_REGISTRY, _spawnCache); } catch { /* */ }
  }
}
