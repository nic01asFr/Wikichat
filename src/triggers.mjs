/**
 * triggers.mjs — Declarative event-driven trigger engine.
 *
 * A trigger pairs an event source (cron, lifecycle, channel_match, …) with
 * an action (typically spawn_session). Triggers are persisted to
 * ~/.wikichat/triggers.json and survive restarts.
 *
 * Supported types in this initial cut:
 *   - cron       : node-cron schedule
 *   - lifecycle  : fires once at server boot if condition met
 *
 * Future types (file_watch, git_hook, channel_match, mention, threshold,
 * webhook) hook into the same dispatch path — see fireTrigger().
 *
 * Safety contract:
 *   - cooldown_s prevents rapid re-firing
 *   - max_per_day caps fires within 24h window
 *   - pre-flight checkBudget() refuses spawns when over WIKICHAT_MAX_SESSIONS
 *   - idempotent spawn: refuses if a session with the same name is alive
 *   - WIKICHAT_TRIGGERS_DISABLED=1 disables the whole engine
 */

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import cron from "node-cron";
import { writeAtomicJSON } from "./persistence.mjs";
import { state, sysMsg } from "./state.mjs";

const TRIGGERS_FILE = path.join(os.homedir(), ".wikichat", "triggers.json");

/** In-memory registry of triggers. */
const _triggers = new Map();
/** node-cron task handles, keyed by trigger id. */
const _cronTasks = new Map();
/** Optional spawn function injected from outside (avoids circular import). */
let _spawnFn = null;
/** Optional budget checker. */
let _budgetCheckFn = null;
/** Optional routine runner — set by configureTriggers if available. */
let _routineFn = null;

let _saveTimer = null;
function _saveDebounced() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(_flush, 1000);
}
function _flush() {
  _saveTimer = null;
  try {
    const obj = Object.fromEntries(_triggers);
    writeAtomicJSON(TRIGGERS_FILE, obj);
  } catch { /* non-blocking */ }
}

function _isDisabled() {
  return process.env.WIKICHAT_TRIGGERS_DISABLED === "1";
}

/**
 * Wire the engine to the rest of the server. Called once at boot.
 *   spawnFn: (params) => Promise<{ success, ... }>  — handles spawn_session action
 *   budgetCheckFn: () => null | { error, current, max }
 */
export function configureTriggers({ spawnFn, budgetCheckFn, routineFn }) {
  _spawnFn = spawnFn || null;
  _budgetCheckFn = budgetCheckFn || null;
  _routineFn = routineFn || null;
}

