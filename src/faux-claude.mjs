/**
 * faux-claude.mjs — Joue le rôle de Claude Code face aux hooks, pour les tests.
 *
 * Lit les hooks INSTALLÉS dans `<home>/.claude/settings.json` (donc ce que
 * l'installateur a réellement écrit), et les lance comme Claude Code le fait :
 * commande passée au shell, entrée JSON sur stdin, variables d'environnement
 * de la session (CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_ENTRYPOINT…), délai du
 * hook. Les hooks `asyncRewake` partent en arrière-plan ; leur code de sortie
 * (2 = réveil) et leur stderr sont rendus quand ils finissent.
 *
 * Pas de modèle : on vérifie ce que les hooks rendent, pas ce qu'en ferait Claude.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";

export function lireHooks(home) {
  const f = path.join(home, ".claude", "settings.json");
  return JSON.parse(fs.readFileSync(f, "utf8")).hooks || {};
}

/** Le matcher d'un groupe accepte-t-il cette valeur ? (vide, *, alternatives | ) */
function accepte(matcher, valeur) {
  if (!matcher || matcher === "*") return true;
  if (valeur == null) return true;
  return String(matcher).split(/[|,]/).map(s => s.trim()).includes(String(valeur));
}

function lancer(commande, entree, env, delaiS) {
  const t0 = process.hrtime.bigint();
  return new Promise((resolve) => {
    const p = spawn(commande, { shell: true, env, windowsHide: true });
    let stdout = "", stderr = "";
    p.stdout.on("data", d => { stdout += d; });
    p.stderr.on("data", d => { stderr += d; });
    const t = setTimeout(() => { try { p.kill(); } catch { /* */ } }, (delaiS || 600) * 1000);
    p.on("close", (code) => {
      clearTimeout(t);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      let sortie = null;
      const s = stdout.trim();
      if (s.startsWith("{") && s.endsWith("}")) { try { sortie = JSON.parse(s); } catch { /* texte */ } }
      resolve({ commande, code, stdout, stderr, sortie, ms, taille: stdout.length });
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(entree));
  });
}

/**
 * Déclenche un événement comme Claude Code.
 * @param {string} home dossier personnel qui porte .claude/settings.json
 * @param {string} evenement SessionStart | UserPromptSubmit | Stop | SessionEnd
 * @param {object} entree entrée JSON du hook (session_id, cwd, source…)
 * @param {{ env?: object, valeurMatcher?: string }} o
 * @returns {Promise<{ sync: object[], async: Promise<object>[] }>}
 */
export async function declencher(home, evenement, entree, { env = {}, valeurMatcher = null } = {}) {
  const groupes = lireHooks(home)[evenement] || [];
  const envHook = {
    ...process.env,
    HOME: home, USERPROFILE: home,
    CLAUDE_CODE_SESSION_ID: entree.session_id,
    CLAUDE_PROJECT_DIR: entree.cwd,
    ...env,
  };
  const complete = { hook_event_name: evenement, transcript_path: path.join(home, "t.jsonl"), permission_mode: "default", ...entree };
  const sync = [], asynchrones = [];
  for (const g of groupes) {
    if (!accepte(g.matcher, valeurMatcher)) continue;
    for (const h of g.hooks || []) {
      if (h.type !== "command") continue;
      const p = lancer(h.command, complete, envHook, h.timeout);
      if (h.async || h.asyncRewake) asynchrones.push(p.then(r => ({ ...r, asyncRewake: !!h.asyncRewake })));
      else sync.push(p);
    }
  }
  return { sync: await Promise.all(sync), async: asynchrones };
}

/** Le texte que Claude verrait (additionalContext, reason ou stdout brut). */
export function texteInjecte(r) {
  if (!r) return "";
  const s = r.sortie;
  if (s) return s.hookSpecificOutput?.additionalContext || s.reason || "";
  return r.stdout.trim();
}
