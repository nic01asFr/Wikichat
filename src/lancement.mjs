/**
 * lancement.mjs — Ce que wikichat donne à un processus Claude Code qu'il lance.
 *
 * Trois choses, et rien d'autre :
 *
 *  1. Le MODE DE PERMISSION. Il était codé en dur à `bypassPermissions` : un
 *     réveil sur mention tournait sans garde-fou, et `--allowedTools` — censé
 *     rendre un proposeur « lecture seule » — ne restreignait rien, puisqu'en
 *     bypass tout est permis. Le mode vient maintenant d'un paramètre explicite,
 *     `acceptEdits` par défaut ; `bypassPermissions` n'est honoré que si la
 *     DÉFINITION persistée d'une routine (ou d'un déclencheur) le demande.
 *
 *  2. La CONNEXION À WIKICHAT. wikichat écrivait ou complétait le `.mcp.json`
 *     du projet. Ce fichier appartient au projet (et, sur le pod, à la liaison
 *     de l'Atelier) : il n'y touche plus jamais. Sa propre connexion passe par
 *     `--mcp-config` d'un fichier temporaire HORS du projet, sans
 *     `--strict-mcp-config` — les serveurs de la portée utilisateur et du
 *     projet restent chargés par Claude Code, comme sur toute autre surface.
 *
 *  3. L'ENVIRONNEMENT. Les secrets sont référencés (`${ATELIER_MCP_…}`) dans
 *     les configurations ; leurs valeurs vivent dans un seul fichier généré par
 *     l'Atelier, `~/work/.secrets/claude-env.sh`. Il est sourcé ici pour que
 *     les processus lancés par wikichat voient les mêmes variables que le
 *     harnais, VS Code et le terminal.
 *
 * Module sans état partagé avec le serveur : testable seul.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { spawnSync } from "child_process";

// ── 1. Mode de permission ────────────────────────────────────────────────────

/** Modes reconnus par `claude --permission-mode`. */
export const MODES_PERMISSION = Object.freeze([
  "default", "acceptEdits", "plan", "dontAsk", "bypassPermissions",
]);

export const MODE_PERMISSION_DEFAUT = "acceptEdits";

/**
 * Le mode d'un lancement.
 *
 * @param {object} options
 *   @param {string}  [options.permissionMode|permission_mode]  mode demandé
 *   @param {boolean} [options.bypassAutorise]  vrai seulement quand la demande
 *     vient de la définition persistée d'une routine ou d'un déclencheur ; un
 *     appel d'outil ad hoc (spawn_session, contact, réveil) ne peut pas lever
 *     les garde-fous.
 * @returns {{ mode: string, avertissement?: string }}
 */
export function resoudreModePermission(options = {}) {
  const brut = options.permissionMode ?? options.permission_mode ?? "";
  const demande = String(brut || "").trim();
  if (!demande) return { mode: MODE_PERMISSION_DEFAUT };
  if (!MODES_PERMISSION.includes(demande)) {
    return {
      mode: MODE_PERMISSION_DEFAUT,
      avertissement: `mode de permission inconnu « ${demande} » — ${MODE_PERMISSION_DEFAUT} retenu`,
    };
  }
  if (demande === "bypassPermissions" && options.bypassAutorise !== true) {
    return {
      mode: MODE_PERMISSION_DEFAUT,
      avertissement: "bypassPermissions ignoré : seule la définition d'une routine ou d'un déclencheur peut le demander",
    };
  }
  return { mode: demande };
}

/**
 * Outils pré-autorisés d'un lancement.
 *
 * Hors bypass, un `claude -p` refuse tout appel non autorisé — y compris ceux
 * de wikichat, sans lesquels l'agent ne peut ni se présenter ni répondre.
 * Quand l'appelant ne fixe pas la liste, on autorise donc le serveur wikichat
 * entier. Quand il la fixe (agents du Pilote, applicateur), on la respecte
 * telle quelle : c'est elle qui fait le moindre privilège.
 *
 * @returns {string[]|null}
 */
