/**
 * test-regie.mjs — End-to-end smoke test for the régie/ideation track (B).
 *
 * Exercises the modules directly (no MCP roundtrip) :
 *   - ideas.mjs   : create / list / update / search / cluster_id flow
 *   - harmonizer  : two similar ideas should merge into one cluster
 *   - repo-audit  : audit this repo, expect score > 0 and warnings sane
 *
 * No server required — pure-module test. Uses a sandboxed ideas dir under
 * a tmp path so the user's real ~/.wikichat/ideas is untouched.
 *
 * Run : node test-regie.mjs
 */

import fs from "fs";
import os from "os";
import path from "path";

// Sandbox ~/.wikichat/ideas/ before importing ideas.mjs (which reads it on first call)
const ORIGINAL_HOME = os.homedir();
const tmpHome = path.join(os.tmpdir(), `wikichat-regie-test-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, ".wikichat", "ideas"), { recursive: true });
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;

let passed = 0, failed = 0;
function check(label, cond, detail = "") {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? `  -- ${detail}` : ""}`); }
}

async function run() {
  console.log("\n=== ideas.mjs ===");
  // Dynamic import after setting HOME so the module sees the sandbox
  const { createIdea, updateIdea, listIdeas, getIdea, searchIdeas, ideaStats } = await import("./src/ideas.mjs");

  const i1 = createIdea({
    title: "Indexer le dossier des projets pour search rapide",
    body: "Construire un index local des projets enregistrés pour accélérer la recherche transverse.",
    axes: ["search", "knowledge"],
    related_projects: ["wikichat"],
    created_by: "test",
  });
  check("createIdea returns id+timestamps", !!i1.id && !!i1.created_at && i1.status === "raw");

  const i2 = createIdea({
    title: "Ajouter un index search sur la KB",
    body: "Permettre une recherche full-text indexée sur les axes de connaissance.",
    axes: ["search", "knowledge"],
    related_projects: ["wikichat"],
    created_by: "test",
  });
  check("second idea created", !!i2.id && i2.id !== i1.id);

  const i3 = createIdea({
    title: "Notifier les blockers via Slack",
    body: "Envoyer une notification système quand un projet a un blocker non résolu depuis 7 jours.",
    axes: ["notifications", "ops"],
    created_by: "test",
  });
  check("third (unrelated) idea created", !!i3.id);

  const list = listIdeas({ limit: 10 });
  check("listIdeas returns 3", list.length === 3);
  check("listIdeas sorted desc", new Date(list[0].updated_at) >= new Date(list[1].updated_at));

  const search = searchIdeas("index");
  check("searchIdeas finds matching", search.length >= 2 && search.some(i => i.id === i1.id) && search.some(i => i.id === i2.id));

  const updated = updateIdea(i1.id, { status: "scoped", related_projects: [...i1.related_projects, "search-engine"] });
  check("updateIdea status flip", updated.status === "scoped");
  check("updateIdea related_projects merged", updated.related_projects.includes("search-engine"));

  const stats = ideaStats();
  check("ideaStats total=3", stats.total === 3);
  check("ideaStats by_status has scoped+raw", (stats.by_status.scoped || 0) >= 1 && (stats.by_status.raw || 0) >= 1);

  console.log("\n=== harmonizer.mjs ===");
  const { runHarmonizer } = await import("./src/harmonizer.mjs");
  // i1 was promoted to "scoped" — runHarmonizer defaults to raw+clustered, so reset i1 to clustered for the test
  // (or include scoped explicitly). We pass statuses explicitly to keep i1 in scope.
  const report = await runHarmonizer({ threshold: 0.2, min_cluster_size: 2, statuses: ["raw", "clustered", "scoped"] });
  check("harmonizer scanned all 3 ideas", report.total_ideas === 3);
  const expectCluster = report.clusters.find(c => c.members.some(m => m.id === i1.id) && c.members.some(m => m.id === i2.id));
  check("i1 + i2 clustered together", !!expectCluster, `got ${report.clusters.length} cluster(s), links=${report.links_found}`);
  check("i3 NOT in same cluster as i1", !expectCluster || !expectCluster.members.some(m => m.id === i3.id));
  // After harmonizer, i1 + i2 should have cluster_id set
  const i1After = getIdea(i1.id);
  const i2After = getIdea(i2.id);
  check("cluster_id persisted on i1", !!i1After.cluster_id);
  check("cluster_id matches between i1 and i2", i1After.cluster_id === i2After.cluster_id);
  check("similar_to is mutual", (i1After.similar_to || []).includes(i2.id) && (i2After.similar_to || []).includes(i1.id));

  // Re-run should be idempotent
  const report2 = await runHarmonizer({ threshold: 0.2, min_cluster_size: 2, statuses: ["raw", "clustered", "scoped"] });
  check("harmonizer idempotent (same cluster count)", report2.clusters.length === report.clusters.length);
  if (expectCluster) {
    const same = report2.clusters.find(c => c.cluster_id === expectCluster.cluster_id);
    check("same cluster_id on re-run", !!same);
  }

  console.log("\n=== repo-audit.mjs ===");
  const { auditProject } = await import("./src/repo-audit.mjs");
  const audit = await auditProject(process.cwd());
  check("audit ran on this repo", audit.exists === true);
  check("audit has score 0-100", audit.score >= 0 && audit.score <= 100);
  check("README detected", audit.readme_present === true);
  check("CLAUDE.md detected", audit.claude_md_present === true);
  check("is_git_repo true", audit.is_git_repo === true);
  check("warnings is array", Array.isArray(audit.warnings));

  // Cleanup
  process.env.HOME = ORIGINAL_HOME;
  process.env.USERPROFILE = ORIGINAL_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }

  console.log(`\n${"─".repeat(40)}`);
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => {
  console.error("FATAL:", err);
  process.exit(2);
});
