/**
 * overlay-installer.mjs — Auto-install the Claude Code overlay (skill +
 * slash commands + CLAUDE.md insertions) so agents naturally use wikichat.
 *
 * Two scopes :
 *   1. USER level (~/.claude/) : skill + commands + CLAUDE.md global section.
 *      Done ONCE at first server boot. Idempotent via marker file.
 *   2. PROJECT level (<project>/CLAUDE.md) : insert a wikichat reminder
 *      block. Done at injector.mjs:injectProject() time, idempotent via
 *      marker comments inside the file.
 *
 * **Safety guarantees** :
 *   - NEVER deletes or modifies existing user content.
 *   - Uses HTML comment markers `<!-- wikichat:auto-injected:start -->` /
 *     `<!-- wikichat:auto-injected:end -->` for idempotency.
 *   - If markers already present : skip silently.
 *   - If file absent : create with our content only.
 *   - If file exists : append our marked block to the end.
 *
 * Disable mechanisms :
 *   - WIKICHAT_NO_OVERLAY_INSTALL=1 : skip user-level setup
 *   - WIKICHAT_NO_PROJECT_CLAUDE_MD=1 : skip per-project CLAUDE.md augment
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.resolve(__dirname, "..", "templates", ".claude-overlay");
const USER_CLAUDE_DIR = path.join(os.homedir(), ".claude");
const USER_CLAUDE_MD = path.join(USER_CLAUDE_DIR, "CLAUDE.md");
const MARKER_FILE = path.join(USER_CLAUDE_DIR, ".wikichat-overlay-installed");

const BLOCK_START = "<!-- wikichat:auto-injected:start -->";
const BLOCK_END = "<!-- wikichat:auto-injected:end -->";

const USER_CLAUDE_MD_BLOCK = `
${BLOCK_START}
## WikiChat — coordination locale (auto-injected)

Si tu vois des tools \`mcp__wikichat__*\` disponibles dans cette session, WikiChat est attaché.
C'est un coordinateur local multi-agents qui te donne accès à :

- **Mémoire transverse** des projets passés (\`mcp__wikichat__search_knowledge\`)
- **Coordination** avec d'autres sessions Claude Code actives (channels, DMs)
- **Spawn de sous-agents** headless pour déléguer des tâches bornées
- **Persistance** : tasks, decisions, closures par projet

**Réflexes attendus** :
1. Au début de session : \`mcp__wikichat__register(name=<nom>, role=<rôle>)\` puis \`mcp__wikichat__get_briefing()\`. Le name doit être non-anonyme pour activer la dormant gate.
2. Avant d'implémenter un pattern (auth, state, widget, etc.) : \`mcp__wikichat__search_knowledge(query=<topic>)\`. Évite de re-dériver ce qui existe déjà dans \`~/.wikichat/knowledge/<topic>-axis.md\`.
3. À la clôture du projet : \`mcp__wikichat__close_project(project=<name>, auto=true)\` — produit une closure structurée + capitalisation auto dans la KB transverse.

**Protocole over/standby** — quand tu envoies un message, précise l'intention pour éviter les polls inutiles :
- status="over" + expects_reply=true → tu as fini, tu attends une réponse
- status="standby" + eta_seconds=300 → tu travailles 5min, ne pas attendre
- status="done" → tâche terminée, aucune réponse attendue

**Lire les messages sans poll MCP bloquant** (bash, 0 tokens) :
curl -s "http://localhost:3777/api/messages?channel=<ch>&since_minutes=5"

**Slash commands disponibles** : \`/wikichat-init\` (auto-onboarding), \`/sk <query>\` (search rapide), \`/close-project\`, \`/wikichat-status\`.

Ce bloc est auto-géré par WikiChat. Pour le retirer : supprime entre les balises markers ci-dessus.
${BLOCK_END}
`.trimStart();

const PROJECT_CLAUDE_MD_BLOCK = `
${BLOCK_START}
## WikiChat (coordinator local attaché)

Ce projet a un overlay \`.wikichat/\` géré. Tools \`mcp__wikichat__*\` disponibles si serveur lancé.
Réflexes : \`register\` au début, \`search_knowledge\` avant de coder un pattern, \`close_project\` à la fin.
Détails dans \`~/.claude/CLAUDE.md\` ou via le skill \`wikichat\` auto-loadé.
${BLOCK_END}
`.trimStart();

// ── USER-LEVEL : skill + commands + ~/.claude/CLAUDE.md ─────────────────────

export function ensureUserOverlay({ force = false, log = console.log } = {}) {
  if (process.env.WIKICHAT_NO_OVERLAY_INSTALL === "1") return { skipped: "disabled" };
  if (!fs.existsSync(TEMPLATE_DIR)) return { skipped: "no-templates" };

  const result = { filesAdded: 0, claudeMdAction: "skip" };

  // 1. Copy skill + slash commands (skip files that already exist — preserves user customization)
  if (force || !fs.existsSync(MARKER_FILE)) {
    function copyDir(src, dst) {
      fs.mkdirSync(dst, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const dstPath = path.join(dst, entry.name);
        if (entry.isDirectory()) {
          copyDir(srcPath, dstPath);
        } else if (entry.isFile() && !fs.existsSync(dstPath)) {
          fs.copyFileSync(srcPath, dstPath);
          result.filesAdded++;
        }
      }
    }
    try {
      copyDir(TEMPLATE_DIR, USER_CLAUDE_DIR);
    } catch (err) {
      log(`[overlay] Copy failed: ${err.message}`);
      return { error: err.message };
    }
  }

  // 2. Append to ~/.claude/CLAUDE.md (or create) — only if our marker isn't already there
  try {
    let existing = "";
    if (fs.existsSync(USER_CLAUDE_MD)) {
      existing = fs.readFileSync(USER_CLAUDE_MD, "utf8");
    }
    if (existing.includes(BLOCK_START)) {
      result.claudeMdAction = "already-present";
    } else {
      fs.mkdirSync(USER_CLAUDE_DIR, { recursive: true });
      const newContent = existing
        ? existing.replace(/\s*$/, "\n\n") + USER_CLAUDE_MD_BLOCK
        : `# Claude Code — instructions globales\n\n${USER_CLAUDE_MD_BLOCK}`;
      fs.writeFileSync(USER_CLAUDE_MD, newContent);
      result.claudeMdAction = existing ? "appended" : "created";
    }
  } catch (err) {
    log(`[overlay] CLAUDE.md update failed: ${err.message}`);
  }

  // 3. Marker file
  try { fs.writeFileSync(MARKER_FILE, new Date().toISOString()); } catch { /* */ }

  if (result.filesAdded > 0 || result.claudeMdAction === "created" || result.claudeMdAction === "appended") {
    log(`[overlay] User overlay : ${result.filesAdded} file(s) added, CLAUDE.md ${result.claudeMdAction}`);
  }
  return result;
}