export function outilsAutorises(allowedTools, mode) {
  if (allowedTools && (Array.isArray(allowedTools) ? allowedTools.length : String(allowedTools).trim())) {
    return Array.isArray(allowedTools)
      ? allowedTools.map(String)
      : String(allowedTools).split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (mode === "bypassPermissions") return null;
  return [...OUTILS_DE_BASE];
}

/**
 * Ce qu'un agent lancé doit toujours pouvoir faire : parler à wikichat et
 * déposer son artefact de secours dans `.wikichat/`. Passé par
 * `--allowedTools` plutôt qu'écrit dans `.claude/settings.local.json` du
 * projet, qui n'appartient pas à wikichat.
 */
export const OUTILS_DE_BASE = Object.freeze(["mcp__wikichat", "Write(.wikichat/**)", "Edit(.wikichat/**)"]);

// ── 2. Connexion wikichat ────────────────────────────────────────────────────

/** Une entrée MCP n'est utilisable que si elle dit où se connecter. */
export function entreeMcpUtilisable(entree) {
  if (!entree || typeof entree !== "object") return false;
  const url = typeof entree.url === "string" && entree.url.trim();
  const commande = typeof entree.command === "string" && entree.command.trim();
  return Boolean(url || commande);
}

/**
 * L'entrée wikichat d'un processus lancé.
 *
 * Le nom est connu au lancement : il voyage dans l'URL (`?agent=`), que le
 * serveur tient pour faisant foi à chaque connexion. Ni pont, ni jeton, ni
 * variable à développer — donc rien qui puisse retomber sur une identité
 * commune (`atelier`) ou anonyme.
 */
export function entreeWikichat({ name = null, port = null, host = null } = {}) {
  const p = port || process.env.PORT || "3777";
  const h = host || process.env.WIKICHAT_HOST || "127.0.0.1";
  const agent = name ? `?agent=${encodeURIComponent(name)}` : "";
  return { type: "sse", url: `http://${h}:${p}/sse${agent}` };
}

function dossierConfigsMcp() {
  return process.env.WIKICHAT_MCP_TMP || path.join(os.tmpdir(), "wikichat-mcp");
}

/**
 * Écrit la configuration MCP temporaire d'un lancement et rend son chemin.
 *
 * Jamais dans le projet : le fichier est créé dans un dossier temporaire
 * propre à wikichat. Une entrée incomplète (ni url ni command — la forme
 * `{enabled, headersHelper}` qu'une ancienne mise à niveau fabriquait) n'est
 * jamais écrite : on lève plutôt que de produire un serveur fantôme.
 */
export function ecrireConfigMcpTemporaire({ name = null, port = null, projectPath = null } = {}) {
  const entree = entreeWikichat({ name, port });
  if (!entreeMcpUtilisable(entree)) {
    throw new Error("entrée wikichat incomplète (ni url ni command) — non écrite");
  }
  const dossier = dossierConfigsMcp();
  if (projectPath) {
    const rel = path.relative(path.resolve(projectPath), path.resolve(dossier));
    if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
      throw new Error(`le dossier des configurations MCP (${dossier}) est dans le projet — refusé`);
    }
  }
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  const base = String(name || "anonyme").replace(/[^\w.-]/g, "_").slice(0, 60);
  const fichier = path.join(dossier, `${base}-${randomUUID().slice(0, 8)}.json`);
  fs.writeFileSync(fichier, JSON.stringify({ mcpServers: { wikichat: entree } }, null, 2), { mode: 0o600 });
  return fichier;
}

export function supprimerConfigMcp(fichier) {
  if (!fichier) return;
  try { fs.unlinkSync(fichier); } catch { /* déjà supprimé */ }
}

/**
 * Arguments MCP d'un lancement : `--mcp-config <temporaire>`, jamais
 * `--strict-mcp-config`. Rend aussi le fichier, à supprimer à la sortie.
 */
