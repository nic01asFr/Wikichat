/**
 * memory-publish-hook.mjs — déclencheur de la publication mémoire (brique 2).
 *
 * Opt-in et non-bloquant : si WIKICHAT_MEMORY_REPO n'est pas défini, no-op
 * silencieux (aucun couplage forcé avec le pipeline de consultation distante).
 * Sinon, lance scripts/publish-memory.mjs en processus détaché — la réponse du
 * tool appelant n'attend jamais le push.
 */

import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLISH_SCRIPT = path.join(__dirname, "..", "scripts", "publish-memory.mjs");

/**
 * Déclenche une publication mémoire détachée si configurée.
 * @param {string} reason - contexte pour les logs (ex: "close_project:Foo").
 * @returns {boolean} true si une publication a été lancée, false si no-op.
 */
export function triggerMemoryPublish(reason = "manual") {
  const repo = process.env.WIKICHAT_MEMORY_REPO;
  if (!repo) return false;

  try {
    const child = spawn(process.execPath, [PUBLISH_SCRIPT, "--repo", repo], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    console.log(`[memory-hook] Publication déclenchée (${reason}) -> ${repo}`);
    return true;
  } catch (err) {
    console.error(`[memory-hook] Échec déclenchement (${reason}): ${err.message}`);
    return false;
  }
}
