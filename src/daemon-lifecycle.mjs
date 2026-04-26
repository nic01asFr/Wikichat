/**
 * daemon-lifecycle.mjs — Reconciles spawn_registry.json with the OS process state.
 *
 * Two responsibilities:
 *
 *  1. reconcileDaemonsAtBoot()
 *     For each entry in the registry marked `status: "running"`, check whether
 *     the recorded PID still exists. If not, mark it `ended` so the next
 *     lifecycle trigger cycle can spawn a fresh one cleanly. Without this,
 *     a stale registry would prevent re-spawn of a dead daemon (because the
 *     `if_no_session_named:X` lifecycle condition checks live MCP sessions,
 *     not the registry — but stale entries pollute observability).
 *
 *  2. shutdownDaemons()
 *     Called by graceful shutdown. Kills every daemon process this server
 *     spawned and is still tracked as `running`. Prevents orphan processes
 *     on Windows where `detached: true` would have left them alive after a
 *     parent kill. Combined with `detached: false` for daemons on Windows,
 *     this gives a fully reaped tree at shutdown.
 *
 * Both functions are intentionally tolerant of missing/dead PIDs and
 * cross-platform (uses process.kill(0) probe).
 */

import { loadSpawnRegistry, upsertSpawnRegistry } from "./persistence.mjs";

/** Returns true if the given PID currently exists. */
function pidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0); // signal 0 = probe, no kill
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive
    return err.code === "EPERM";
  }
}

/**
 * Mark every `running` daemon whose PID no longer exists as `ended`.
 * Run this at server boot. Returns the number of stale entries cleaned.
 */
export function reconcileDaemonsAtBoot() {
  const reg = loadSpawnRegistry();
  let cleaned = 0;
  for (const entry of reg) {
    if (entry.status === "running" && !pidAlive(entry.pid)) {
      upsertSpawnRegistry({
        ...entry,
        status: "ended",
        ended_at: new Date().toISOString(),
        ended_reason: "pid_not_alive_at_boot",
      });
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[Lifecycle] Reconciled ${cleaned} stale daemon(s) in spawn registry`);
  }
  return { cleaned };
}

/**
 * Kill every running daemon process tracked in the registry.
 * Called from graceful shutdown. Best-effort: skips PIDs already gone.
 */
export function shutdownDaemons() {
  const reg = loadSpawnRegistry();
  let killed = 0, skipped = 0;
  for (const entry of reg) {
    if (entry.status !== "running" || !entry.pid) { skipped++; continue; }
    if (!pidAlive(entry.pid)) {
      upsertSpawnRegistry({
        ...entry,
        status: "ended",
        ended_at: new Date().toISOString(),
        ended_reason: "already_dead_at_shutdown",
      });
      skipped++;
      continue;
    }
    try {
      process.kill(entry.pid, "SIGTERM");
      // On Windows, SIGTERM is treated as kill — children may still need cleanup
      // but we don't have a process tree handle here. detached:false at spawn
      // time should cover that case for new daemons going forward.
      upsertSpawnRegistry({
        ...entry,
        status: "ended",
        ended_at: new Date().toISOString(),
        ended_reason: "killed_at_shutdown",
      });
      killed++;
    } catch {
      skipped++;
    }
  }
  if (killed > 0 || skipped > 0) {
    console.log(`[Lifecycle] Shutdown daemons — killed ${killed}, skipped ${skipped}`);
  }
  return { killed, skipped };
}

/**
 * Standalone cleanup: kill all running daemons AND mark stale entries.
 * Usable from an admin REST endpoint or maintenance script.
 */
export function fullCleanup() {
  const reconciled = reconcileDaemonsAtBoot();
  const shutdown = shutdownDaemons();
  return {
    reconciled: reconciled.cleaned,
    killed: shutdown.killed,
    skipped: shutdown.skipped,
  };
}
