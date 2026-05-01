#!/usr/bin/env node
/**
 * install-claude-overlay.mjs — Install the WikiChat Claude Code overlay.
 *
 * Copies the skill + slash commands from `templates/.claude-overlay/` into
 * the user's `~/.claude/` directory (or a project-local `.claude/` if --project
 * flag is passed).
 *
 * The overlay adds an UX layer on top of the WikiChat MCP server :
 *   - skills/wikichat/SKILL.md : auto-loaded brief that explains wikichat
 *     when the MCP tools are detected in a session
 *   - commands/wikichat-init.md : /wikichat-init slash command
 *   - commands/sk.md : /sk <query> shortcut for search_knowledge
 *   - commands/close-project.md : /close-project wrapper
 *   - commands/wikichat-status.md : /wikichat-status health overview
 *
 * Idempotent : re-running overwrites existing files (with --force) or skips
 * them otherwise.
 *
 * Usage:
 *   node scripts/install-claude-overlay.mjs            # install to ~/.claude/
 *   node scripts/install-claude-overlay.mjs --project  # install to ./.claude/
 *   node scripts/install-claude-overlay.mjs --force    # overwrite existing
 *   node scripts/install-claude-overlay.mjs --dry-run  # preview only
 */

import os from "os";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const TEMPLATE_DIR = path.join(REPO_ROOT, "templates", ".claude-overlay");

const PROJECT_MODE = process.argv.includes("--project");
const FORCE = process.argv.includes("--force");
const DRY_RUN = process.argv.includes("--dry-run");

const TARGET_BASE = PROJECT_MODE
  ? path.resolve(process.cwd(), ".claude")
  : path.join(os.homedir(), ".claude");

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }
function ok(msg) { console.log(`✅ ${msg}`); }
function info(msg) { console.log(`   ${msg}`); }

if (!fs.existsSync(TEMPLATE_DIR)) {
  fail(`Template dir not found: ${TEMPLATE_DIR}\nRun this from the wikichat repo root.`);
}

console.log(`📦 Installing WikiChat Claude overlay`);
console.log(`   Source : ${TEMPLATE_DIR}`);
console.log(`   Target : ${TARGET_BASE}  (${PROJECT_MODE ? "project-local" : "user-level"})`);
if (DRY_RUN) console.log(`   Mode   : DRY RUN (no files written)`);
if (FORCE) console.log(`   Mode   : FORCE (overwrite existing)`);
console.log("");

// Recursive copy with skip-or-overwrite logic
function copyDir(src, dst) {
  if (!DRY_RUN) fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else if (entry.isFile()) {
      const exists = fs.existsSync(dstPath);
      const action = exists ? (FORCE ? "overwrite" : "skip") : "create";
      const relTarget = path.relative(TARGET_BASE, dstPath);
      info(`${action.padEnd(10)} ${relTarget}`);
      if (!DRY_RUN && (action !== "skip")) {
        fs.copyFileSync(srcPath, dstPath);
      }
    }
  }
}

copyDir(TEMPLATE_DIR, TARGET_BASE);

console.log("");
ok(`Overlay installed.`);
console.log(`   Skills : ${path.join(TARGET_BASE, "skills/wikichat/SKILL.md")}`);
console.log(`   Commands : ${path.join(TARGET_BASE, "commands/")}*.md`);
console.log("");
console.log("📖 Available slash commands :");
console.log("   /wikichat-init    — auto-onboarding (register + declare + briefing)");
console.log("   /sk <query>       — search knowledge across all projects");
console.log("   /close-project    — structured project closure");
console.log("   /wikichat-status  — service health + your session info");
console.log("");
console.log("💡 The skill auto-activates when wikichat MCP tools are detected in a session.");
console.log("   No further setup needed — just open Claude Code in any project with wikichat MCP attached.");
