/**
 * harmonizer.mjs — Cluster ideas in the pool by similarity and propose syntheses.
 *
 * No embeddings yet — uses a token-set Jaccard on title+body+axes+related_projects.
 * Good enough to surface "these 3 ideas are about the same thing" ; richer
 * semantic similarity can replace this internal function later without changing
 * the public API.
 *
 * Output : updated cluster_id + similar_to on each idea, optional broadcast on
 * #ideation summarizing each non-trivial cluster (≥ 2 ideas).
 *
 * Idempotent : re-running stabilises clusters as long as ideas haven't changed
 * (same input → same cluster ids since they are content-derived).
 */

import { createHash } from "crypto";
import { listIdeas, updateIdea } from "./ideas.mjs";

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "of", "to", "in", "on", "at",
  "with", "as", "is", "are", "was", "were", "be", "been", "being", "has", "have",
  "had", "do", "does", "did", "this", "that", "these", "those", "it", "its",
  "le", "la", "les", "un", "une", "des", "de", "du", "et", "ou", "mais",
  "pour", "par", "sur", "dans", "avec", "comme", "est", "sont", "était",
  "qui", "que", "ce", "cette", "ces", "il", "elle", "ils", "elles", "y", "ne",
  "pas", "se", "son", "sa", "ses", "leur", "leurs", "on", "vous", "nous",
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s\-àâäéèêëîïôöùûüÿñæœ]/gi, " ")
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

/**
 * Build a token set fingerprint for an idea.
 * Title tokens count more (added thrice) ; axes are added with prefix to
 * avoid colliding with body words ; related_projects similarly prefixed.
 */
function fingerprint(idea) {
  const set = new Set();
  for (const t of tokenize(idea.title)) {
    set.add(t);
    set.add(`title:${t}`); // boost title overlap
  }
  for (const t of tokenize(idea.body)) set.add(t);
  for (const a of (idea.axes || [])) set.add(`axis:${a.toLowerCase()}`);
  for (const p of (idea.related_projects || [])) set.add(`proj:${p.toLowerCase()}`);
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return inter / union;
}

/** Union-find for clustering. */
class DSU {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let p = this.parent.get(x);
    if (p === x) return x;
    const root = this.find(p);
    this.parent.set(x, root);
    return root;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * Run a harmonization pass.
 *
 * @param {object} [opts]
 * @param {number} [opts.threshold=0.25]    Min Jaccard for two ideas to be linked
 * @param {number} [opts.min_cluster_size=2]  Cluster must have ≥ this many ideas to be reported
 * @param {string[]} [opts.statuses]        Which statuses to consider (default raw, clustered)
 * @returns {object} { clusters: [...], total_ideas, links_found, threshold }
 */
export async function runHarmonizer(opts = {}) {
  const threshold = opts.threshold ?? 0.25;
  const minClusterSize = opts.min_cluster_size ?? 2;
  const statuses = new Set(opts.statuses ?? ["raw", "clustered"]);

  const ideas = listIdeas().filter(i => statuses.has(i.status));
  if (ideas.length < 2) {
    return { clusters: [], total_ideas: ideas.length, links_found: 0, threshold };
  }

  // Compute fingerprints once
  const fps = new Map();
  for (const i of ideas) fps.set(i.id, fingerprint(i));

  // Pairwise similarity → union-find
  const dsu = new DSU();
  for (const i of ideas) dsu.find(i.id); // ensure singleton init
  const links = []; // [{ a, b, score }] for diagnostics

  for (let i = 0; i < ideas.length; i++) {
    for (let j = i + 1; j < ideas.length; j++) {
      const a = ideas[i], b = ideas[j];
      const score = jaccard(fps.get(a.id), fps.get(b.id));
      if (score >= threshold) {
        dsu.union(a.id, b.id);
        links.push({ a: a.id, b: b.id, score: +score.toFixed(3) });
      }
    }
  }

  // Group by root
  const groups = new Map();
  for (const idea of ideas) {
    const root = dsu.find(idea.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(idea);
  }

  // Build cluster reports
  const clusters = [];
  for (const [root, members] of groups) {
    if (members.length < minClusterSize) continue;
    // Stable cluster id derived from sorted member ids — same input → same id
    const sortedIds = members.map(m => m.id).sort();
    const clusterId = createHash("sha1").update(sortedIds.join(",")).digest("hex").slice(0, 10);
    // Aggregate axes + projects
    const axesCount = new Map();
    const projectsCount = new Map();
    for (const m of members) {
      for (const a of m.axes || []) axesCount.set(a, (axesCount.get(a) || 0) + 1);
      for (const p of m.related_projects || []) projectsCount.set(p, (projectsCount.get(p) || 0) + 1);
    }
    const topAxes = [...axesCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([a]) => a);
    const topProjects = [...projectsCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p);
    clusters.push({
      cluster_id: clusterId,
      size: members.length,
      members: members.map(m => ({ id: m.id, title: m.title, status: m.status })),
      top_axes: topAxes,
      top_projects: topProjects,
    });
  }

  // Persist updates : each idea in a cluster gets cluster_id + similar_to
  for (const c of clusters) {
    const others = c.members.map(m => m.id);
    for (const m of c.members) {
      const similar = others.filter(id => id !== m.id);
      const idea = ideas.find(i => i.id === m.id);
      if (idea && (idea.cluster_id !== c.cluster_id || JSON.stringify(idea.similar_to || []) !== JSON.stringify(similar))) {
        updateIdea(m.id, {
          cluster_id: c.cluster_id,
          similar_to: similar,
          status: idea.status === "raw" ? "clustered" : idea.status,
        });
      }
    }
  }

  // Also clear cluster_id from singletons that lost their cluster (e.g., body changed)
  for (const idea of ideas) {
    const root = dsu.find(idea.id);
    const grp = groups.get(root);
    if (grp.length < minClusterSize && idea.cluster_id) {
      updateIdea(idea.id, { cluster_id: null, similar_to: [] });
    }
  }

  // Sort clusters by size desc
  clusters.sort((a, b) => b.size - a.size);

  return {
    clusters,
    total_ideas: ideas.length,
    links_found: links.length,
    threshold,
    min_cluster_size: minClusterSize,
  };
}

/**
 * Format a cluster summary suitable for posting on #ideation.
 * One block per cluster ; if no clusters, a "nothing to harmonize" note.
 */
export function formatHarmonizerSummary(report) {
  if (report.clusters.length === 0) {
    return `🧩 Harmonizer pass : ${report.total_ideas} idée(s) scannée(s), ${report.links_found} lien(s) au seuil ${report.threshold}. Aucun cluster ≥ ${report.min_cluster_size} formé pour l'instant.`;
  }
  const blocks = report.clusters.map(c => {
    const lines = [
      `🧩 **Cluster ${c.cluster_id}** — ${c.size} idée(s)${c.top_axes.length ? ` · 🏷️ ${c.top_axes.join(", ")}` : ""}${c.top_projects.length ? ` · 🔗 ${c.top_projects.join(", ")}` : ""}`,
    ];
    for (const m of c.members) {
      lines.push(`   • [${m.id}] ${m.title}`);
    }
    lines.push(`   💡 Considérer un scoping projet : update_idea(id, status="scoped") sur l'idée pivot, puis declare_project + set_project_meta(axes=[${c.top_axes.map(a => `"${a}"`).join(", ")}]).`);
    return lines.join("\n");
  });
  return `🧩 Harmonizer : ${report.clusters.length} cluster(s) trouvé(s) sur ${report.total_ideas} idée(s)\n\n${blocks.join("\n\n")}`;
}