// ── PROJECT-LEVEL : opt-in manual only ─────────────────────────────────────
// NOTE : par contrat de sûreté de injector.mjs, WikiChat n'écrit JAMAIS en
// dehors de .wikichat/ dans un projet. Donc on n'auto-augmente PAS les
// <project>/CLAUDE.md. La couverture est assurée par :
//   1. ~/.claude/CLAUDE.md (instructions globales, append idempotent)
//   2. ~/.claude/skills/wikichat/SKILL.md (auto-loadé quand MCP détecté)
//
// Si l'utilisateur veut quand même injecter dans un projet spécifique, il
// peut appeler ensureProjectClaudeMd() manuellement — mais ce n'est PAS
// fait automatiquement.

export function ensureProjectClaudeMd(projectPath, { log = console.log } = {}) {
  // Opt-in only. Pas appelé depuis injector. Respecte le contrat de sûreté.
  if (!projectPath || !fs.existsSync(projectPath)) return { skipped: "no-path" };
  const claudeMdPath = path.join(projectPath, "CLAUDE.md");
  try {
    let existing = "";
    if (fs.existsSync(claudeMdPath)) existing = fs.readFileSync(claudeMdPath, "utf8");
    if (existing.includes(BLOCK_START)) return { action: "already-present" };
    if (existing) {
      fs.writeFileSync(claudeMdPath, existing.replace(/\s*$/, "\n\n") + PROJECT_CLAUDE_MD_BLOCK);
      return { action: "appended" };
    }
    return { skipped: "no-claude-md" };
  } catch (err) {
    log(`[overlay] Project CLAUDE.md augment failed: ${err.message}`);
    return { error: err.message };
  }
}
