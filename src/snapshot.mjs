/**
 * snapshot.mjs — Project state snapshot & change detection.
 *
 * Collects metadata from local projects (git, fs, package.json) with ZERO tokens.
 * Stores snapshots in .wikichat/state-snapshot.json per project.
 * Compares current vs previous snapshot to detect meaningful changes.
 *
 * SAFETY: Only reads from projects, only writes to .wikichat/ (respects injector contract).
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { writeAtomicJSON } from "./persistence.mjs";

// ── Snapshot collection (pure Node.js, 0 tokens) ─────────────────────────────

/**
 * Collect a state snapshot for a project. All data is local metadata.
 * @param {string} projectPath - Absolute path to the project
 * @returns {object} Snapshot with git, files, deps metadata
 */
export function collectSnapshot(projectPath) {
  const snapshot = {
    ts: new Date().toISOString(),
    path: projectPath,
    name: path.basename(projectPath),
  };

  // Git metadata (if git repo)
  snapshot.git = collectGit(projectPath);

  // Key files metadata (modification dates, sizes)
  snapshot.files = collectFiles(projectPath);

  // Dependencies (package.json / pyproject.toml)
  snapshot.deps = collectDeps(projectPath);

  // CLAUDE.md hash (detect documentation changes)
  snapshot.claudeMd = collectClaudeMd(projectPath);

  return snapshot;
}

function git(projectPath, args) {
  try {
    return execSync(`git ${args}`, {
      cwd: projectPath, encoding: "utf8", timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch { return null; }
}

function collectGit(projectPath) {
  const head = git(projectPath, "rev-parse HEAD");
  if (!head) return null; // Not a git repo

  return {
    head,
    branch: git(projectPath, "branch --show-current") || "detached",
    lastCommit: {
      hash: git(projectPath, "log -1 --format=%H"),
      date: git(projectPath, "log -1 --format=%aI"),
      message: git(projectPath, "log -1 --format=%s"),
      author: git(projectPath, "log -1 --format=%an"),
    },
    commitCount5d: parseInt(git(projectPath, 'rev-list --count --since="5 days ago" HEAD') || "0"),
    uncommitted: git(projectPath, "status --porcelain") ? true : false,
    remotes: git(projectPath, "remote -v")?.split("\n").filter(l => l.includes("(fetch)")).map(l => l.split("\t")[1]?.split(" ")[0]) || [],
  };
}

function collectFiles(projectPath) {
  const keyFiles = ["CLAUDE.md", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "README.md"];
  const result = {};

  for (const f of keyFiles) {
    const fp = path.join(projectPath, f);
    try {
      const st = fs.statSync(fp);
      result[f] = { size: st.size, modified: st.mtime.toISOString() };
    } catch { /* file doesn't exist */ }
  }

  // Count source files by extension
  try {
    const srcDirs = ["src", "lib", "app", "core", "components"];
    let totalFiles = 0;
    for (const d of srcDirs) {
      const dp = path.join(projectPath, d);
      try {
        totalFiles += countFiles(dp);
      } catch { /* dir doesn't exist */ }
    }
    result._sourceFileCount = totalFiles;
  } catch { /* */ }

  return result;
}

function countFiles(dir, depth = 0) {
  if (depth > 3) return 0;
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) count++;
      else if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
        count += countFiles(path.join(dir, entry.name), depth + 1);
      }
    }
  } catch { /* */ }
  return count;
}

function collectDeps(projectPath) {
  // package.json
  const pkgPath = path.join(projectPath, "package.json");
  try {
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      return {
        type: "npm",
        name: pkg.name,
        version: pkg.version,
        depCount: Object.keys(pkg.dependencies || {}).length,
        devDepCount: Object.keys(pkg.devDependencies || {}).length,
        scripts: Object.keys(pkg.scripts || {}),
      };
    }
  } catch { /* */ }

  // pyproject.toml (basic check)
  const pyPath = path.join(projectPath, "pyproject.toml");
  try {
    if (fs.existsSync(pyPath)) {
      const content = fs.readFileSync(pyPath, "utf8");
      return {
        type: "python",
        hasRequirements: fs.existsSync(path.join(projectPath, "requirements.txt")),
        hasPyproject: true,
        lines: content.split("\n").length,
      };
    }
  } catch { /* */ }

  return null;
}

