/**
 * registry.mjs — Manages ~/.wikichat/registry.json
 * The canonical list of discovered Claude projects on this machine.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { writeAtomicJSON } from "./persistence.mjs";

export const WIKICHAT_HOME = path.join(os.homedir(), ".wikichat");
export const REGISTRY_PATH = path.join(WIKICHAT_HOME, "registry.json");
export const CONFIG_PATH = path.join(WIKICHAT_HOME, "config.json");

// Default config
const DEFAULT_CONFIG = {
  roots: ["C:\\Users\\" + os.userInfo().username, os.homedir()],
  maxDepth: 6,
  excludeDirs: ["node_modules", ".git", "AppData", "Windows"],
  autoScan: false,
  lastScan: null,
};

// Ensure required directories exist on import
for (const dir of [
  WIKICHAT_HOME,
  path.join(WIKICHAT_HOME, "projects"),
]) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch { /* ignore */ }
}

/**
 * Lookup a project's filesystem path by name (case-insensitive). Used by the
 * project-state distribution model : content lives in <path>/.wikichat/, the
 * registry is just the index of pointers.
 *
 * Returns null if the name doesn't match any registered project (e.g. project
 * declared via declare_project without a real repo on disk).
 */
export function getProjectPath(projectName) {
  if (!projectName) return null;
  const reg = loadRegistry();
  const lower = projectName.toLowerCase();
  for (const p of reg.projects) {
    if (!p.path) continue;
    if ((p.name && p.name.toLowerCase() === lower) || (p.slug && p.slug.toLowerCase() === lower)) {
      return p.path;
    }
  }
  return null;
}

/**
 * Load registry from disk. Returns { projects: [], lastScan: null } if not found.
 */
export function loadRegistry() {
  try {
    if (fs.existsSync(REGISTRY_PATH)) {
      const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
      return {
        projects: Array.isArray(data.projects) ? data.projects : [],
        lastScan: data.lastScan ?? null,
      };
    }
  } catch (err) {
    console.error("[Registry] Failed to load registry:", err.message);
  }
  return { projects: [], lastScan: null };
}

/**
 * Save registry to disk atomically.
 */
export function saveRegistry(registry) {
  try {
    writeAtomicJSON(REGISTRY_PATH, registry);
  } catch (err) {
    console.error("[Registry] Failed to save registry:", err.message);
    throw err;
  }
}

/**
 * Load config from disk. Returns DEFAULT_CONFIG if not found.
 */
export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (err) {
    console.error("[Registry] Failed to load config:", err.message);
  }
  return { ...DEFAULT_CONFIG };
}

/**
 * Save config to disk.
 */
export function saveConfig(config) {
  try {
    writeAtomicJSON(CONFIG_PATH, config);
  } catch (err) {
    console.error("[Registry] Failed to save config:", err.message);
    throw err;
  }
}

/**
 * Merge newly scanned projects into existing registry.
 * - New projects: add with status "discovered"
 * - Existing projects: update markers/stack/description, keep custom fields
 * - Projects no longer found: mark as status "missing" (don't delete)
 * Returns updated projects array.
 */
export function mergeProjects(existing, scanned) {
  const existingByPath = new Map(existing.map(p => [p.path, p]));
  const scannedPaths = new Set(scanned.map(p => p.path));
  const result = [];

  // Process scanned projects
  for (const proj of scanned) {
    const old = existingByPath.get(proj.path);
    if (old) {
      // Update volatile fields, preserve user-set fields
      result.push({
        ...old,
        markers: proj.markers,
        stack: proj.stack || old.stack || [],
        description: proj.description || old.description || "",
        name: proj.name || old.name,
        slug: old.slug || proj.slug, // keep existing slug to avoid breaking references
        detectedAt: old.detectedAt || proj.detectedAt,
        updatedAt: new Date().toISOString(),
        status: old.status === "missing" ? "discovered" : (old.status || "discovered"),
      });
    } else {
      // Brand new project
      result.push({
        ...proj,
        status: "discovered",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // Mark previously found projects that are no longer on disk as "missing"
  for (const old of existing) {
    if (!scannedPaths.has(old.path)) {
      result.push({
        ...old,
        status: "missing",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return result;
}
