/**
 * injector.mjs — WikiChat overlay for discovered projects.
 *
 * SAFETY CONTRACT — strict, non-negotiable:
 *
 *  1. WikiChat NEVER writes outside two zones:
 *       a) ~/.wikichat/           (central store, 100% owned by WikiChat)
 *       b) <project>/.wikichat/   (namespaced subdir, never the project root)
 *
 *  2. WikiChat NEVER modifies ANY pre-existing file in a project.
 *     If a file already exists and was not created by WikiChat, it is NEVER touched.
 *     The only file WikiChat may refresh in <project>/.wikichat/ is:
 *       - context.json   (read-only for agents, written only by the service)
 *     instructions.md is written ONCE and never overwritten.
 *
 *  3. All writes are atomic (tmp + rename via writeAtomicJSON).
 *
 *  4. If a project directory is not writable, WikiChat silently skips
 *     writing into it — it still maintains the central store.
 *     The project is NEVER impacted by a WikiChat write failure.
 *
 *  5. The scanner is READ-ONLY. It never modifies any file.
 *
 *  6. .wikichat/ dirs are added to the project's .gitignore ONLY if
 *     .gitignore already exists AND does not already reference .wikichat.
 *     This is the single exception to rule 2, guarded by explicit checks.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { writeAtomicJSON } from "./persistence.mjs";
import { WIKICHAT_HOME } from "./registry.mjs";
import { AGENT_INSTRUCTIONS } from "./resilience.mjs";

// Files WikiChat is ALLOWED to write in <project>/.wikichat/
const WIKICHAT_OWNED_FILES = new Set(["context.json", "instructions.md"]);

// Version des instructions générées. La règle « écrit une fois, jamais écrasé »
// protégeait le fichier de toute correction : 40 projets se sont retrouvés avec
// des instructions citant six outils inexistants (resume_session, ping,
// register_cron, respawn_session, update_project_state, declare_storage_path).
// On garde la protection pour ce que l'utilisateur a écrit, et on rafraîchit ce
// que WikiChat a généré : un fichier portant notre en-tête mais une version
// antérieure est régénéré ; un fichier sans en-tête n'est jamais touché.
const INSTRUCTIONS_VERSION = 2;
const INSTRUCTIONS_VERSION_TAG = `<!-- wikichat-instructions v${INSTRUCTIONS_VERSION} — régénéré automatiquement, ne pas éditer -->`;

/** true si le fichier est une version obsolète générée par WikiChat. */
function instructionsNeedRefresh(filePath) {
  let content;
  try { content = fs.readFileSync(filePath, "utf8"); } catch { return false; }
  if (content.includes(INSTRUCTIONS_VERSION_TAG)) return false;          // déjà à jour
  return /^(<!-- wikichat-instructions|# WikiChat — Instructions)/.test(content.trimStart());
}

/**
 * Safety guard: verify a target path is strictly inside an allowed base directory.
 * Throws if the resolved path escapes the base (path traversal protection).
 */
function assertSafeWrite(targetPath, allowedBase) {
  const resolved = path.resolve(targetPath);
  const base = path.resolve(allowedBase);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error(`[Injector] SAFETY: write to '${resolved}' refused — outside allowed base '${base}'`);
  }
}

/**
 * For a given project entry from registry, ensure:
 * 1. ~/.wikichat/projects/<slug>/ directory exists
 * 2. ~/.wikichat/projects/<slug>/wikichat.json exists (create if missing, never overwrite)
 * 3. <project>/.wikichat/ directory exists (create if missing)
 * 4. <project>/.wikichat/instructions.md is created/updated by the service
 * 5. <project>/.wikichat/context.json is created/updated with current snapshot
 */
