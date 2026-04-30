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
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { writeAtomicJSONAsync } from "./persistence.mjs";

const execAsync = promisify(execCb);

// ── Snapshot collection (pure Node.js, 0 tokens) ─────────────────────────────

/**
 * Collect a state snapshot for a project. All data is local metadata.
 * Async: git calls run in parallel and never block the event loop.
 */
export async function collectSnapshot(projectPath, prev = null) {
  const snapshot = {
    ts: new Date().toISOString(),
    path: projectPath,
    name: path.basename(projectPath),
  };

  snapshot.git = await collectGit(projectPath, prev?.git);
  snapshot.files = collectFiles(projectPath);
  snapshot.deps = collectDeps(projectPath);
  snapshot.claudeMd = collectClaudeMd(projectPath);

  return snapshot;
}

async function git(projectPath, args) {
  try {
    const { stdout } = await execAsync(`git ${args}`, {
      cwd: projectPath, encoding: "utf8", timeout: 5000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch { return null; }
}

async function collectGit(projectPath, prevGit = null) {
  // 1. Probe HEAD first — most projects in the registry are git repos but some aren't.
  const head = await git(projectPath, "rev-parse HEAD");
  if (!head) return null;
  // 2. Fast path : if HEAD unchanged AND prevGit exists, reuse it — skip 8 git execs.
  // This is the dominant case for a stable registry of ~120 projects scanned every 5min.
  if (prevGit && prevGit.head === head) {
    const statusPorcelain = await git(projectPath, "status --porcelain");
    return { ...prevGit, head, uncommitted: !!statusPorcelain };
  }
  // 3. Lite baseline path : no prev snapshot yet — store minimal data (2 execs).
  // Subsequent scans will hit the fast path and skip everything. Heavy enrichment
  // happens only when HEAD actually changes.
  if (!prevGit) {
    const statusPorcelain = await git(projectPath, "status --porcelain");
    return {
      head,
      branch: "?",
      lastCommit: { hash: head, date: null, message: null, author: null },
      commitCount5d: 0,
      uncommitted: !!statusPorcelain,
      remotes: [],
    };
  }
  // 4. Full path : HEAD changed — fetch full git metadata in parallel.
  const [branch, hash, date, message, author, commitCount5dStr, statusPorcelain, remoteV] = await Promise.all([
    git(projectPath, "branch --show-current"),
    git(projectPath, "log -1 --format=%H"),
    git(projectPath, "log -1 --format=%aI"),
    git(projectPath, "log -1 --format=%s"),
    git(projectPath, "log -1 --format=%an"),
    git(projectPath, 'rev-list --count --since="5 days ago" HEAD'),
    git(projectPath, "status --porcelain"),
    git(projectPath, "remote -v"),
  ]);
  return {
    head,
    branch: branch || "detached",
    lastCommit: { hash, date, message, author },
    commitCount5d: parseInt(commitCount5dStr || "0"),
    uncommitted: statusPorcelain ? true : false,
    remotes: remoteV?.split("\n").filter(l => l.includes("(fetch)")).map(l => l.split("\t")[1]?.split(" ")[0]) || [],
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
 * Save current snapshot for a project. Async — non-blocking.
 */
export async function saveSnapshot(projectPath, snapshot) {
  const dir = path.join(projectPath, ".wikichat");
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await writeAtomicJSONAsync(path.join(dir, SNAPSHOT_FILE), snapshot);
  } catch { /* non-blocking — project may not be writable */ }
}

/**
 * True iff prev and curr would produce the same change-detection result.
 * Used to skip the disk write when nothing meaningful changed (the vast
 * majority of cycles for stable projects).
 */
function _isMaterialEqual(prev, curr) {
  if (!prev || !curr) return false;
  // Git head + uncommitted flag + branch are the dominant signal.
  if (prev.git?.head !== curr.git?.head) return false;
  if (prev.git?.branch !== curr.git?.branch) return false;
  if (prev.git?.uncommitted !== curr.git?.uncommitted) return false;
  // CLAUDE.md content changed?
  if (prev.claudeMd?.hash !== curr.claudeMd?.hash) return false;
  // Dependencies changed?
  if (prev.deps?.depCount !== curr.deps?.depCount) return false;
  if (prev.deps?.version !== curr.deps?.version) return false;
  // Source file count changed materially?
  const prevCount = prev.files?._sourceFileCount || 0;
  const currCount = curr.files?._sourceFileCount || 0;
  if (prevCount > 0 && Math.abs(currCount - prevCount) / prevCount > 0.1) return false;
  return true;
}

// ── Main: scan all projects and detect changes ───────────────────────────────

/**
 * Scan a list of projects, collect snapshots, detect changes.
 * Async: never blocks the event loop. Concurrency-bounded.
 * `maxWrites` caps per-cycle disk activity so a registry of N projects
 * without prior snapshots doesn't pin CPU+disk for minutes on the first
 * cleanup tick — full coverage is reached over several cycles instead.
 *
 * Persistent round-robin cursor : each call resumes where the previous one
 * stopped, so projects later in the registry still get scanned eventually.
 */
let _scanCursor = 0;
export async function scanForChanges(projects, { concurrency = 2, maxWrites = 15, maxScans = 30 } = {}) {
  const results = [];
  const eligible = projects.filter(p => p.path && fs.existsSync(p.path));
  if (eligible.length === 0) return results;

  // Round-robin starting from cursor.
  const start = _scanCursor % eligible.length;
  const ordered = eligible.slice(start).concat(eligible.slice(0, start));
  const queue = ordered.slice(0, maxScans);
  _scanCursor = (_scanCursor + queue.length) % eligible.length;

  let writesUsed = 0;

  async function worker() {
    while (queue.length) {
      const project = queue.shift();
      if (!project) return;
      try {
        const prev = loadSnapshot(project.path);
        const curr = await collectSnapshot(project.path, prev);
        const changes = detectChanges(prev, curr);
        if (!_isMaterialEqual(prev, curr) && writesUsed < maxWrites) {
          writesUsed++;
          await saveSnapshot(project.path, curr);
        }
        if (changes) results.push({ project, snapshot: curr, changes });
      } catch { /* skip broken projects */ }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}
