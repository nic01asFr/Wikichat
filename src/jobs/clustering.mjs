/**
 * clustering.mjs — Inter-project similarity clustering.
 * Pure JS, no LLM. Uses Jaccard similarity on deps, langs, tags.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { loadRegistry } from "../registry.mjs";
import { writeAtomicJSON } from "../persistence.mjs";

// ── Helpers ─────────────────────────────────────────────────────────────────

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Read dep keys from package.json, pyproject.toml, or Cargo.toml.
 */
function readDeps(projectPath) {
  const deps = new Set();

  // package.json
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8"));
    for (const key of Object.keys(pkg.dependencies ?? {})) deps.add(key);
    for (const key of Object.keys(pkg.devDependencies ?? {})) deps.add(key);
  } catch { /* absent or malformed */ }

  // pyproject.toml — simple regex extraction
  try {
    const toml = fs.readFileSync(path.join(projectPath, "pyproject.toml"), "utf8");
    // [tool.poetry.dependencies] or [project.dependencies]
    const depRx = /^\s*([a-zA-Z0-9_-]+)\s*=/gm;
    const sectionRx = /\[(tool\.poetry\.dependencies|project\.dependencies)\]/g;
    let match;
    while ((match = sectionRx.exec(toml)) !== null) {
      const start = match.index + match[0].length;
      const nextSection = toml.indexOf("\n[", start);
      const block = toml.slice(start, nextSection === -1 ? undefined : nextSection);
      let m;
      while ((m = depRx.exec(block)) !== null) deps.add(m[1]);
    }
  } catch { /* absent */ }

  // Cargo.toml
  try {
    const cargo = fs.readFileSync(path.join(projectPath, "Cargo.toml"), "utf8");
    const depRx = /^\s*([a-zA-Z0-9_-]+)\s*=/gm;
    const sectionRx = /\[dependencies\]/g;
    let match;
    while ((match = sectionRx.exec(cargo)) !== null) {
      const start = match.index + match[0].length;
      const nextSection = cargo.indexOf("\n[", start);
      const block = cargo.slice(start, nextSection === -1 ? undefined : nextSection);
      let m;
      while ((m = depRx.exec(block)) !== null) deps.add(m[1]);
    }
  } catch { /* absent */ }

  return deps;
}

const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "__pycache__", ".next", "target", ".wikichat"]);

/**
 * Collect file extensions recursively (max depth 3).
 * Returns top-3 extensions as a Set.
 */
function readLangs(projectPath) {
  const extCounts = new Map();

  function walk(dir, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full, depth + 1);
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (ext && ext.length <= 6) {
          extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
        }
      }
    }
  }

  walk(projectPath, 0);

  const top = [...extCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ext]) => ext);

  return new Set(top);
}

// ── Union-Find ──────────────────────────────────────────────────────────────

class UnionFind {
  constructor(items) {
    this.parent = new Map();
    this.rank = new Map();
    for (const item of items) {
      this.parent.set(item, item);
      this.rank.set(item, 0);
    }
  }

  find(x) {
    if (this.parent.get(x) !== x) this.parent.set(x, this.find(this.parent.get(x)));
    return this.parent.get(x);
  }

  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra), rankB = this.rank.get(rb);
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else { this.parent.set(rb, ra); this.rank.set(ra, rankA + 1); }
  }

  clusters() {
    const groups = new Map();
    for (const item of this.parent.keys()) {
      const root = this.find(item);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(item);
    }
    return [...groups.values()].filter(c => c.length > 1);
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function runClustering({ log, share }) {
  log = log || console.log;

  const registry = loadRegistry();
  const activeProjects = registry.projects.filter(p => p.status !== "missing");

  log(`[Clustering] ${activeProjects.length} active projects`);

  // 1. Collect signatures
  const signatures = [];
  for (const proj of activeProjects) {
    try {
      const deps = readDeps(proj.path);
      const langs = readLangs(proj.path);
      const tags = new Set(Array.isArray(proj.tags) ? proj.tags : []);
      signatures.push({ slug: proj.slug, name: proj.name, path: proj.path, deps, langs, tags });
    } catch (err) {
      log(`[Clustering] Skip ${proj.slug}: ${err.message}`);
    }
  }

  // 2. Compute pairwise scores
  const edges = [];
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const a = signatures[i], b = signatures[j];
      const score =
        jaccard(a.deps, b.deps) +
        0.3 * jaccard(a.langs, b.langs) +
        0.2 * jaccard(a.tags, b.tags);
      if (score >= 0.2) {
        const common_deps = [...a.deps].filter(d => b.deps.has(d));
        edges.push({ a: a.slug, b: b.slug, score: Math.round(score * 1000) / 1000, common_deps });
      }
    }
  }
  edges.sort((a, b) => b.score - a.score);

  // 3. Build clusters via union-find (threshold 0.4)
  const uf = new UnionFind(signatures.map(s => s.slug));
  for (const e of edges) {
    if (e.score >= 0.4) uf.union(e.a, e.b);
  }
  const clusters = uf.clusters();

  // 4. Build output graph
  const graph = {
    nodes: signatures.map(s => ({
      slug: s.slug,
      name: s.name,
      langs: [...s.langs],
      deps_count: s.deps.size,
    })),
    edges,
    clusters,
  };

  // 5. Save to disk
  const clusterDir = path.join(os.homedir(), ".wikichat", "clusters");
  fs.mkdirSync(clusterDir, { recursive: true });
  const outPath = path.join(clusterDir, `${new Date().toISOString().split("T")[0]}.json`);
  writeAtomicJSON(outPath, graph);

  log(`[Clustering] ${edges.length} edges, ${clusters.length} clusters → ${outPath}`);

  // 6. Share if meaningful
  if (share && (edges.length > 0 || clusters.length > 1)) {
    const top10 = edges.slice(0, 10)
      .map(e => `- **${e.a}** ↔ **${e.b}**: ${e.score} (${e.common_deps.slice(0, 5).join(", ")})`)
      .join("\n");
    const clusterMd = clusters
      .map((c, i) => `- Cluster ${i + 1}: ${c.join(", ")}`)
      .join("\n");
    await share({
      channel: "cartography",
      title: `Clustering — ${edges.length} liaisons, ${clusters.length} cluster(s)`,
      content: `## Top paires\n${top10}\n\n## Clusters\n${clusterMd}`,
    });
  }

  return { projects: signatures.length, edges: edges.length, clusters: clusters.length, path: outPath };
}
