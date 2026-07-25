#!/usr/bin/env node
/**
 * export-memory.mjs — Brique 1 du pipeline de consultation distante.
 *
 * Sweep des sources de mémoire WikiChat (centrale + par-projet), filtrage du
 * bruit, sanitisation stricte (whitelist de champs + scan anti-secret), et
 * émission d'un snapshot canonique versionnable.
 *
 * Aucune écriture dans ~/.wikichat. Lecture seule des sources, écriture
 * uniquement dans le dossier de staging.
 *
 * Usage :
 *   node scripts/export-memory.mjs --dry-run        # rapport, n'écrit rien
 *   node scripts/export-memory.mjs --out <dir>      # staging (défaut ./wikichat-memory-staging)
 *   node scripts/export-memory.mjs --verbose        # détail du filtrage
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

// --------------------------------------------------------------------------
// Args
// --------------------------------------------------------------------------

const argv = process.argv.slice(2);
const FLAGS = {
  dryRun: argv.includes("--dry-run"),
  verbose: argv.includes("--verbose"),
  out: (() => {
    const i = argv.indexOf("--out");
    return i !== -1 && argv[i + 1] ? argv[i + 1] : "wikichat-memory-staging";
  })(),
};

const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir();
const WIKICHAT_DIR = path.join(HOME, ".wikichat");
const OUT_DIR = path.resolve(FLAGS.out);

// --------------------------------------------------------------------------
// Politique de sécurité
// --------------------------------------------------------------------------

// Fichiers/dossiers de la zone centrale qui ne doivent JAMAIS être lus.
const SECRET_SOURCES = new Set([
  "identity-bindings.json",
  "process-tokens",
  "sessions",
  "hook-cursors",
  "queue",
  "stdout.log",
  "stderr.log",
]);

// Champs sensibles à retirer de tout objet sérialisé (chemins machine, ids de
// session live, jetons). Appliqué récursivement par sanitizeObject().
const SECRET_FIELDS = new Set([
  "claude_session_id",
  "repo_path",
  "token",
  "process_token",
  "pid",
  "claimedBy",
]);

// Heuristiques de détection de secret résiduel dans le snapshot final.
// Couvre les paths Windows sous toutes leurs formes : C:/ , C:\ , et C:\\
// (double backslash après JSON.stringify).
const SECRET_PATTERNS = [
  { name: "absolute-win-path", re: /[A-Za-z]:(?:\\{1,2}|\/)Users/ },
  { name: "absolute-unix-home", re: /\/(?:home|Users)\/[^/"]+\/\.wikichat/ },
  { name: "bearer-token", re: /\b(sk|tok|bearer|ghp)[-_][A-Za-z0-9]{16,}/i },
  { name: "process-token", re: /"process_token"\s*:/ },
];

/**
 * Le champ github du registry contient parfois un path local (projets sans
 * remote réel). On ne garde que les vraies URLs distantes ; tout le reste est
 * écarté. Retourne null si rien d'exposable.
 */
function sanitizeGithub(github) {
  if (!github) return null;
  const url = typeof github === "string" ? github : github.url;
  if (typeof url !== "string") return null;
  const isRemote = /^(https?:\/\/|git@)/.test(url) && !/[A-Za-z]:[\\/]/.test(url);
  if (!isRemote) return null;
  return typeof github === "string" ? { url } : github;
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const report = {
  collected: { projects: 0, knowledge: 0, ideas: 0, cartography: false },
  filtered: { noisyProjects: 0 },
  redactions: 0,
  warnings: [],
};

function log(...a) {
  if (FLAGS.verbose) console.log("  ", ...a);
}

function readJSON(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/** Retire récursivement les champs sensibles. Compte les redactions. */
function sanitizeObject(value) {
  if (Array.isArray(value)) return value.map(sanitizeObject);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELDS.has(k)) {
        report.redactions++;
        continue;
      }
      out[k] = sanitizeObject(v);
    }
    return out;
  }
  return value;
}

