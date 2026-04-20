/**
 * notifier.mjs — Long-polling waiter/notification system.
 * Improved over v1: per-session channel filters registered at wait-time.
 */

import { state } from "./state.mjs";

/**
 * Wake all waiters that should receive a message on the given channel.
 * Excludes the sender session to avoid self-notification.
 */
export function notifyWaiters(channel, excludeSessionId = null) {
  for (const [sid, waiters] of state.waiters) {
    if (sid === excludeSessionId) continue;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      // Check if this waiter is interested in this channel
      if (w.channel === "__all__" || w.channel === channel || channel === "__broadcast__") {
        waiters.splice(i, 1);
        w.resolve(true);
      }
    }
  }
}

/**
 * Register a long-poll waiter. Returns a Promise that resolves when:
 * - A matching message arrives (resolve = true)
 * - The timeout fires (resolve = false)
 *
 * @param {string} sessionId
 * @param {string} channel  - "__all__" or specific channel name
 * @param {number} timeoutMs
 */
export function registerWaiter(sessionId, channel, timeoutMs) {
  return new Promise((resolve) => {
    const entry = { channel, resolve: () => resolve(true) };

    if (!state.waiters.has(sessionId)) state.waiters.set(sessionId, []);
    state.waiters.get(sessionId).push(entry);

    const timer = setTimeout(() => {
      const arr = state.waiters.get(sessionId);
      if (arr) {
        const idx = arr.indexOf(entry);
        if (idx >= 0) arr.splice(idx, 1);
      }
      resolve(false);
    }, timeoutMs);

    // Allow timer to be GC'd without blocking process exit
    if (timer.unref) timer.unref();
  });
}

/** Remove all waiters for a disconnected session */
export function clearWaiters(sessionId) {
  state.waiters.delete(sessionId);
}
