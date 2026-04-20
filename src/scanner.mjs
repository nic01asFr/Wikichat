/**
 * scanner.mjs — Filesystem scanner for Claude projects.
 * Walks directory trees to find directories containing Claude project markers.
 */

import fs from "fs";
import path from "path";
import os from "os";

const DEFAULT_ROOTS = ["C:\\Users", os.homedir()];
const MAX_DEPTH = 6;
const EXCLUDE_DIRS = new Set([
  "node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build",
  "target", ".cache", "coverage", ".next", ".nuxt", "out", "tmp", ".tmp",
  "AppData", "Windows", "Program Files", "Program Files (x86)", "$Recycle.Bin",
  "System Volume Information",
]);

const MARKERS = ["CLAUDE.md", "claude.md", ".claude", "claude.json", ".mcp.json"];

/**
 * Scan a root directory for Claude projects up to MAX_DEPTH.
 * Returns array of { path, markers[], slug, detectedAt }
 */
export async function scanForProjects(roots = DEFAULT_ROOTS, maxDepth = MAX_DEPTH) {
  const found = new Map(); // path → project entry (dedup by path)

  function walk(dirPath, depth) {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return; // permission denied or other error — skip silently
    }

    // Check if this directory is a Claude project
    const presentMarkers = [];
    for (const marker of MARKERS) {
      try {
        const markerPath = path.join(dirPath, marker);
        fs.accessSync(markerPath);
        presentMarkers.push(marker);
      } catch {
        // marker not present
      }
    }

    if (presentMarkers.length > 0 && !found.has(dirPath)) {
      found.set(dirPath, {
        path: dirPath,
        markers: presentMarkers,
        slug: pathToSlug(dirPath),
        name: path.basename(dirPath),
        detectedAt: new Date().toISOString(),
      });
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.isSymbolicLink()) continue;
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".claude") continue;

      walk(path.join(dirPath, entry.name), depth + 1);
    }
  }

  // Deduplicate roots before scanning
  const uniqueRoots = [...new Set(roots.map(r => path.resolve(r)))];

  for (const root of uniqueRoots) {
    try {
      fs.accessSync(root);
      walk(root, 0);
    } catch {
      // root doesn't exist or not accessible — skip
    }
  }

  // Sort by path for deterministic output
  const results = [...found.values()].sort((a, b) => a.path.localeCompare(b.path));

  // Enrich with stack and description asynchronously
  await Promise.all(results.map(async (proj) => {
    proj.stack = await detectStack(proj.path).catch(() => []);
    proj.description = await readClaudeMd(proj.path).catch(() => "");
  }));

  return results;
}

/**
 * Detect stack from a project directory.
 * Returns array of detected stack names.
 * Checks: package.json (dependencies), pyproject.toml, Cargo.toml, go.mod, requirements.txt
 */
export async function detectStack(projectPath) {
  const stacks = [];

  // Check package.json
  try {
    const pkgPath = path.join(projectPath, "package.json");
    const pkg = JSON.parse(await fs.promises.readFile(pkgPath, "utf8"));
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.peerDependencies,
    };
    stacks.push("node");
    if (deps.react || deps["react-dom"]) stacks.push("react");
    if (deps.next) stacks.push("nextjs");
    if (deps.vue) stacks.push("vue");
    if (deps.svelte) stacks.push("svelte");
    if (deps.express) stacks.push("express");
    if (deps.fastify) stacks.push("fastify");
    if (deps.typescript || pkg.devDependencies?.typescript) stacks.push("typescript");
    if (deps["@modelcontextprotocol/sdk"]) stacks.push("mcp");
  } catch {
    // no package.json or parse error
  }

  // Check pyproject.toml
  try {
    await fs.promises.access(path.join(projectPath, "pyproject.toml"));
    stacks.push("python");
    // Try to read for more info
    const content = await fs.promises.readFile(path.join(projectPath, "pyproject.toml"), "utf8");
    if (content.includes("fastapi")) stacks.push("fastapi");
    if (content.includes("django")) stacks.push("django");
    if (content.includes("flask")) stacks.push("flask");
  } catch {
    // try requirements.txt as fallback
    try {
      const req = await fs.promises.readFile(path.join(projectPath, "requirements.txt"), "utf8");
      stacks.push("python");
      if (req.toLowerCase().includes("fastapi")) stacks.push("fastapi");
      if (req.toLowerCase().includes("django")) stacks.push("django");
      if (req.toLowerCase().includes("flask")) stacks.push("flask");
    } catch { /* not python */ }
  }

  // Check Cargo.toml
  try {
    await fs.promises.access(path.join(projectPath, "Cargo.toml"));
    stacks.push("rust");
  } catch { /* not rust */ }

  // Check go.mod
  try {
    await fs.promises.access(path.join(projectPath, "go.mod"));
    stacks.push("go");
  } catch { /* not go */ }

  // Deduplicate while preserving order
  return [...new Set(stacks)];
}

/**
 * Read a CLAUDE.md file and extract a short description (first non-heading paragraph).
 */
export async function readClaudeMd(projectPath) {
  // Try both casings
  for (const filename of ["CLAUDE.md", "claude.md"]) {
    const filePath = path.join(projectPath, filename);
    try {
      const content = await fs.promises.readFile(filePath, "utf8");
      const lines = content.split("\n");

      // Find first non-empty, non-heading line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("#")) continue;
        if (trimmed.startsWith("```")) continue;
        // Return up to first 200 chars of first real paragraph
        return trimmed.slice(0, 200);
      }
      return "";
    } catch {
      // file not found or unreadable — try next
    }
  }
  return "";
}

/**
 * Build a URL-safe slug from a path.
 * e.g. "C:\Users\Omen\projects\my-app" => "my-app"
 * If a slug collision is possible, use last two path segments joined with "-"
 */
export function pathToSlug(projectPath) {
  const normalized = projectPath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);

  if (segments.length === 0) return "unknown";

  const last = segments[segments.length - 1];
  // Sanitize: lowercase, replace non-alphanumeric with hyphens
  const slug = last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  if (!slug) {
    // Fallback to last two segments
    const twoLast = segments.slice(-2).join("-");
    return twoLast.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }

  return slug;
}
