#!/usr/bin/env node
/**
 * ingest-inbox.mjs — chemin entrant, côté LOCAL (4e brique).
 *
 * Récupère les idées capturées à distance (déposées dans inbox/ du repo privé
 * par le serveur MCP d'écriture) et les intègre dans la mémoire WikiChat locale
 * via le vrai createIdea(). Marque chaque idée traitée (inbox/processed/) puis
 * repousse l'état.
 *
 * Le local reste autorité : rien n'écrit dans ~/.wikichat sans passer par ici,
 * et l'idée est traitée comme DONNÉE TEXTE (jamais exécutée).
 *
 * Usage :
 *   node scripts/ingest-inbox.mjs --repo <local-clone>   # pull + intègre + push
 *   node scripts/ingest-inbox.mjs --repo <dir> --dry-run # liste sans intégrer
 *   node scripts/ingest-inbox.mjs --repo <dir> --no-push # garde le commit local
 *
 * Env : WIKICHAT_MEMORY_REPO peut remplacer --repo.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createIdea } from "../src/ideas.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const argVal = (n) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const FLAGS = {
  repo: argVal("--repo") || process.env.WIKICHAT_MEMORY_REPO,
  dryRun: argv.includes("--dry-run"),
  noPush: argv.includes("--no-push"),
};

function fail(msg) {
  console.error(`[ingest-inbox] ${msg}`);
  process.exit(1);
}

if (!FLAGS.repo) fail("Repo local requis : --repo <dir> ou WIKICHAT_MEMORY_REPO.");
const REPO = path.resolve(FLAGS.repo);
if (!fs.existsSync(path.join(REPO, ".git"))) fail(`Pas un dépôt git: ${REPO}`);

const INBOX = path.join(REPO, "inbox");
const PROCESSED = path.join(INBOX, "processed");

function git(args) {
  return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8" }).trim();
}

/** Validation stricte : on n'accepte que des champs texte attendus. */
function sanitizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  return {
    title,
    body: typeof raw.body === "string" ? raw.body : "",
    related_projects: Array.isArray(raw.related_projects)
      ? raw.related_projects.filter((x) => typeof x === "string")
      : [],
    axes: Array.isArray(raw.axes) ? raw.axes.filter((x) => typeof x === "string") : [],
  };
}

/**
 * Capture Markdown avec front-matter (format de la composition BigMCP, car le
 * moteur de compose refuse une string JSON — il la parse en objet). Texte pur :
 *   ---
 *   title: ...
 *   project: ...
 *   ---
 *   <corps>
 */
function parseMarkdown(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  const meta = {};
  let body = text;
  if (m) {
    body = m[2] || "";
    for (const line of m[1].split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) meta[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  // Le `type` de capture (note/task/link/idea) est porté comme axe : toutes les
  // captures externes deviennent des IDÉES taguées (propositions), jamais une
  // mutation directe de project-state. Le local reste autorité.
  const axes = meta.axes ? meta.axes.split(",").map((s) => s.trim()).filter(Boolean) : [];
  if (meta.type && meta.type !== "idea" && !axes.includes(meta.type)) axes.push(meta.type);
  // Le titre peut ne pas être en front-matter : une note Markdown le porte
  // naturellement en titre de niveau 1. Sans ce repli, une capture parfaitement
  // lisible était rejetée pour « titre manquant » — et comme le rejet ne coûte
  // rien, la tâche planifiée le répétait toutes les 15 minutes en se déclarant
  // réussie. Une idée est restée deux jours dans inbox/ à ce régime.
  const titreH1 = (body.match(/^\s*#\s+(.+?)\s*$/m) || [])[1] || "";
  return sanitizeEntry({
    title: meta.title || titreH1,
    body: body.trim(),
    related_projects: meta.project ? [meta.project] : [],
    axes,
  });
}

/** Lit une capture inbox (JSON ou Markdown) → entrée normalisée, ou null. */
function readCapture(name, content) {
  if (name.endsWith(".md")) return parseMarkdown(content);
  try {
    return sanitizeEntry(JSON.parse(content));
  } catch {
    return null;
  }
}

function main() {
  // 1. Pull pour récupérer les captures distantes.
  try {
    git(["pull", "--ff-only", "--quiet"]);
  } catch {
    console.warn("[ingest-inbox] git pull a échoué (réseau / divergence) — on traite le local.");
  }

  if (!fs.existsSync(INBOX)) {
    console.log("[ingest-inbox] Pas d'inbox/ — rien à faire.");
    return;
  }

  // 2. Idées en attente = inbox/*.json|*.md (hors processed/).
  const pending = fs
    .readdirSync(INBOX, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith(".json") || e.name.endsWith(".md")))
    .map((e) => e.name);

  if (!pending.length) {
    console.log("[ingest-inbox] Aucune idée en attente.");
    return;
  }

  const ingested = [];
  const skipped = [];
  for (const name of pending) {
    const full = path.join(INBOX, name);
    const entry = readCapture(name, fs.readFileSync(full, "utf8"));
    if (!entry) {
      skipped.push(`${name} (format invalide ou titre manquant)`);
      continue;
    }

    if (FLAGS.dryRun) {
      ingested.push({ name, title: entry.title, id: "(dry-run)" });
      continue;
    }

    // 3. Intégration via le vrai createIdea (persiste dans ~/.wikichat/ideas).
    const idea = createIdea({
      title: entry.title,
      body: entry.body,
      axes: entry.axes,
      related_projects: entry.related_projects,
      source: "user",
      created_by: "mcp-capture",
    });

    // 4. Marque traité : archive en processed/ avec l'id obtenu.
    fs.mkdirSync(PROCESSED, { recursive: true });
    fs.writeFileSync(
      path.join(PROCESSED, `${name}.ingested.json`),
      JSON.stringify(
        { ...entry, status: "ingested", ingested_id: idea.id, ingested_at: new Date().toISOString() },
        null,
        2
      )
    );
    fs.rmSync(full);
    ingested.push({ name, title: entry.title, id: idea.id });
  }

  // 5. Rapport.
  console.log(`[ingest-inbox] ${ingested.length} intégrée(s), ${skipped.length} ignorée(s).`);
  for (const i of ingested) console.log(`  + ${i.id}  ${i.title}`);
  for (const s of skipped) console.log(`  - ${s}`);

  if (FLAGS.dryRun || !ingested.length) return;

  // 6. Commit + push l'état de l'inbox (déplacements).
  git(["add", "-A", "--", "inbox"]);
  if (!git(["status", "--porcelain", "--", "inbox"])) return;
  git(["commit", "-m", `inbox: ingest ${ingested.length} idea(s)`]);
  if (FLAGS.noPush) {
    console.log("[ingest-inbox] --no-push : commit local conservé.");
    return;
  }
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    git(["pull", "--rebase", "--quiet"]);
    git(["push", "origin", branch]);
    console.log(`[ingest-inbox] Poussé -> origin/${branch}`);
  } catch (e) {
    console.warn(`[ingest-inbox] Push échoué (${e.message}) — commit local conservé.`);
  }
}

main();