export function argumentsMcp({ name, port, projectPath } = {}) {
  try {
    const fichier = ecrireConfigMcpTemporaire({ name, port, projectPath });
    return { args: ["--mcp-config", fichier], fichier };
  } catch (err) {
    console.warn(`[lancement] configuration MCP temporaire non écrite : ${err.message}`);
    return { args: [], fichier: null };
  }
}

// ── 3. Environnement ─────────────────────────────────────────────────────────

/** Le fichier d'environnement unique généré par l'Atelier. */
export function fichierEnvSecrets() {
  return process.env.WIKICHAT_FICHIER_ENV
    || path.join(os.homedir(), "work", ".secrets", "claude-env.sh");
}

const IGNOREES = new Set(["_", "SHLVL", "PWD", "OLDPWD"]);
const SEPARATEUR = "__WIKICHAT_ENV_SEP__";
let _cache = { cle: null, vars: {} };
let _averti = false;

function lireParShell(fichier) {
  // `set -a` exporte aussi les affectations nues ; on compare l'environnement
  // du même shell avant et après, pour ne rendre que ce que le fichier ajoute.
  const script = `env -0; printf '\\0${SEPARATEUR}\\0'; set -a; . "$1" >/dev/null 2>&1 || exit 97; env -0`;
  const r = spawnSync("sh", ["-c", script, "sh", fichier], {
    encoding: "utf8",
    timeout: 5000,
    windowsHide: true,
    env: { PATH: process.env.PATH || "", HOME: os.homedir() },
  });
  if (r.error || r.status !== 0 || typeof r.stdout !== "string") return null;
  const [avant, apres] = r.stdout.split(`\0${SEPARATEUR}\0`);
  if (apres === undefined) return null;
  const lire = (bloc) => {
    const m = new Map();
    for (const ligne of bloc.split("\0")) {
      const i = ligne.indexOf("=");
      if (i > 0) m.set(ligne.slice(0, i), ligne.slice(i + 1));
    }
    return m;
  };
  const a = lire(avant), b = lire(apres);
  const vars = {};
  for (const [k, v] of b) {
    if (IGNOREES.has(k)) continue;
    if (a.get(k) !== v) vars[k] = v;
  }
  return vars;
}

/** Repli sans shell : `export K=V` / `K=V`, guillemets simples ou doubles. */
function lireSansShell(fichier) {
  const vars = {};
  for (const brut of fs.readFileSync(fichier, "utf8").split(/\r?\n/)) {
    const m = brut.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
    vars[m[1]] = v;
  }
  return vars;
}

/**
 * Variables apportées par le fichier d'environnement, s'il existe.
 * Relu seulement quand il change. Aucune valeur n'est journalisée.
 */
export function chargerEnvSecrets(fichier = fichierEnvSecrets()) {
  let st;
  try { st = fs.statSync(fichier); } catch { return {}; }
  const cle = `${fichier}:${st.mtimeMs}:${st.size}`;
  if (_cache.cle === cle) return { ..._cache.vars };
  let vars = lireParShell(fichier);
  if (!vars) {
    if (!_averti) {
      console.warn(`[lancement] ${fichier} non sourçable par sh — lecture ligne à ligne`);
      _averti = true;
    }
    try { vars = lireSansShell(fichier); } catch { vars = {}; }
  }
  _cache = { cle, vars };
  return { ...vars };
}

/** Environnement d'un processus lancé : celui du service, les secrets, l'identité. */
export function environnementEnfant(name, extra = {}) {
  return {
    ...process.env,
    ...chargerEnvSecrets(),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extra,
    ...(name ? { WIKICHAT_AGENT: name } : {}),
    // Les hooks savent ainsi qu'un agent lancé par wikichat ne doit pas poser
    // de guetteur (il sort à la fin de sa tâche).
    WIKICHAT_LANCE: "1",
  };
}
