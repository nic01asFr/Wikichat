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
/** Chemin absolu du guetteur de boîte, cité dans les instructions distribuées. */
const GUETTEUR = path.resolve(__dirname, "..", "scripts", "wikichat-attendre-courrier.mjs").split(path.sep).join("/");

const BLOCK_START = "<!-- wikichat:auto-injected:start -->";
const BLOCK_END = "<!-- wikichat:auto-injected:end -->";

/**
 * Le bloc de ~/.claude/CLAUDE.md ne dit que ce qui est vrai sur TOUTES les
 * surfaces (Atelier, VS Code, terminal, processus lancés par wikichat).
 *
 * Il exigeait un `register` au début de chaque session : faux pour un agent
 * lancé par wikichat, dont l'identité voyage avec la connexion (WIKICHAT_AGENT
 * → `?agent=`), et contradictoire avec l'Atelier, qui dit de ne pas l'appeler.
 * Il citait aussi un chemin de guetteur et des commandes propres à une machine.
 * Le détail vit dans la skill `wikichat`, chargée quand les outils sont là.
 */
const USER_CLAUDE_MD_BLOCK = `
${BLOCK_START}
## WikiChat — coordination locale (auto-injected)

Si des outils \`mcp__wikichat__*\` sont présents, WikiChat (coordinateur multi-agents local) est attaché.

- **Identité** : elle est portée par la connexion (\`WIKICHAT_AGENT\`, ou nom dérivé de la conversation). N'appelle pas \`register\` pour te présenter ; seulement si \`get_briefing()\` te montre anonyme (\`session-…\`) et qu'un nom t'a été donné.
- **Avant d'implémenter un pattern** (auth, état, widget…) : \`mcp__wikichat__search_knowledge(query=<sujet>)\` — ne redérive pas ce qui est déjà capitalisé.

**Protocole over/standby** — ces champs pilotent la tenue du lien entre deux agents ; le hook de fin de tour les lit :
- status="over" + expects_reply=true → tu as fini, tu attends une réponse ; le lien reste ouvert
- status="standby" + eta_seconds=300 → tu pars travailler 5 min ; ton interlocuteur t'attend jusque-là
- status="done" → tâche terminée, aucune réponse attendue ; le lien se referme

Annonce toujours un \`eta_seconds\` quand tu pars sur une tâche longue : sans lui, l'autre rend la main au bout de 45 s.

Le reste (canaux, guetteur de courrier, clôture de projet, reprise d'équipe, commandes) : skill \`wikichat\`.

Ce bloc est auto-géré par WikiChat. Pour le retirer : supprime entre les balises markers ci-dessus.
${BLOCK_END}
`.trimStart();

const PROJECT_CLAUDE_MD_BLOCK = `
${BLOCK_START}
## WikiChat (coordinator local attaché)

Ce projet a un overlay \`.wikichat/\` géré. Tools \`mcp__wikichat__*\` disponibles si serveur lancé.
Identité portée par la connexion (pas de \`register\` à faire) ; \`search_knowledge\` avant de coder un pattern, \`close_project\` à la fin.
Détails dans \`~/.claude/CLAUDE.md\` ou via le skill \`wikichat\` auto-loadé.
${BLOCK_END}
`.trimStart();

// ── USER-LEVEL : skill + commands + ~/.claude/CLAUDE.md ─────────────────────

/**
 * Installe le Stop hook « boîte mail » dans ~/.claude/settings.json.
 *
 * C'est la pièce qui fait qu'un agent en session reçoit ce qu'on lui adresse
 * sans avoir à poller : à la fin de chaque tour, le hook demande au service s'il
 * a du courrier et, le cas échéant, empêche l'arrêt le temps qu'il réponde.
 *
 * Elle n'était installée nulle part — elle avait été branchée à la main sur la
 * machine de développement, si bien que toute la coordination reposait sur un
 * réglage qu'une installation neuve n'aurait jamais eu.
 *
 * Idempotent, et non destructif : les autres hooks Stop déjà présents sont
 * conservés, et une entrée WikiChat existante est mise à jour plutôt que
 * dupliquée (le chemin du dépôt peut avoir changé).
 */