function collectClaudeMd(projectPath) {
  const fp = path.join(projectPath, "CLAUDE.md");
  try {
    if (!fs.existsSync(fp)) return null;
    const content = fs.readFileSync(fp, "utf8");
    // Simple hash — not crypto, just change detection
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    }
    return { size: content.length, hash, lines: content.split("\n").length };
  } catch { return null; }
}

// ── Change detection (compare two snapshots) ──────────────────────────────────

/**
 * Compare current snapshot with previous one. Returns changes or null if nothing significant.
 * @param {object} prev - Previous snapshot (from .wikichat/state-snapshot.json)
 * @param {object} curr - Current snapshot (just collected)
 * @returns {object|null} Changes object, or null if nothing meaningful changed
 */
export function detectChanges(prev, curr) {
  if (!prev) return { type: "new", reason: "premier snapshot" };

  const changes = [];

  // Git changes
  if (prev.git && curr.git) {
    if (prev.git.head !== curr.git.head) {
      const newCommits = curr.git.commitCount5d - (prev.git.commitCount5d || 0);
      changes.push({
        type: "commits",
        detail: `${Math.max(1, newCommits)} nouveau(x) commit(s)`,
        prev: prev.git.lastCommit?.message,
        curr: curr.git.lastCommit?.message,
      });
    }
    if (prev.git.branch !== curr.git.branch) {
      changes.push({
        type: "branch",
        detail: `branche changée: ${prev.git.branch} → ${curr.git.branch}`,
      });
    }
    if (!prev.git.uncommitted && curr.git.uncommitted) {
      changes.push({ type: "uncommitted", detail: "modifications non committées détectées" });
    }
  } else if (!prev.git && curr.git) {
    changes.push({ type: "git-init", detail: "dépôt git initialisé" });
  }

  // CLAUDE.md changes
  if (prev.claudeMd?.hash !== curr.claudeMd?.hash && curr.claudeMd) {
    changes.push({ type: "claude-md", detail: "CLAUDE.md modifié" });
  }

  // Dependencies changes
  if (prev.deps && curr.deps) {
    if (prev.deps.depCount !== curr.deps.depCount) {
      const diff = curr.deps.depCount - prev.deps.depCount;
      changes.push({ type: "deps", detail: `${diff > 0 ? "+" : ""}${diff} dépendance(s)` });
    }
    if (prev.deps.version !== curr.deps.version) {
      changes.push({ type: "version", detail: `version: ${prev.deps.version} → ${curr.deps.version}` });
    }
  }

  // Source file count changes (significant if >10% change)
  const prevCount = prev.files?._sourceFileCount || 0;
  const currCount = curr.files?._sourceFileCount || 0;
  if (prevCount > 0 && Math.abs(currCount - prevCount) / prevCount > 0.1) {
    changes.push({ type: "files", detail: `fichiers source: ${prevCount} → ${currCount}` });
  }

  return changes.length > 0 ? { type: "changed", changes } : null;
}

// ── Snapshot persistence ──────────────────────────────────────────────────────

const SNAPSHOT_FILE = "state-snapshot.json";

/**
 * Load previous snapshot for a project.
 */
export function loadSnapshot(projectPath) {
  const fp = path.join(projectPath, ".wikichat", SNAPSHOT_FILE);
  try {
    if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch { /* */ }
  return null;
}

/**
 * Save current snapshot for a project.
 */
export function saveSnapshot(projectPath, snapshot) {
  const dir = path.join(projectPath, ".wikichat");
  try {
    fs.mkdirSync(dir, { recursive: true });
    writeAtomicJSON(path.join(dir, SNAPSHOT_FILE), snapshot);
  } catch { /* non-blocking — project may not be writable */ }
}

// ── Main: scan all projects and detect changes ───────────────────────────────

/**
 * Scan a list of projects, collect snapshots, detect changes.
 * Returns array of { project, changes } for projects that changed.
 * @param {Array} projects - Array of { path, name, slug } from registry
 * @returns {Array<{ project, snapshot, changes }>}
 */
export function scanForChanges(projects) {
  const results = [];

  for (const project of projects) {
    if (!project.path || !fs.existsSync(project.path)) continue;

    try {
      const prev = loadSnapshot(project.path);
      const curr = collectSnapshot(project.path);
      const changes = detectChanges(prev, curr);

      // Always save current snapshot
      saveSnapshot(project.path, curr);

      if (changes) {
        results.push({ project, snapshot: curr, changes });
      }
    } catch { /* skip broken projects */ }
  }

  return results;
}
