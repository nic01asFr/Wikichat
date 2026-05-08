/**
 * file-hooks.mjs — Chokidar-based filesystem watchers for project queue/artifact pickup.
 *
 * Replaces (eventually) the 2-minute polling loops in server.mjs with near-instant
 * filesystem event detection. J1: skeleton + watchers + boot wiring. The existing
 * polls remain intact as fallback (removed in J2).
 *
 * Env guard: set WIKICHAT_FILEHOOKS_DISABLED=1 to disable entirely.
 */

import { watch } from "chokidar";
import path from "path";
import fs from "fs";
import { loadRegistry } from "./registry.mjs";
import { pickupQueue, readLocalArtifacts } from "./injector.mjs";
import { sysMsg } from "./state.mjs";

// Active watcher instances — one per project path
const watchers = new Map();

// Debounce map — key: absolute file path, value: timeout handle
const debounceMap = new Map();

const DEBOUNCE_MS = 200;

/**
 * Debounced handler: ensures a given callback is called at most once per
 * DEBOUNCE_MS for any specific file path.
 */
function debounced(filePath, fn) {
  const existing = debounceMap.get(filePath);
  if (existing) clearTimeout(existing);
  debounceMap.set(filePath, setTimeout(() => {
    debounceMap.delete(filePath);
    fn();
  }, DEBOUNCE_MS));
}

/**
 * Handle a new file appearing in a project's .wikichat/queue/ directory.
 */
async function onQueueFile(project, filePath) {
  try {
    const items = await pickupQueue(project);
    if (items.length > 0) {
      console.log(`[file-hooks] Picked up ${items.length} queue item(s) from ${project.slug}`);
      for (const item of items) {
        sysMsg("coordination", `[${project.slug}] ${item.agent}: ${item.type}${item.data?.message ? " -- " + item.data.message : ""}`);
      }
    }
  } catch (err) {
    console.warn(`[file-hooks] Queue pickup error for ${project.slug}:`, err.message);
  }
}

/**
 * Handle a new file appearing in a project's .wikichat/artifacts/ directory.
 */
async function onArtifactFile(project, filePath) {
  try {
    const artifacts = await readLocalArtifacts(project);
    if (artifacts.length > 0) {
      console.log(`[file-hooks] Recovered ${artifacts.length} artifact(s) from ${project.slug}`);
      for (const art of artifacts) {
        sysMsg("coordination", `[${project.slug}] ${art.agent} -> "${art.title}" (file-hooks pickup)`);
      }
    }
  } catch (err) {
    console.warn(`[file-hooks] Artifact recovery error for ${project.slug}:`, err.message);
  }
}

/**
 * Start filesystem watchers for all registered projects.
 * Watches .wikichat/queue/ and .wikichat/artifacts/ for new files.
 */
export function startFileHooks() {
  if (process.env.WIKICHAT_FILEHOOKS_DISABLED === "1") return;

  const registry = loadRegistry();
  const projects = (registry.projects || []).filter(p => p.status !== "missing" && p.path);

  let watchedCount = 0;

  for (const project of projects) {
    const projectPath = path.resolve(project.path);
    if (!fs.existsSync(projectPath)) continue;

    const queueDir = path.join(projectPath, ".wikichat", "queue");
    const artifactsDir = path.join(projectPath, ".wikichat", "artifacts");

    // Build list of paths to watch (only those that exist or whose parent exists)
    const watchPaths = [];
    if (fs.existsSync(queueDir)) watchPaths.push(queueDir);
    if (fs.existsSync(artifactsDir)) watchPaths.push(artifactsDir);

    // Skip projects with no .wikichat dirs yet — the poll will handle them
    if (watchPaths.length === 0) continue;

    try {
      const watcher = watch(watchPaths, {
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
      });

      watcher.on("add", (filePath) => {
        const normalized = filePath.replace(/\\/g, "/");
        if (normalized.includes("/.wikichat/queue/")) {
          debounced(filePath, () => onQueueFile(project, filePath));
        } else if (normalized.includes("/.wikichat/artifacts/")) {
          debounced(filePath, () => onArtifactFile(project, filePath));
        }
      });

      watcher.on("error", (err) => {
        console.warn(`[file-hooks] Watcher error for ${project.slug}:`, err.message);
      });

      watchers.set(project.slug, watcher);
      watchedCount++;
    } catch (err) {
      console.warn(`[file-hooks] Failed to watch ${project.slug}:`, err.message);
    }
  }

  if (watchedCount > 0) {
    console.log(`[file-hooks] watching ${watchedCount} projects`);
  }
}

/**
 * Stop all active file watchers. Called during graceful shutdown.
 */
export async function stopFileHooks() {
  const closePromises = [];
  for (const [slug, watcher] of watchers) {
    closePromises.push(
      watcher.close().catch((err) => {
        console.warn(`[file-hooks] Error closing watcher for ${slug}:`, err.message);
      })
    );
  }
  await Promise.all(closePromises);
  watchers.clear();

  // Clear any pending debounce timers
  for (const [, handle] of debounceMap) {
    clearTimeout(handle);
  }
  debounceMap.clear();
}
