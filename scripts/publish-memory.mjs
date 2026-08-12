#!/usr/bin/env node
/**
 * publish-memory.mjs — Brique 2 du pipeline de consultation distante.
 *
 * Orchestre l'export (brique 1) vers un repo privé versionné, de façon
 * idempotente : ne committe que si le hash du manifest change, nettoie les
 * fichiers orphelins (projet disparu -> son .md sort du repo), commit + push.
 *
 * Le repo privé est un clone local d'un repo GitHub privé. Ce script ne crée
 * pas le repo distant ; il suppose <repo>/.git présent et un remote configuré.
 *
 * Usage :
 *   node scripts/publish-memory.mjs --repo <dir>           # export + commit + push
 *   node scripts/publish-memory.mjs --repo <dir> --no-push # local seulement
 *   node scripts/publish-memory.mjs --repo <dir> --force   # commit même si inchangé
 *
 * Env :
 *   WIKICHAT_MEMORY_REPO  — chemin du repo privé (alternative à --repo)
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------
// Args
// --------------------------------------------------------------------------

const argv = process.argv.slice(2);
const argVal = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

const FLAGS = {
  repo: argVal("--repo") || process.env.WIKICHAT_MEMORY_REPO,
  noPush: argv.includes("--no-push"),
  force: argv.includes("--force"),
};

// Fichiers/dossiers gérés par l'export. Tout est régénéré à chaque run : on les
// purge avant copie pour éliminer les orphelins.
const MANAGED = [
  "projects.json",
  "ideas.json",
  "cartography.json",
  "knowledge-index.json",
  "manifest.json",
  "knowledge",
  // Index légers + granulaires (lecture mobile ciblée via compositions GitHub).
  "projects-index.json",
  "ideas-index.json",
  "projects",
  "ideas",
];

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function fail(msg) {
  console.error(`[publish-memory] ${msg}`);
  process.exit(1);
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function readManifestHash(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).hash;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function main() {
  if (!FLAGS.repo) fail("Repo privé non spécifié (--repo <dir> ou WIKICHAT_MEMORY_REPO).");
  const repo = path.resolve(FLAGS.repo);
  if (!fs.existsSync(path.join(repo, ".git")))
    fail(`Pas un dépôt git: ${repo}\n  Crée le repo privé puis clone-le localement d'abord.`);

  // 1. Export vers un staging temporaire (isolé du repo).
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "wc-mem-"));
  try {
    execFileSync(
      process.execPath,
      [path.join(__dirname, "export-memory.mjs"), "--out", staging],
      { stdio: "inherit" }
    );
  } catch {
    fail("Export échoué (secret détecté ou erreur de collecte). Rien publié.");
  }

  // 2. Idempotence : comparer le hash du manifest.
  const oldHash = readManifestHash(repo);
  const newHash = readManifestHash(staging);
  if (!newHash) fail("Manifest absent dans le staging — export incomplet.");

  if (oldHash === newHash && !FLAGS.force) {
    console.log(`\n[publish-memory] Inchangé (hash ${newHash}) — rien à committer.`);
    fs.rmSync(staging, { recursive: true, force: true });
    return;
  }

  // 3. Purge des fichiers gérés (élimine les orphelins) puis copie.
  for (const m of MANAGED) {
    fs.rmSync(path.join(repo, m), { recursive: true, force: true });
  }
  for (const m of MANAGED) {
    const src = path.join(staging, m);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(repo, m), { recursive: true });
  }
  fs.rmSync(staging, { recursive: true, force: true });

  // 4. Commit si le working tree a changé.
  git(repo, ["add", "-A"]);
  const status = git(repo, ["status", "--porcelain"]);
  if (!status) {
    console.log("\n[publish-memory] Working tree identique après copie — rien à committer.");
    return;
  }

  const msg = `chore(memory): snapshot ${newHash}`;
  git(repo, ["commit", "-m", msg]);
  console.log(`\n[publish-memory] Commit: ${msg}`);

  // 5. Push.
  if (FLAGS.noPush) {
    console.log("[publish-memory] --no-push : commit local conservé, pas de push.");
    return;
  }
  try {
    const branch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    git(repo, ["push", "origin", branch]);
    console.log(`[publish-memory] Push OK -> origin/${branch}`);
  } catch (e) {
    fail(`Push échoué: ${e.message}\n  Commit local conservé — relance après avoir réglé le remote.`);
  }
}

main();
