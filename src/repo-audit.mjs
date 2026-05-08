/**
 * repo-audit.mjs — Compute a project's `health` snapshot from filesystem + git.
 *
 * Populates the régie schema's reserved `health` field (set_project_meta refuses
 * it because it's derived, not declared). Called on-demand via the audit_project
 * MCP tool or in batch by the (future) RepoAuditor daemon.
 *
 * No external services : everything is local fs.stat and `git` subprocesses.
 * Tolerates missing dirs, broken git repos, network-less remotes.
 *
 * Time budget : ~50-200ms per project depending on git history size.
 */

import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;

/** Run a git command in a repo, swallowing non-zero exits and returning stdout. */
async function git(repoPath, args) {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd: repoPath,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function readSafe(p, max = 64 * 1024) {
  try {
    const buf = fs.readFileSync(p, "utf8");
    return buf.length > max ? buf.slice(0, max) : buf;
  } catch { return null; }
}

const LICENSE_PATTERNS = [
  { id: "MIT", re: /\bMIT License\b|\bPermission is hereby granted, free of charge\b/ },
  { id: "Apache-2.0", re: /\bApache License,?\s+Version 2\.0\b/ },
  { id: "GPL-3.0", re: /\bGNU General Public License\b[^.]*?version 3\b/i },
  { id: "GPL-2.0", re: /\bGNU General Public License\b[^.]*?version 2\b/i },
  { id: "BSD-3-Clause", re: /\bBSD 3-Clause\b|\bRedistribution and use in source and binary forms\b/ },
  { id: "ISC", re: /\bISC License\b/ },
  { id: "Unlicense", re: /\bUnlicense\b|\bThis is free and unencumbered software\b/ },
];

function detectLicense(repoPath) {
  // Check standard LICENSE files first, then fall back to README header.
  for (const fname of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
    const txt = readSafe(path.join(repoPath, fname));
    if (!txt) continue;
    for (const { id, re } of LICENSE_PATTERNS) {
      if (re.test(txt)) return id;
    }
    return "unknown"; // file exists but pattern unmatched
  }
  return null;
}

function detectTests(repoPath) {
  // Heuristic : directory test/, tests/, __tests__, spec/, OR a *.test.* / *.spec.* file at root.
  const dirs = ["test", "tests", "__tests__", "spec", "e2e"];
  for (const d of dirs) {
    if (statSafe(path.join(repoPath, d))?.isDirectory()) return true;
  }
  try {
    for (const f of fs.readdirSync(repoPath)) {
      if (/\.(test|spec)\.(m?js|ts|tsx|py|rb)$/.test(f)) return true;
    }
  } catch { /* */ }
  return false;
}

function detectCi(repoPath) {
  if (statSafe(path.join(repoPath, ".github", "workflows"))?.isDirectory()) return "github-actions";
  if (statSafe(path.join(repoPath, ".gitlab-ci.yml"))) return "gitlab-ci";
  if (statSafe(path.join(repoPath, ".circleci"))?.isDirectory()) return "circleci";
  return null;
}

/**
 * Compute the health snapshot for a single repository path.
 * Returns a plain object suitable for storage in project.health.
 *
 * @param {string} repoPath  Absolute path to the project root
 * @returns {Promise<object>} health snapshot
 */
export async function auditProject(repoPath) {
  const audit = {
    audited_at: new Date().toISOString(),
    repo_path: repoPath,
    exists: false,
  };

  if (!repoPath || !fs.existsSync(repoPath)) {
    audit.error = "repo_path missing on disk";
    return audit;
  }
  audit.exists = true;

  // ── Documentation signals ──────────────────────────────────────────────────
  const readmePath = ["README.md", "README", "README.rst", "README.txt"]
    .map(f => path.join(repoPath, f))
    .find(p => statSafe(p));
  audit.readme_present = !!readmePath;
  if (readmePath) {
    const stat = statSafe(readmePath);
    audit.readme_age_days = Math.floor((Date.now() - stat.mtime.getTime()) / (24 * 60 * 60 * 1000));
    audit.readme_size = stat.size;
  } else {
    audit.readme_age_days = null;
    audit.readme_size = 0;
  }

  audit.claude_md_present = !!statSafe(path.join(repoPath, "CLAUDE.md"));
  audit.gitignore_present = !!statSafe(path.join(repoPath, ".gitignore"));
  audit.license = detectLicense(repoPath);
  audit.has_tests = detectTests(repoPath);
  audit.ci = detectCi(repoPath);

  // ── Git signals ────────────────────────────────────────────────────────────
  const gitDir = path.join(repoPath, ".git");
  audit.is_git_repo = !!statSafe(gitDir);
  if (audit.is_git_repo) {
    audit.branch = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    audit.last_commit_iso = await git(repoPath, ["log", "-1", "--format=%cI"]);
    audit.last_commit_subject = (await git(repoPath, ["log", "-1", "--format=%s"]))?.slice(0, 120) || null;

    const status = await git(repoPath, ["status", "--porcelain"]);
    audit.uncommitted = status ? status.split("\n").filter(Boolean).length : 0;

    const remoteUrl = await git(repoPath, ["remote", "get-url", "origin"]);
    audit.remote_url = remoteUrl || null;

    if (remoteUrl && audit.branch && audit.branch !== "HEAD") {
      // Use refs we already have locally — no fetch (would be slow + need network)
      const ahead = await git(repoPath, ["rev-list", "--count", `origin/${audit.branch}..HEAD`]);
      const behind = await git(repoPath, ["rev-list", "--count", `HEAD..origin/${audit.branch}`]);
      audit.ahead_of_remote = ahead ? parseInt(ahead, 10) : null;
      audit.behind_remote = behind ? parseInt(behind, 10) : null;
    } else {
      audit.ahead_of_remote = null;
      audit.behind_remote = null;
    }

    if (audit.last_commit_iso) {
      audit.last_commit_age_days = Math.floor(
        (Date.now() - new Date(audit.last_commit_iso).getTime()) / (24 * 60 * 60 * 1000)
      );
    } else {
      audit.last_commit_age_days = null;
    }
  }

  // ── Score : a coarse health % for at-a-glance lists ──────────────────────────
  audit.score = computeScore(audit);
  audit.warnings = computeWarnings(audit);

  return audit;
}

function computeScore(a) {
  let score = 0;
  let max = 0;
  // Documentation (25)
  max += 10; if (a.readme_present) score += 10;
  max += 10; if (a.claude_md_present) score += 10;
  max += 5; if (a.license) score += 5;
  // Hygiene (25)
  max += 10; if (a.gitignore_present) score += 10;
  max += 10; if (a.has_tests) score += 10;
  max += 5; if (a.ci) score += 5;
  // Git activity (25)
  max += 25;
  if (a.is_git_repo) {
    if (a.last_commit_age_days === null) score += 5;
    else if (a.last_commit_age_days <= 30) score += 25;
    else if (a.last_commit_age_days <= 90) score += 18;
    else if (a.last_commit_age_days <= 365) score += 10;
    else score += 3;
  }
  // Sync hygiene (25)
  max += 15;
  if (a.uncommitted === 0) score += 15;
  else if (a.uncommitted <= 5) score += 8;
  max += 10;
  if (a.ahead_of_remote === 0 && a.behind_remote === 0) score += 10;
  else if (a.ahead_of_remote === null) score += 5; // unknown is neutral

  return Math.round((score / max) * 100);
}

function computeWarnings(a) {
  const w = [];
  if (a.exists) {
    if (!a.readme_present) w.push("no README");
    else if (a.readme_age_days >= 365) w.push(`README stale (${a.readme_age_days}d old)`);
    if (!a.license) w.push("no LICENSE detected");
    if (!a.gitignore_present) w.push("no .gitignore");
    if (!a.has_tests) w.push("no tests detected");
    if (a.uncommitted > 10) w.push(`${a.uncommitted} uncommitted changes`);
    if (a.ahead_of_remote > 5) w.push(`${a.ahead_of_remote} unpushed commits`);
    if (a.last_commit_age_days >= 365) w.push(`stale repo (no commit in ${a.last_commit_age_days}d)`);
  }
  return w;
}

/**
 * Audit multiple projects with a concurrency cap. Returns a Map<projectName, audit>.
 *
 * @param {Array<{name: string, path: string}>} projects
 * @param {number} [concurrency]
 */
export async function auditMany(projects, concurrency = 4) {
  const results = new Map();
  const queue = [...projects];
  async function worker() {
    while (queue.length > 0) {
      const p = queue.shift();
      try {
        results.set(p.name, await auditProject(p.path));
      } catch (err) {
        results.set(p.name, { error: err.message, exists: false });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return results;
}
