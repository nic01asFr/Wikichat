/**
 * cartography.mjs — Background cartography job.
 *
 * Scans projects, updates registry, detects changes via snapshots,
 * generates the thematic island map, and shares a summary if significant.
 */

import path from "path";
import os from "os";
import fs from "fs";
import { scanForProjects } from "../scanner.mjs";
import { loadRegistry, saveRegistry, mergeProjects, loadConfig } from "../registry.mjs";
import { collectSnapshot, detectChanges, loadSnapshot, saveSnapshot } from "../snapshot.mjs";
import { generateMap } from "../map-generator.mjs";
import { writeAtomicJSON } from "../persistence.mjs";

const CARTOGRAPHY_DIR = path.join(os.homedir(), ".wikichat", "cartography");

/**
 * Run a full cartography cycle.
 * @param {object} opts
 * @param {function} opts.log - log(msg) for status output
 * @param {function} opts.share - share({title, content, channel}) to broadcast results
 * @returns {{ scanned: number, changed: number, mapPath: string }}
 */
export async function runCartography({ log, share }) {
  // 1. Scan filesystem for projects
  const config = loadConfig();
  log("[Cartography] Scanning projects...");
  const scan = await scanForProjects(config.roots, config.maxDepth);
  log(`[Cartography] Found ${scan.length} project(s)`);

  // 2. Merge into registry
  const registry = loadRegistry();
  const merged = mergeProjects(registry.projects, scan);
  registry.projects = merged;
  registry.lastScan = new Date().toISOString();
  saveRegistry(registry);
  log(`[Cartography] Registry updated (${merged.length} total)`);

  // 3. Snapshot & change detection per non-missing project
  const summary = [];
  for (const p of merged.filter(pr => pr.status !== "missing")) {
    try {
      if (!p.path || !fs.existsSync(p.path)) continue;
      const prev = loadSnapshot(p.path);
      const curr = await collectSnapshot(p.path, prev);

      if (prev) {
        const changes = detectChanges(prev, curr);
        if (changes && changes.type === "changed") {
          const changeList = changes.changes || [];
          const total = changeList.length;
          // Significant = >5 changes OR touches key config files
          const touchesKey = changeList.some(c =>
            ["claude-md", "deps", "version"].includes(c.type)
          );
          if (total > 5 || touchesKey) {
            summary.push({ name: p.name, slug: p.slug, changes: changeList, total });
          }
        }
      }

      await saveSnapshot(p.path, curr);
    } catch { /* skip broken projects */ }
  }
  log(`[Cartography] ${summary.length} project(s) with significant changes`);

  // 4. Generate map
  const map = generateMap(merged);
  fs.mkdirSync(CARTOGRAPHY_DIR, { recursive: true });
  const mapFile = `${new Date().toISOString().split("T")[0]}.json`;
  const mapPath = path.join(CARTOGRAPHY_DIR, mapFile);
  writeAtomicJSON(mapPath, map);
  log(`[Cartography] Map saved: ${mapPath}`);

  // 5. Share summary if any significant changes
  if (summary.length > 0) {
    const lines = summary.map(s => {
      const detail = s.changes.map(c => c.detail).join(", ");
      return `- **${s.name}** (${s.total} change(s)): ${detail}`;
    });
    const content =
      `## Cartography refresh — ${summary.length} projet(s) changé(s)\n\n` +
      lines.join("\n") +
      `\n\n_${scan.length} projets scannés, carte mise à jour._`;

    await share({
      channel: "cartography",
      title: `Cartography refresh — ${summary.length} projet(s) changé(s)`,
      content,
    });
  }

  return { scanned: scan.length, changed: summary.length, mapPath };
}
