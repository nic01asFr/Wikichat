#!/usr/bin/env node
/**
 * wikichat-hook.mjs — Hook Claude Code de wikichat, un seul script pour tous
 * les événements :
 *
 *   node wikichat-hook.mjs session-start   (SessionStart)
 *   node wikichat-hook.mjs prompt          (UserPromptSubmit)
 *   node wikichat-hook.mjs stop            (Stop)
 *   node wikichat-hook.mjs guetter         (Stop, asyncRewake : guetteur natif)
 *   node wikichat-hook.mjs session-end     (SessionEnd)
 *
 * Mince par construction : il transmet l'entrée JSON du hook (stdin) et
 * quelques variables de son environnement à `POST /api/hooks/<événement>`, et
 * imprime la réponse, déjà au format de sortie de Claude Code. Toute la
 * décision est côté serveur, identique sur toutes les surfaces.
 * Conception : docs/hooks-et-dialogue.md.
 *
 * Il ne casse jamais un tour : serveur absent, délai dépassé ou réponse
 * illisible → rien sur stdout, code 0. Seul le guetteur sort en code 2, pour
 * réveiller la session quand une réponse attendue est arrivée.
 */
import fs from "fs";
import { randomBytes } from "crypto";

const EVENEMENT = (process.argv[2] || "").trim();
const BASE = (process.env.WIKICHAT_URL || `http://127.0.0.1:${process.env.WIKICHAT_PORT || "3777"}`).replace(/\/$/, "");
/** Délai d'un appel, par événement (ms). SessionEnd partage un budget de 1,5 s. */
const DELAIS = { "session-start": 2000, prompt: 1500, stop: 1500, "session-end": 800, guetter: 65000 };
/** Durée de vie du guetteur : sous le `timeout` du hook (1800 s). */
const GUET_MAX_MS = parseInt(process.env.WIKICHAT_GUET_MAX_MS || "1750000");

function lireEntree() {
  try { return JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { return {}; }
}

function environnement(entree) {
  const e = process.env;
  const propre = (v) => { const s = String(v || "").trim(); return s && !s.includes("${") ? s : null; };
  return {
    agent: propre(e.WIKICHAT_AGENT),
    atelier_session: propre(e.ATELIER_SESSION),
    entrypoint: propre(e.CLAUDE_CODE_ENTRYPOINT),
    lance: e.WIKICHAT_LANCE === "1",
    session_id: entree.session_id || propre(e.CLAUDE_CODE_SESSION_ID),
  };
}

async function appeler(evenement, corps, delai) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), delai);
  try {
    const r = await fetch(`${BASE}/api/hooks/${evenement}`, {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corps),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
  finally { clearTimeout(t); }
}

function imprimer(sortie) {
  if (!sortie || typeof sortie !== "object" || !Object.keys(sortie).length) return;
  process.stdout.write(JSON.stringify(sortie));
}

/**
 * Guetteur : attend par tranches, sans modèle, qu'une réponse attendue arrive.
 * Sort en code 2 avec le message sur stderr : Claude Code réveille la session.
 */
async function guetter(entree, env) {
  // Pas dans un tour de l'Atelier (le processus y vit d'un tour à l'autre : un
  // réveil démarrerait un tour à l'insu de l'interface), ni dans un agent lancé
  // par wikichat en -p, ni si on l'a coupé.
  if (process.env.WIKICHAT_HOOK_REVEIL === "0") return 0;
  if (env.atelier_session && process.env.WIKICHAT_REVEIL_ATELIER !== "1") return 0;
  if (env.lance) return 0;
  const generation = randomBytes(6).toString("hex");
  const fin = Date.now() + GUET_MAX_MS;
  let premier = true, echecs = 0;
  while (Date.now() < fin) {
    const r = await appeler("guetter", { entree, env, generation, premier }, DELAIS.guetter);
    premier = false;
    if (!r) {
      if (++echecs >= 5) return 0;
      await new Promise(res => setTimeout(res, 5000));
      continue;
    }
    echecs = 0;
    if (r.fin) return 0;
    if (r.reveil) { process.stderr.write(r.reveil); return 2; }
  }
  return 0;
}

async function main() {
  if (!DELAIS[EVENEMENT]) return 0;
  const entree = lireEntree();
  const env = environnement(entree);
  if (!env.session_id) return 0;
  if (EVENEMENT === "guetter") return guetter(entree, env);
  const sortie = await appeler(EVENEMENT, { entree, env }, DELAIS[EVENEMENT]);
  imprimer(sortie);
  return 0;
}

main().then(code => process.exit(code || 0), () => process.exit(0));