/** Remplace les paths machine absolus par un placeholder. Couvre C:/, C:\ . */
function scrubPaths(str) {
  if (typeof str !== "string") return str;
  return str
    .replace(/[A-Za-z]:[\\/]Users[\\/][^"\s]*/g, "<path>")
    .replace(/\/(?:home|Users)\/[^/"\s]+\/[^"\s]*/g, "<path>");
}

// --------------------------------------------------------------------------
// Collecte
// --------------------------------------------------------------------------

function loadRegistry() {
  const data = readJSON(path.join(WIKICHAT_DIR, "registry.json"), { projects: [] });
  return Array.isArray(data.projects) ? data.projects : [];
}

/** Un projet "réel" a un project-state.json OU un status active/closed. */
function isRealProject(entry, statePresent) {
  if (statePresent) return true;
  return ["active", "closed"].includes(entry.status);
}

function collectProjects(registry) {
  const projects = [];
  for (const entry of registry) {
    if (!entry.path) continue;
    const statePath = path.join(entry.path, ".wikichat", "project-state.json");
    const state = readJSON(statePath);
    if (!isRealProject(entry, !!state)) {
      report.filtered.noisyProjects++;
      log("skip (bruit):", entry.slug || entry.name);
      continue;
    }

    // Whitelist de champs — on copie seulement ce qu'on autorise à sortir.
    const sanitizedTasks = {};
    for (const [id, t] of Object.entries(state?.tasks || {})) {
      sanitizedTasks[id] = sanitizeObject({
        id: t.id,
        description: t.description,
        status: t.status,
        outcome: t.outcome,
        progress: t.progress,
        completedAt: t.completedAt,
      });
    }

    projects.push({
      slug: entry.slug || null,
      name: state?.name || entry.name || entry.slug,
      description: scrubPaths(state?.description || entry.description || ""),
      stack: state?.stack || entry.stack || [],
      status: state?.status || entry.status || "discovered",
      github: sanitizeGithub(entry.github) || sanitizeGithub(state?.repo),
      decisions: (state?.decisions || []).map(scrubPaths),
      open_questions: state?.open_questions || [],
      blockers: (state?.blockers || []).map(scrubPaths),
      tasks: sanitizedTasks,
      closure: state?.closure ? sanitizeObject(state.closure) : null,
      updatedAt: state?.updatedAt || entry.updatedAt || null,
    });
  }
  report.collected.projects = projects.length;
  return projects;
}

function collectKnowledge(registry, destDir) {
  const files = [];
  const addDir = (source, dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const src = path.join(dir, e.name);
      const content = scrubPaths(fs.readFileSync(src, "utf8"));
      // Préfixe par la source pour éviter les collisions de noms entre projets.
      const outName = source === "central" ? e.name : `${source}__${e.name}`;
      files.push({ source, name: outName, content });
    }
  };

  addDir("central", path.join(WIKICHAT_DIR, "knowledge"));
  for (const entry of registry) {
    if (!entry.path) continue;
    addDir(entry.slug || entry.name, path.join(entry.path, ".wikichat", "knowledge"));
  }

  report.collected.knowledge = files.length;
  if (!FLAGS.dryRun && files.length) {
    const kdir = path.join(destDir, "knowledge");
    fs.mkdirSync(kdir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(kdir, f.name), f.content);
  }
  return files.map((f) => ({ source: f.source, name: f.name, bytes: f.content.length }));
}

function collectIdeas() {
  const dir = path.join(WIKICHAT_DIR, "ideas");
  const ideas = [];
  let entries;
  try {
    entries = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return ideas;
  }
  for (const n of entries) {
    const d = readJSON(path.join(dir, n));
    if (!d) continue;
    ideas.push(
      sanitizeObject({
        id: d.id,
        title: d.title,
        body: scrubPaths(d.body || ""),
        axes: d.axes || [],
        related_projects: d.related_projects || [],
        status: d.status,
        created_at: d.created_at,
        updated_at: d.updated_at,
      })
    );
  }
  report.collected.ideas = ideas.length;
  return ideas;
}

function collectLatestCartography() {
  const dir = path.join(WIKICHAT_DIR, "cartography");
  let files;
  try {
    files = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return null;
  }
  if (!files.length) return null;
  const latest = readJSON(path.join(dir, files[files.length - 1]));
  if (!latest) return null;
  report.collected.cartography = true;
  // La carto ne contient pas de secrets, mais on scrub les paths par prudence.
  return JSON.parse(scrubPaths(JSON.stringify(latest)));
}

// --------------------------------------------------------------------------
// Garde anti-secret : scanne le snapshot sérialisé avant écriture.
// --------------------------------------------------------------------------

function scanForSecrets(serialized) {
  const hits = [];
  for (const { name, re } of SECRET_PATTERNS) {
    const m = serialized.match(re);
    if (m) hits.push({ pattern: name, sample: m[0].slice(0, 40) });
  }
  return hits;
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

function main() {
  if (!fs.existsSync(WIKICHAT_DIR)) {
    console.error(`[export-memory] Introuvable: ${WIKICHAT_DIR}`);
    process.exit(1);
  }

  // Sanity : aucune source secrète ne doit être touchée par la collecte.
  for (const s of SECRET_SOURCES) log("source exclue d'office:", s);

  const registry = loadRegistry();
  const projects = collectProjects(registry);
  const ideas = collectIdeas();
  const cartography = collectLatestCartography();

  // La knowledge est écrite directement (fichiers .md) si pas dry-run.
  if (!FLAGS.dryRun) fs.mkdirSync(OUT_DIR, { recursive: true });
  const knowledgeIndex = collectKnowledge(registry, OUT_DIR);

  const snapshot = {
    projects: { projects, generatedFields: "whitelist" },
    ideas: { ideas },
    cartography,
  };

  // Garde anti-secret sur l'ensemble sérialisé (hors fichiers .md déjà scrubés).
  const serialized = JSON.stringify(snapshot);
  const secretHits = scanForSecrets(serialized);
  if (secretHits.length) {
    for (const h of secretHits)
      report.warnings.push(`SECRET POTENTIEL [${h.pattern}]: ${h.sample}`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    version: 1,
    counts: {
      projects: projects.length,
      knowledgeFiles: knowledgeIndex.length,
      ideas: ideas.length,
      cartography: cartography ? 1 : 0,
    },
    redactions: report.redactions,
    filteredNoisyProjects: report.filtered.noisyProjects,
    hash: crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 16),
  };

  // --- Écriture ---
  if (!FLAGS.dryRun) {
    fs.writeFileSync(
      path.join(OUT_DIR, "projects.json"),
      JSON.stringify({ projects }, null, 2)
    );
    fs.writeFileSync(path.join(OUT_DIR, "ideas.json"), JSON.stringify({ ideas }, null, 2));
    if (cartography)
      fs.writeFileSync(
        path.join(OUT_DIR, "cartography.json"),
        JSON.stringify(cartography, null, 2)
      );
    fs.writeFileSync(
      path.join(OUT_DIR, "knowledge-index.json"),
      JSON.stringify({ files: knowledgeIndex }, null, 2)
    );
    fs.writeFileSync(path.join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  // --- Rapport ---
  console.log("");
  console.log(`WikiChat memory export ${FLAGS.dryRun ? "(DRY-RUN — rien écrit)" : ""}`);
  console.log("-".repeat(52));
  console.log(`  Source        : ${WIKICHAT_DIR}`);
  console.log(`  Staging       : ${FLAGS.dryRun ? "(n/a)" : OUT_DIR}`);
  console.log(`  Projets       : ${manifest.counts.projects} retenus, ${report.filtered.noisyProjects} filtrés (bruit)`);
  console.log(`  Knowledge     : ${manifest.counts.knowledgeFiles} fichiers .md`);
  console.log(`  Idées         : ${manifest.counts.ideas}`);
  console.log(`  Cartographie  : ${cartography ? "1 (dernière)" : "absente"}`);
  console.log(`  Redactions    : ${report.redactions} champ(s) sensible(s) retiré(s)`);
  console.log(`  Hash snapshot : ${manifest.hash}`);
  console.log("-".repeat(52));

  if (report.warnings.length) {
    console.error("  ATTENTION — secrets potentiels détectés :");
    for (const w of report.warnings) console.error(`    ! ${w}`);
    console.error("  Export bloqué tant que ces motifs ne sont pas traités.");
    process.exit(2);
  }
  console.log("  Sanitisation OK — 0 secret détecté dans le snapshot.");
}

main();
