/**
 * dormant.mjs — Wake/sleep gating for the autonomous team.
 *
 * Triggers (cron + lifecycle) only fire when WikiChat is "active". The service
 * is active when BOTH conditions hold :
 *   1. The principal agent (env WIKICHAT_PRINCIPAL_AGENT, default "Claude-Code")
 *      is currently registered with the server, OR principal-gate is disabled.
 *   2. The registry contains at least one project, OR registry-gate is disabled.
 *
 * Otherwise we're DORMANT : crons stay scheduled by node-cron but the dispatch
 * is short-circuited; lifecycle triggers don't fire on register events; resident
 * daemons get killed after a 5-minute grace period when the principal goes away.
 *
 * Resource MCP wikichat://principal exposes the current state.
 * Tools `set_active(true/false)` allow manual override (admin only).
 *
 * Env :
 *   WIKICHAT_DORMANT_DISABLED=1     → always active (legacy behavior)
 *   WIKICHAT_PRINCIPAL_GATE         → "any-named" (default) | "strict" | "0" (off).
 *                                     any-named : tout session non-anonyme registered active la team.
 *                                     strict    : seul le nom WIKICHAT_PRINCIPAL_AGENT compte (legacy).
 *                                     0         : pas de gate principal (registry seul décide).
 *   WIKICHAT_REGISTRY_GATE=0        → don't require ≥1 project
 *   WIKICHAT_PRINCIPAL_AGENT        → name of the strict-mode principal (default "Claude-Code")
 */

import { state } from "./state.mjs";

const PRINCIPAL_NAME = process.env.WIKICHAT_PRINCIPAL_AGENT || "Claude-Code";
// Mode "any-named" (défaut depuis 2026-05) : tout session non-anonyme registered
// fait office de principal. Le mode strict (nom exact) reste accessible via
// WIKICHAT_PRINCIPAL_GATE=strict. "0" désactive complètement.
const PRINCIPAL_GATE_MODE = process.env.WIKICHAT_PRINCIPAL_GATE === "strict"
  ? "strict"
  : (process.env.WIKICHAT_PRINCIPAL_GATE === "0" ? "off" : "any-named");
const REGISTRY_GATE = process.env.WIKICHAT_REGISTRY_GATE !== "0";
const DORMANT_DISABLED = process.env.WIKICHAT_DORMANT_DISABLED === "1";
const GRACE_PERIOD_MS = parseInt(process.env.WIKICHAT_DORMANT_GRACE_MS || `${5 * 60 * 1000}`);

let _manualOverride = null; // null = auto, true/false = forced
let _wasActive = false;
let _principalLastSeen = null;
let _onWake = [];
let _onSleep = [];

export function principalIsLive() {
  for (const s of state.sessions.values()) {
    // Skip anonymous sessions (the IDE's auto-reconnects).
    if (!s.name || s.name.startsWith("session-")) continue;
    // Strict mode : exact name match (legacy behavior).
    if (PRINCIPAL_GATE_MODE === "strict") {
      if (s.name === PRINCIPAL_NAME) { _principalLastSeen = Date.now(); return true; }
      continue;
    }
    // any-named mode : any registered, non-anonymous session counts.
    _principalLastSeen = Date.now();
    return true;
  }
  return false;
}

export function registryHasProjects() {
  return (state.projects?.size ?? 0) > 0;
}

/** True if WikiChat is currently active (= triggers + crons should run). */
export function isActive() {
  if (DORMANT_DISABLED) return true;
  if (_manualOverride !== null) return _manualOverride;
  const principalGated = PRINCIPAL_GATE_MODE !== "off";
  const inGrace = !!_principalLastSeen && (Date.now() - _principalLastSeen) < GRACE_PERIOD_MS;
  const principalOk = !principalGated || principalIsLive() || inGrace;
  const registryOk = !REGISTRY_GATE || registryHasProjects();
  return Boolean(principalOk && registryOk);
}

/** Detail of why we're active or dormant — used by the resource. */
export function status() {
  const principalLive = principalIsLive();
  const inGrace = !principalLive && _principalLastSeen &&
    (Date.now() - _principalLastSeen) < GRACE_PERIOD_MS;
  return {
    active: isActive(),
    manualOverride: _manualOverride,
    principalName: PRINCIPAL_NAME,
    principalLive,
    inGracePeriod: !!inGrace,
    gracePeriodMs: GRACE_PERIOD_MS,
    secondsSincePrincipal: _principalLastSeen ? Math.round((Date.now() - _principalLastSeen) / 1000) : null,
    registryHasProjects: registryHasProjects(),
    gates: { principal: PRINCIPAL_GATE_MODE, registry: REGISTRY_GATE },
    dormantDisabled: DORMANT_DISABLED,
  };
}

/** Manual control: lock the state to active (true) or dormant (false). null = auto. */
export function setManualOverride(value) {
  _manualOverride = value;
  return status();
}

export function onWake(fn) { _onWake.push(fn); }
export function onSleep(fn) { _onSleep.push(fn); }

/** Periodic check : detect transitions and fire callbacks. */
export function startDormantWatch() {
  setInterval(() => {
    const active = isActive();
    if (active && !_wasActive) {
      _wasActive = true;
      console.log(`[Dormant] Wake — ${PRINCIPAL_NAME} present + registry ok`);
      for (const fn of _onWake) { try { fn(status()); } catch { /* */ } }
    } else if (!active && _wasActive) {
      _wasActive = false;
      console.log(`[Dormant] Sleep — principal=${principalIsLive() ? "live" : "absent"}, registry=${registryHasProjects() ? "ok" : "empty"}`);
      for (const fn of _onSleep) { try { fn(status()); } catch { /* */ } }
    }
  }, 30 * 1000);
  // Fire initial state
  setTimeout(() => {
    _wasActive = isActive();
    if (_wasActive) {
      for (const fn of _onWake) { try { fn(status()); } catch { /* */ } }
    }
  }, 2000);
}
