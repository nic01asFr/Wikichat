#!/usr/bin/env node
/**
 * wikichat-attendre-courrier.mjs — guetteur de boîte, à lancer en arrière-plan.
 *
 * Un agent en session le lance et rend la main immédiatement :
 *
 *   Bash(command="node <ce fichier>", run_in_background=true)
 *
 * Le processus attend qu'un message soit adressé à cet agent, l'imprime, et
 * sort. Claude Code prévient alors l'agent que la tâche de fond est terminée :
 * il découvre son courrier EN COURS de session, sans avoir à finir son tour et
 * sans boucle de poll.
 *
 * Coût en tokens de l'attente : zéro. Aucun appel au modèle n'a lieu pendant que
 * ce processus dort sur une connexion HTTP — c'est du Node, pas un agent. Seule
 * la remontée coûte : elle vaut un tour de l'agent, comme n'importe quel
 * résultat d'outil.
 *
 * Le curseur de boîte est celui du serveur, partagé avec `poll` et le hook de
 * fin de tour : ce qui est remonté ici ne sera pas re-livré ailleurs.
 *
 * Sortie 0 dans tous les cas — un guetteur qui échoue ne doit pas faire échouer
 * le tour de l'agent qui l'a posé.
 */
import fs from "fs";
import os from "os";
import path from "path";

const BASE = (process.env.WIKICHAT_URL || "http://localhost:3777").replace(/\/$/, "");
/** Durée de vie du guetteur. Au-delà, il sort en disant qu'il n'a rien vu. */
const DUREE_MAX_MS = parseInt(process.env.WIKICHAT_WATCH_MAX_MS || "1800000"); // 30 min
/** Longueur d'une tranche d'attente côté serveur (plafonné à 60 s par /api/inbox). */
const TRANCHE_MS = 55000;

function nomAgent() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--agent");
  if (i >= 0 && argv[i + 1]) return argv[i + 1].trim();
  const env = (process.env.WIKICHAT_AGENT || "").trim();
  if (env) return env;
  // Dernier recours : le nom mis en cache par le hook pour cette session Claude.
  const sid = (process.env.CLAUDE_SESSION_ID || "").trim();
  if (sid) {
    const cache = path.join(os.homedir(), ".wikichat", "hook-cursors",
      `sid-${sid.replace(/[^\w.-]/g, "_")}.name`);
    try { return fs.readFileSync(cache, "utf8").trim() || null; } catch { /* */ }
  }
  return null;
}

async function releve(agent, attenteMs) {
  const q = `agent=${encodeURIComponent(agent)}&wait_ms=${attenteMs}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), attenteMs + 5000);
  try {
    const r = await fetch(`${BASE}/api/inbox?${q}`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok ? await r.json() : null;
  } catch { clearTimeout(t); return null; }
}

const agent = nomAgent();
if (!agent) {
  console.log("Guetteur non posé : identité inconnue. Lance register(name=…) d'abord, " +
    "ou passe --agent <nom>.");
  process.exit(0);
}

console.log(`Guetteur posé pour "${agent}" — je remonterai dès qu'un message t'est adressé.`);

const fin = Date.now() + DUREE_MAX_MS;
let echecsReseau = 0;
while (Date.now() < fin) {
  const debut = Date.now();
  const data = await releve(agent, Math.min(TRANCHE_MS, Math.max(fin - Date.now(), 1000)));

  if (!data) {
    // Serveur injoignable : on retente, mais sans s'acharner, et on abandonne
    // après quelques échecs plutôt que de rester en vie pour rien.
    if (++echecsReseau >= 5) {
      console.log("Guetteur arrêté : le service WikiChat ne répond pas.");
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, 5000));
    continue;
  }
  echecsReseau = 0;

  if (data.messages?.length) {
    const lignes = data.messages.map(m => {
      const ou = m.isDM ? "DM" : `#${m.channel}`;
      const marques = [
        m.expects_reply ? "réponse attendue" : null,
        m.status || null,
        m.eta_seconds ? `ETA ${m.eta_seconds}s` : null,
      ].filter(Boolean).join(", ");
      return `  • [${ou}] ${m.from} : ${m.content}${marques ? ` (${marques})` : ""}`;
    }).join("\n");
    console.log(`\n📬 ${data.messages.length} message(s) pour ${agent} :\n${lignes}\n`);
    console.log("Réponds avec send_message(channel=\"@<expéditeur>\", …) si une réponse est attendue.");
    process.exit(0);
  }

  // Le serveur ne guette que si la conversation est déjà chaude de son point de
  // vue ; sinon il répond aussitôt. Sans ce plancher, on le martèlerait.
  const ecoule = Date.now() - debut;
  if (ecoule < 2000) await new Promise(r => setTimeout(r, 2000 - ecoule));
}

console.log(`Guetteur expiré après ${Math.round(DUREE_MAX_MS / 60000)} min sans message pour ${agent}. ` +
  `Relance-le si tu attends toujours quelque chose.`);
process.exit(0);
