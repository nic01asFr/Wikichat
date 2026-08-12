#!/usr/bin/env node
/**
 * sync-memory.mjs — battement de cœur bidirectionnel de la mémoire WikiChat.
 *
 * Un seul passage qui ferme la boucle dans les deux sens :
 *   1. INGEST  : pull du repo → intègre les idées capturées (inbox/) en local.
 *   2. PUBLISH : export sanitisé du local → push du snapshot (idempotent).
 *
 * Conçu pour tourner fréquemment (ex: toutes les 15 min). Quand rien n'a bougé,
 * les deux étapes sont des no-op (ingest sans inbox, publish à hash inchangé).
 *
 * Usage :
 *   node scripts/sync-memory.mjs --repo <local-clone>
 *
 * Env : WIKICHAT_MEMORY_REPO peut remplacer --repo.
 */

import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const repo =
  (() => {
    const i = argv.indexOf("--repo");
    return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
  })() || process.env.WIKICHAT_MEMORY_REPO;

if (!repo) {
  console.error("[sync-memory] Repo requis : --repo <dir> ou WIKICHAT_MEMORY_REPO.");
  process.exit(1);
}

function run(script, label) {
  try {
    execFileSync(process.execPath, [path.join(__dirname, script), "--repo", repo], {
      stdio: "inherit",
    });
  } catch (e) {
    // Une étape qui échoue ne doit pas casser l'autre : on log et on continue.
    console.error(`[sync-memory] ${label} a échoué (${e.message?.split("\n")[0]}).`);
  }
}

console.log("[sync-memory] --- INGEST (entrant) ---");
run("ingest-inbox.mjs", "ingest");
console.log("[sync-memory] --- PUBLISH (sortant) ---");
run("publish-memory.mjs", "publish");
console.log("[sync-memory] Sync terminée.");