function ensureMailboxHook(log = console.log) {
  const settingsPath = path.join(USER_CLAUDE_DIR, "settings.json");
  const hookPath = path.resolve(__dirname, "..", "scripts", "wikichat-mailbox-hook.mjs");
  if (!fs.existsSync(hookPath)) return "no-hook-script";
  const command = `node "${hookPath.replace(/\\/g, "/")}"`;

  try {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}");
    }
    settings.hooks = settings.hooks || {};
    const stops = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : [];

    const estLeNotre = h => typeof h?.command === "string" && h.command.includes("wikichat-mailbox-hook");
    for (const groupe of stops) {
      const entree = (groupe.hooks || []).find(estLeNotre);
      if (entree) {
        if (entree.command === command) return "already-present";
        entree.command = command; // dépôt déplacé : on recale le chemin
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        log("[overlay] Stop hook boîte mail : chemin mis à jour");
        return "updated";
      }
    }

    stops.push({ matcher: "", hooks: [{ type: "command", command }] });
    settings.hooks.Stop = stops;
    fs.mkdirSync(USER_CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    log("[overlay] Stop hook boîte mail installé — les agents reçoivent leur courrier en fin de tour");
    return "installed";
  } catch (err) {
    log(`[overlay] Stop hook non installé : ${err.message}`);
    return "failed";
  }
}

/** Copie un modèle en y remplaçant les chemins propres à cette installation. */
function ecrireModele(src, dst) {
  if (!/\.md$/i.test(src)) { fs.copyFileSync(src, dst); return; }
  const texte = fs.readFileSync(src, "utf8").split("{{GUETTEUR}}").join(GUETTEUR);
  fs.writeFileSync(dst, texte);
}

const VERSION_RE = /<!-- wikichat:skill-version (\d+) -->/;
function versionDe(texte) {
  const m = String(texte || "").match(VERSION_RE);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Remplace un fichier installé quand son modèle porte une version plus
 * récente (`<!-- wikichat:skill-version N -->`). La copie initiale ne touchait
 * jamais un fichier existant : la skill qui disait « register au début »
 * restait donc en place pour toujours. L'ancienne version est gardée en `.bak`.
 */
export function rafraichirVersionnes(src, dst, log = console.log) {
  let n = 0;
  if (!fs.existsSync(src)) return n;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) { n += rafraichirVersionnes(s, d, log); continue; }
    if (!entry.isFile() || !/\.md$/i.test(entry.name) || !fs.existsSync(d)) continue;
    try {
      const voulue = versionDe(fs.readFileSync(s, "utf8"));
      if (!voulue) continue;
      const installee = fs.readFileSync(d, "utf8");
      if (versionDe(installee) >= voulue) continue;
      fs.writeFileSync(d + ".bak", installee);
      ecrireModele(s, d);
      log(`[overlay] ${path.relative(dst, d) || entry.name} mis à jour (version ${voulue}), ancienne gardée en .bak`);
      n++;
    } catch (err) {
      log(`[overlay] ${entry.name} non rafraîchi : ${err.message}`);
    }
  }
  return n;
}

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
          ecrireModele(srcPath, dstPath);
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

  // 1b. Fichiers versionnés (skill wikichat) : rafraîchis même sur une
  // installation existante, sinon une consigne corrigée n'y arrive jamais.
  result.refreshed = rafraichirVersionnes(TEMPLATE_DIR, USER_CLAUDE_DIR, log);

  // 2. Append to ~/.claude/CLAUDE.md (or create) — only if our marker isn't already there
  try {
    let existing = "";
    if (fs.existsSync(USER_CLAUDE_MD)) {
      existing = fs.readFileSync(USER_CLAUDE_MD, "utf8");
    }
    if (existing.includes(BLOCK_START)) {
      // Le bloc est là — mais il peut dater. Il était posé une fois puis jamais
      // relu : une consigne corrigée ici ne rejoignait jamais les machines déjà
      // installées. On remplace ce qui est entre les marqueurs, et rien d'autre :
      // ce que l'utilisateur a écrit autour lui appartient.
      const debut = existing.indexOf(BLOCK_START);
      const fin = existing.indexOf(BLOCK_END);
      const actuel = fin > debut ? existing.slice(debut, fin + BLOCK_END.length) : null;
      const voulu = USER_CLAUDE_MD_BLOCK.trim();
      if (actuel && actuel.trim() !== voulu) {
        fs.writeFileSync(USER_CLAUDE_MD, existing.slice(0, debut) + voulu + existing.slice(fin + BLOCK_END.length));
        result.claudeMdAction = "refreshed";
      } else {
        result.claudeMdAction = "already-present";
      }
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

  // 3. Stop hook "boîte mail" dans ~/.claude/settings.json
  result.hookAction = ensureMailboxHook(log);

  // 4. Marker file
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