export function loadTriggers() {
  try {
    if (!fs.existsSync(TRIGGERS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(TRIGGERS_FILE, "utf8"));
    for (const [id, t] of Object.entries(raw)) _triggers.set(id, t);
  } catch { /* ignore */ }
}

export function listTriggers() {
  return [..._triggers.values()];
}

export function getTrigger(id) {
  return _triggers.get(id) || null;
}

/**
 * Register a new trigger (or replace an existing one with the same id).
 * Returns the stored trigger object.
 */
export function registerTrigger(spec) {
  const id = spec.id || randomUUID().slice(0, 8);
  const trigger = {
    id,
    type: spec.type,
    config: spec.config || {},
    action: spec.action,
    enabled: spec.enabled !== false,
    cooldown_s: spec.cooldown_s ?? 30,
    max_per_day: spec.max_per_day ?? 100,
    last_fired: null,
    fire_count: 0,
    created_at: new Date().toISOString(),
    description: spec.description || "",
  };
  // If replacing an existing trigger, preserve fire stats
  const existing = _triggers.get(id);
  if (existing) {
    trigger.last_fired = existing.last_fired;
    trigger.fire_count = existing.fire_count;
    trigger.created_at = existing.created_at;
    _stopCron(id);
  }
  _triggers.set(id, trigger);
  if (trigger.enabled) _activate(trigger);
  _saveDebounced();
  return trigger;
}

export function deleteTrigger(id) {
  if (!_triggers.has(id)) return false;
  _stopCron(id);
  _triggers.delete(id);
  _saveDebounced();
  return true;
}

export function setEnabled(id, enabled) {
  const t = _triggers.get(id);
  if (!t) return false;
  t.enabled = !!enabled;
  if (t.enabled) _activate(t); else _stopCron(id);
  _saveDebounced();
  return true;
}

/** Manually fire a trigger (bypasses cooldown only if force=true). */
export async function fireTrigger(id, { force = false, source = "manual" } = {}) {
  const t = _triggers.get(id);
  if (!t) return { ok: false, reason: "not_found" };
  if (!force && _isDisabled()) return { ok: false, reason: "engine_disabled" };
  if (!force && !_quotaOk(t)) return { ok: false, reason: "quota" };
  if (!force && _onCooldown(t)) return { ok: false, reason: "cooldown" };

  const result = await _runAction(t, source);
  t.last_fired = new Date().toISOString();
  t.fire_count = (t.fire_count || 0) + 1;
  _saveDebounced();
  return { ok: result.ok, reason: result.reason, detail: result.detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function _activate(t) {
  if (t.type === "cron") _startCron(t);
  // lifecycle triggers fire from runLifecycleTriggers() at boot
}

function _startCron(t) {
  const schedule = t.config?.schedule;
  if (!schedule || !cron.validate(schedule)) return;
  try {
    const task = cron.schedule(schedule, () => {
      fireTrigger(t.id, { source: "cron" }).catch(() => {});
    }, { timezone: t.config?.tz || undefined });
    _cronTasks.set(t.id, task);
  } catch { /* invalid schedule, silently skip */ }
}

function _stopCron(id) {
  const task = _cronTasks.get(id);
  if (task) {
    try { task.stop(); } catch { /* */ }
    _cronTasks.delete(id);
  }
}

function _onCooldown(t) {
  if (!t.last_fired) return false;
  const elapsed = (Date.now() - new Date(t.last_fired).getTime()) / 1000;
  return elapsed < (t.cooldown_s || 0);
}

function _quotaOk(t) {
  if (!t.last_fired) return true;
  const cap = t.max_per_day ?? 100;
  if (t.fire_count >= cap) {
    // Reset rolling window once 24h have passed since first fire of the day
    const dayMs = 24 * 60 * 60 * 1000;
    if (Date.now() - new Date(t.last_fired).getTime() > dayMs) {
      t.fire_count = 0;
      return true;
    }
    return false;
  }
  return true;
}

async function _runAction(t, source) {
  const action = t.action || {};
  if (action.type === "spawn_session") {
    return _runSpawnAction(t, action.params || {}, source);
  }
  if (action.type === "broadcast") {
    sysMsg(action.params?.channel || "coordination",
      `🔔 [trigger ${t.id}] ${action.params?.content || ""}`);
    return { ok: true };
  }
  if (action.type === "run_routine") {
    if (!_routineFn) return { ok: false, reason: "routine_runner_not_configured" };
    try {
      const res = await _routineFn(action.params?.id, action.params?.params || {}, {
        spawnedBy: `trigger:${t.id}:${source}`,
      });
      return { ok: !res.error && res.status !== "failed", detail: res };
    } catch (err) {
      return { ok: false, reason: "routine_threw", detail: err.message };
    }
  }
  return { ok: false, reason: `unknown_action:${action.type}` };
}

async function _runSpawnAction(t, params, source) {
  if (!_spawnFn) return { ok: false, reason: "spawn_fn_not_configured" };

  // Pre-flight: budget
  if (_budgetCheckFn) {
    const budget = _budgetCheckFn();
    if (budget) return { ok: false, reason: "budget", detail: budget };
  }

  // Pre-flight: idempotence (don't re-spawn if name already alive)
  if (params.name) {
    const alive = [...state.sessions.values()].some(s => s.name === params.name);
    if (alive) return { ok: false, reason: "already_running" };
  }

  try {
    const result = await _spawnFn({ ...params, spawnedBy: `trigger:${t.id}:${source}` });
    sysMsg("coordination",
      `🔔 [trigger ${t.id}] ${result?.success ? "✅" : "❌"} spawn "${params.name}" (${params.mode || "headless"})`);
    return { ok: !!result?.success, detail: result };
  } catch (err) {
    return { ok: false, reason: "spawn_threw", detail: err.message };
  }
}

/**
 * Run all `lifecycle` triggers at boot.
 * Lifecycle triggers fire once during startup if their condition is met.
 * Condition (`config.condition`) currently supports:
 *   - "always"
 *   - "if_no_session_named:<name>"  → fires if no live session with that name
 */
export async function runLifecycleTriggers() {
  if (_isDisabled()) return;
  for (const t of _triggers.values()) {
    if (t.type !== "lifecycle" || !t.enabled) continue;
    if (!_lifecycleConditionMet(t)) continue;
    fireTrigger(t.id, { source: "lifecycle" }).catch(() => {});
  }
}

function _lifecycleConditionMet(t) {
  const cond = t.config?.condition || "always";
  if (cond === "always") return true;
  if (cond.startsWith("if_no_session_named:")) {
    const name = cond.slice("if_no_session_named:".length);
    const alive = [...state.sessions.values()].some(s => s.name === name);
    return !alive;
  }
  return false;
}

/** Stop all active cron tasks. Called at graceful shutdown. */
export function shutdownTriggers() {
  for (const id of [..._cronTasks.keys()]) _stopCron(id);
  _flush();
}