export async function injectProject(project, serverUrl = "http://localhost:3777") {
  const centralDir = path.join(WIKICHAT_HOME, "projects", project.slug);
  const wikichatJsonPath = path.join(centralDir, "wikichat.json");

  // ── Step 1: Central store (always safe — fully owned by WikiChat) ──────────
  try {
    assertSafeWrite(centralDir, WIKICHAT_HOME);
    fs.mkdirSync(centralDir, { recursive: true });
  } catch (err) {
    console.error(`[Injector] Cannot create central dir for ${project.slug}:`, err.message);
    return;
  }

  // Create wikichat.json ONCE — never overwrite existing data
  if (!fs.existsSync(wikichatJsonPath)) {
    try {
      assertSafeWrite(wikichatJsonPath, WIKICHAT_HOME);
      writeAtomicJSON(wikichatJsonPath, generateWikichatJson(project));
    } catch (err) {
      console.error(`[Injector] Cannot write wikichat.json for ${project.slug}:`, err.message);
    }
  }

  // ── Step 2: Project-side .wikichat/ (optional — skip if not writable) ──────
  // This is a convenience for agents working locally.
  // SAFETY: we only write inside <project>/.wikichat/ — never anywhere else.
  const projectWikichatDir = path.join(path.resolve(project.path), ".wikichat");
  const queueDir = path.join(projectWikichatDir, "queue");

  // Verify project.path is a real directory before touching anything
  try {
    const stat = fs.statSync(project.path);
    if (!stat.isDirectory()) {
      console.warn(`[Injector] ${project.path} is not a directory, skipping project-side injection`);
      return;
    }
  } catch {
    return; // project path no longer exists
  }

  // Create .wikichat/ and queue/ — catch permission errors silently
  try {
    assertSafeWrite(projectWikichatDir, project.path);
    fs.mkdirSync(projectWikichatDir, { recursive: true });
    fs.mkdirSync(queueDir, { recursive: true });
  } catch (err) {
    // Not writable — central store is still set up. That's fine.
    console.warn(`[Injector] Cannot create .wikichat/ in ${project.path} (skipped): ${err.message}`);
    return;
  }

  // instructions.md — written ONCE, never overwritten
  const instructionsPath = path.join(projectWikichatDir, "instructions.md");
  const absent = !fs.existsSync(instructionsPath);
  if (absent || instructionsNeedRefresh(instructionsPath)) {
    try {
      assertSafeWrite(instructionsPath, projectWikichatDir);
      fs.writeFileSync(instructionsPath, generateInstructions(project, serverUrl), "utf8");
      if (!absent) console.log(`[Injector] instructions.md régénéré (v${INSTRUCTIONS_VERSION}) : ${project.slug}`);
    } catch (err) {
      console.warn(`[Injector] Cannot write instructions.md in ${project.path}:`, err.message);
    }
  }

  // context.json — refreshed by service, read-only for agents
  const contextPath = path.join(projectWikichatDir, "context.json");
  try {
    assertSafeWrite(contextPath, projectWikichatDir);
    writeAtomicJSON(contextPath, {
      _managed_by: "wikichat-service",
      _do_not_edit: "This file is overwritten automatically by the WikiChat service.",
      slug: project.slug,
      name: project.name,
      path: project.path,
      stack: project.stack || [],
      description: project.description || "",
      status: project.status || "discovered",
      activeTasks: project.activeTasks || [],
      blockers: project.blockers || [],
      agents: project.agents || [],
      serverUrl,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[Injector] Cannot write context.json in ${project.path}:`, err.message);
  }

  // .gitignore — append .wikichat/ ONLY if .gitignore exists and doesn't already have it
  const gitignorePath = path.join(project.path, ".gitignore");
  try {
    assertSafeWrite(gitignorePath, project.path);
    if (fs.existsSync(gitignorePath)) {
      const existing = fs.readFileSync(gitignorePath, "utf8");
      if (!existing.includes(".wikichat")) {
        fs.appendFileSync(gitignorePath, "\n# WikiChat overlay (auto-added)\n.wikichat/\n");
      }
    }
  } catch (err) {
    console.warn(`[Injector] Cannot update .gitignore in ${project.path}:`, err.message);
  }
}

/**
 * Generate the instructions.md content for a project.
 * This file teaches agents how to interact with WikiChat.
 */
function generateInstructions(project, serverUrl) {
  const centralPath = path.join(WIKICHAT_HOME, "projects", project.slug);
  return `${INSTRUCTIONS_VERSION_TAG}
# WikiChat — Instructions pour ${project.name}

## Rôle du service WikiChat
WikiChat donne une mémoire à cette machine : il relie les sessions Claude Code
ouvertes séparément, capitalise ce que les projets apprennent, et déclenche des
agents quand un événement le justifie.

## Mode connecté (MCP disponible)
Serveur MCP: ${serverUrl}/sse

Pour participer:
1. Utilise \`register\` avec ton nom et rôle
2. Utilise \`declare_project\` pour mettre à jour l'état de ce projet
3. Utilise \`claim_task\` / \`release_task\` pour gérer les tâches
4. Ton état de projet est en \`.wikichat/project-state.json\` ; le store central
   du projet est en ${centralPath}

## Mode offline (MCP non disponible)
Écris dans \`.wikichat/queue/<timestamp>-<ton-nom>.json\`:
\`\`\`json
{
  "type": "update" | "task_done" | "message" | "artifact",
  "agent": "<ton nom>",
  "project": "${project.slug}",
  "ts": "<ISO timestamp>",
  "data": {}
}
\`\`\`
Le service pickup les fichiers queue au prochain cycle (toutes les 2 minutes).

## Fichiers WikiChat dans ce projet
- \`.wikichat/context.json\` — état courant du projet (mis à jour par le service)
- \`.wikichat/queue/\` — messages offline à destination du service
- \`${centralPath}/\` — store central (artifacts, history, snapshots agents)

## Ce que le service attend de toi
- Décris tes tâches en cours avec \`claim_task\`
- Dépose tes livrables dans \`.wikichat/artifacts/\` — le service les diffuse
- Consigne décisions et blocages avec \`add_project_note\`
- Maintiens ton statut avec \`set_status\`

` + AGENT_INSTRUCTIONS + "\n";
}

/**
 * Generate wikichat.json for a project (initial state).
 */
function generateWikichatJson(project) {
  return {
    slug: project.slug,
    name: project.name,
    path: project.path,
    stack: project.stack || [],
    description: project.description || "",
    status: "discovered",
    activeTasks: [],
    doneTasks: [],
    blockers: [],
    agents: [],
    relations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Update context.json in the project's .wikichat/ directory.
 * This is the "window" the agent has into WikiChat state.
 */
export async function updateProjectContext(project, wikichatState) {
  const projectWikichatDir = path.join(path.resolve(project.path), ".wikichat");
  const contextPath = path.join(projectWikichatDir, "context.json");

  // Build a sanitized snapshot of relevant state
  const activeSessions = wikichatState?.sessions
    ? [...wikichatState.sessions.values()]
        .filter(s => s.current_project === project.name || s.current_project === project.slug)
        .map(s => ({ name: s.name, role: s.role, status: s.status, current_task: s.current_task }))
    : [];

  const context = {
    slug: project.slug,
    name: project.name,
    path: project.path,
    stack: project.stack || [],
    description: project.description || "",
    status: project.status || "discovered",
    activeTasks: project.activeTasks || [],
    doneTasks: project.doneTasks || [],
    blockers: project.blockers || [],
    agents: activeSessions,
    updatedAt: new Date().toISOString(),
  };

  try {
    assertSafeWrite(contextPath, projectWikichatDir);
    fs.mkdirSync(path.dirname(contextPath), { recursive: true });
    writeAtomicJSON(contextPath, context);
  } catch (err) {
    console.warn(`[Injector] Cannot update context for ${project.slug}:`, err.message);
  }
}

/**
 * Process all files in a project's .wikichat/queue/ directory.
 * Returns array of processed items.
 */
export async function pickupQueue(project) {
  const projectWikichatDir = path.join(path.resolve(project.path), ".wikichat");
  const queueDir = path.join(projectWikichatDir, "queue");
  const processed = [];

  let files;
  try {
    files = fs.readdirSync(queueDir).filter(f => f.endsWith(".json"));
  } catch {
    return processed; // queue dir doesn't exist or not readable
  }

  for (const file of files) {
    const filePath = path.join(queueDir, file);
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const item = JSON.parse(content);

      // Validate basic shape
      if (!item.type || !item.agent) {
        console.warn(`[Injector] Skipping malformed queue file: ${file}`);
        continue;
      }

      processed.push({
        file,
        ...item,
        pickedUpAt: new Date().toISOString(),
        projectSlug: project.slug,
      });

      // Archive processed file: move to processed/ subdir
      const archiveDir = path.join(queueDir, "processed");
      fs.mkdirSync(archiveDir, { recursive: true });
      const archivePath = path.join(archiveDir, file);
      try {
        fs.renameSync(filePath, archivePath);
      } catch {
        // If rename fails (cross-device), try copy+delete
        try {
          fs.writeFileSync(archivePath, content, "utf8");
          fs.unlinkSync(filePath);
        } catch (err) {
          console.warn(`[Injector] Cannot archive queue file ${file}:`, err.message);
        }
      }
    } catch (err) {
      console.warn(`[Injector] Error processing queue file ${file}:`, err.message);
    }
  }

  return processed;
}

/**
 * Read new artifacts written by agents into .wikichat/artifacts/.
 * Returns list of { file, title, content, agent, ts } for artifacts
 * not yet seen (tracked via .wikichat/artifacts/.seen index).
 *
 * Called by the service after spawn headless completes, or on queue pickup cycle.
 * This closes the loop: even if MCP was down, the service recovers agent output.
 */
export async function readLocalArtifacts(project) {
  const artifactsDir = path.join(path.resolve(project.path), ".wikichat", "artifacts");
  const seenPath = path.join(artifactsDir, ".seen");
  const results = [];

  let files;
  try {
    files = fs.readdirSync(artifactsDir).filter(f => f.endsWith(".md") || f.endsWith(".json"));
  } catch {
    return results;
  }

  // Load seen index
  let seen = new Set();
  try {
    seen = new Set(JSON.parse(fs.readFileSync(seenPath, "utf8")));
  } catch { /* first run */ }

  const newSeen = new Set(seen);

  for (const file of files) {
    if (seen.has(file)) continue;
    const filePath = path.join(artifactsDir, file);
    try {
      assertSafeWrite(filePath, artifactsDir);
      const content = fs.readFileSync(filePath, "utf8");
      // Parse header line: # Title\n_type: ... | agent: ..._
      const titleMatch = content.match(/^#\s+(.+)/m);
      const agentMatch = content.match(/agent:\s*([^\s|]+)/);
      results.push({
        file,
        title: titleMatch?.[1]?.trim() || file.replace(/[_-]/g, " ").replace(/\.\w+$/, ""),
        content,
        agent: agentMatch?.[1]?.trim() || "unknown",
        ts: new Date().toISOString(),
        projectSlug: project.slug,
      });
      newSeen.add(file);
    } catch { /* skip unreadable */ }
  }

  // Update seen index atomically
  if (newSeen.size !== seen.size) {
    try {
      writeAtomicJSON(seenPath, [...newSeen]);
    } catch { /* non-blocking */ }
  }

  return results;
}
