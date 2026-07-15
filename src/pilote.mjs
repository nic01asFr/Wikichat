/**
 * pilote.mjs — Backend du Pilote d'agents planifiés.
 *
 * Traduit les triggers cron (action spawn_session) + le spawn registry en
 * "agents planifiés" pour la vue /pilote, et expose les actions réelles
 * (activer/désactiver, lancer, créer, supprimer). Lecture seule pour la file
 * d'approbation (lit .wikichat/proposed-actions.json déposé par les agents).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { listTriggers, getTrigger, registerTrigger, setEnabled, deleteTrigger, fireTrigger } from "./triggers.mjs";
import { loadSpawnRegistry } from "./persistence.mjs";
import { isActive, onWake } from "./dormant.mjs";
import { spawnHeadless } from "./sampler.mjs";

// ── Page ────────────────────────────────────────────────────────────────────
export function handlePilotePage(_req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(readFileSync(join(process.cwd(), "public", "pilote.html")));
}

// Espace de travail neutre de l'architecte (évite de polluer le repo courant).
const ARCHITECT_DIR = path.join(os.tmpdir(), "wikichat-architect");

// Applications en vol (une seule par agent — garde anti-doublon).
const _applying = new Set();
// État de pause du pilote, persisté pour survivre aux redémarrages.
const PAUSE_FILE = path.join(os.homedir(), ".wikichat", "pilote-pause.json");

// ── Contrat proposeur générique ─────────────────────────────────────────────
// Injecté via --append-system-prompt dans TOUT agent créé depuis le pilote (pas
// dans l'applicateur). La SOP de chaque agent reste purement métier ; la plomberie
// (proposer, apply-spec auto-configuré, needs, curseur, jamais d'écriture directe)
// est héritée d'ici, en un seul endroit, pour tous les agents.
const PROPOSER_CONTRACT = [
  "CONTRAT PROPOSEUR (WikiChat Pilote) — s'applique à toi, en plus de ta mission :",
  "- Tu PROPOSES ; tu n'exécutes JAMAIS toi-même d'écriture externe (Grist/Gmail/GitHub/API). Lecture + proposition + écriture de fichiers locaux uniquement.",
  "- Idempotence : lis puis réécris un curseur .wikichat/cursor.json pour ne pas retraiter les mêmes données d'un run à l'autre.",
  "- Pour CHAQUE écriture externe souhaitée, produis un objet action AUTO-CONFIGURÉ :",
  "   1) introspecte d'abord le schéma/format de la cible avec tes outils de LECTURE (ex Grist : list_tables puis list_columns) — ne devine pas les colonnes,",
  "   2) remplis apply = { \"tool\": \"<outil d'écriture>\", \"doc\"|\"target\": \"...\", \"table\": \"...\", \"fields\": { valeurs exactes } },",
  "   3) mets dans \"needs\" un tableau d'objets STRUCTURÉS, un par champ que tu n'as PAS pu résoudre avec certitude : {\"field\":\"<nom>\",\"path\":\"apply.fields.<Colonne>\",\"question\":\"<question courte>\",\"options\":[<valeurs valides issues de ton introspection, si applicable>],\"value\":null}. Le \"path\" DOIT pointer le champ exact à corriger dans apply. Propose les options RÉELLES lues dans la cible (ex : valeurs de la table Categories) — l'utilisateur tranchera dans l'interface ; ne devine jamais à sa place.",
  "- ID STABLE : chaque action porte un \"id\" déterministe, dérivé de la donnée source (ex \"prelev-bpmed-20260706-107.24\") — le MÊME fait source doit toujours produire le MÊME id, d'un run à l'autre.",
  "- FUSION, JAMAIS D'ÉCRASEMENT : lis d'abord .wikichat/proposed-actions.json s'il existe. CONSERVE toutes les entrées existantes (surtout status \"applied\" / \"rejected\" / \"approved\" — c'est l'historique et le garde-fou anti-doublon). N'AJOUTE que les actions dont l'id n'est pas déjà présent. Ne re-propose JAMAIS un id déjà présent, quel que soit son status.",
  "- Écris le tableau FUSIONNÉ dans .wikichat/proposed-actions.json : objets {id,title,sub,kind,amount,status:\"pending\",apply,needs}. Écriture atomique via Bash (fichier tmp puis mv), PUIS vérifie par `cat` — ne conclus pas tant que le JSON ne s'affiche pas.",
  "- Ne mets JAMAIS toi-même status \"approved\" ou \"applied\" : seul l'utilisateur valide, seul l'applicateur applique."
].join("\n");

// ── Détection réelle des outils disponibles ─────────────────────────────────
// Built-ins Claude Code sûrs pour des agents planifiés + serveurs MCP réels de
// l'utilisateur (via `claude mcp list`, mis en cache 5 min car il fait des
// health-checks réseau lents).
const BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"];

// ── Scopes lecture/écriture par serveur MCP ─────────────────────────────────
// L'agent proposeur ne doit PAS pouvoir écrire : on ne lui accorde que les outils
// de LECTURE (granularité mcp__serveur__outil). Seul l'applicateur reçoit les
// outils d'écriture. C'est ce qui transforme « il ne doit pas écrire » (consigne
// dans un prompt) en « il ne peut pas écrire » (permission CLI).
// NB BigMCP est une passerelle : son meta-outil `execute` peut invoquer n'importe
// quel outil (y compris d'écriture) → il est classé en WRITE, jamais donné au proposeur.
const MCP_TOOL_SCOPES = {
  "mcp__claude_ai_Gmail": {
    read: ["search_threads", "get_thread", "get_message", "list_labels", "list_drafts"],
    write: ["label_thread", "label_message", "unlabel_thread", "unlabel_message", "create_draft",
            "apply_sensitive_thread_label", "apply_sensitive_message_label", "create_label"]
  },
  "mcp__claude_ai_BigMCP": {
    read: ["search", "describe_tool",
           "Grist__list_organizations", "Grist__list_workspaces", "Grist__list_documents",
           "Grist__describe_document", "Grist__list_tables", "Grist__list_columns",
           "Grist__get_table_schema", "Grist__list_records", "Grist__execute_sql_query",
           "Grist__filter_sql_query", "Grist__export_schema"],
    write: ["execute",
            "Grist__add_grist_records", "Grist__add_grist_records_safe",
            "Grist__update_grist_records", "Grist__delete_grist_records",
            "Grist__create_table", "Grist__create_column", "Grist__modify_column"]
  }
};

/**
 * Développe une sélection coarse (["Bash","mcp__claude_ai_Gmail"]) en tokens
 * --allowedTools effectifs. mode="read" → outils de lecture seuls ;
 * mode="write" → lecture + écriture (réservé à l'applicateur).
 * Un serveur inconnu de la carte est laissé tel quel (coarse) — on ne peut pas
 * garantir la lecture seule pour lui, c'est signalé par unscoped.
 */
export function expandTools(list, mode) {
  const out = [], unscoped = [];
  (Array.isArray(list) ? list : []).forEach((t) => {
    if (BUILTIN_TOOLS.includes(t)) { out.push(t); return; }
    const scope = MCP_TOOL_SCOPES[t];
    if (!scope) { out.push(t); if (String(t).indexOf("mcp__") === 0) unscoped.push(t); return; }
    scope.read.forEach((s) => out.push(t + "__" + s));
    if (mode === "write") scope.write.forEach((s) => out.push(t + "__" + s));
  });
  return { tools: [...new Set(out)], unscoped };
}

let _mcpCache = null, _mcpAt = 0;

function detectMcpServers() {
  return new Promise((resolve) => {
    if (_mcpCache && (Date.now() - _mcpAt) < 5 * 60 * 1000) return resolve(_mcpCache);
    exec("claude mcp list", { timeout: 30000, windowsHide: true, maxBuffer: 1 << 20 }, (_err, stdout) => {
      const servers = [];
      String(stdout || "").split(/\r?\n/).forEach((line) => {
        const m = line.match(/^(.+?):\s+.*\s-\s(.+?)\s*$/);
        if (!m) return;
        const name = m[1].trim(), status = m[2].trim();
        if (!name || /^Checking/i.test(name)) return;
        servers.push({
          name,
          allow: "mcp__" + name.replace(/[^\w-]/g, "_"),
          status: /connected/i.test(status) ? "connected" : /auth/i.test(status) ? "auth" : "unknown"
        });
      });
      _mcpCache = servers; _mcpAt = Date.now();
      resolve(servers);
    });
  });
}

export async function handlePiloteTools(_req, res) {
  try {
    const mcp = await detectMcpServers();
    res.json({ builtins: BUILTIN_TOOLS, mcp });
  } catch (err) {
    res.json({ builtins: BUILTIN_TOOLS, mcp: [], error: err.message });
  }
}

// ── Cron helpers (next-run best-effort, tz = heure locale du serveur) ────────
function parseField(f, min, max) {
  const ok = new Set();
  String(f).split(",").forEach((part) => {
    let step = 1, range = part;
    const slash = part.split("/");
    if (slash.length === 2) { range = slash[0]; step = parseInt(slash[1], 10) || 1; }
    let lo, hi;
    if (range === "*") { lo = min; hi = max; }
    else if (range.indexOf("-") !== -1) { const ab = range.split("-"); lo = parseInt(ab[0], 10); hi = parseInt(ab[1], 10); }
    else { lo = hi = parseInt(range, 10); }
    if (isNaN(lo)) return;
    if (isNaN(hi)) hi = lo;
    for (let v = lo; v <= hi; v += step) if (v >= min && v <= max) ok.add(v);
  });
  return ok;
}

function cronNext(schedule, from) {
  const parts = String(schedule || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const mins = parseField(parts[0], 0, 59), hrs = parseField(parts[1], 0, 23),
        doms = parseField(parts[2], 1, 31), mons = parseField(parts[3], 1, 12),
        dows = parseField(parts[4], 0, 6);
  const domStar = parts[2] === "*", dowStar = parts[4] === "*";
  let d = new Date(from.getTime() + 60000); d.setSeconds(0, 0);
  const limit = new Date(from.getTime() + 60 * 24 * 3600 * 1000); // borne à 60 jours
  while (d < limit) {
    const dayOk = (domStar && dowStar) ? true
      : domStar ? dows.has(d.getDay())
      : dowStar ? doms.has(d.getDate())
      : (doms.has(d.getDate()) || dows.has(d.getDay()));
    if (mons.has(d.getMonth() + 1) && dayOk && hrs.has(d.getHours()) && mins.has(d.getMinutes())) return new Date(d);
    d = new Date(d.getTime() + 60000);
  }
  return null;
}

const pad = (n) => String(n).padStart(2, "0");

function humanNext(date, now) {
  if (!date) return "—";
  const hm = pad(date.getHours()) + ":" + pad(date.getMinutes());
  const diff = date.getTime() - now.getTime();
  if (diff < 90 * 60000) {
    const m = Math.max(1, Math.round(diff / 60000));
    return m < 60 ? "dans " + m + " min" : "dans " + Math.floor(m / 60) + " h " + pad(m % 60);
  }
  const sameDay = date.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toDateString() === date.toDateString();
  if (sameDay) return "aujourd'hui " + hm;
  if (tomorrow) return "demain " + hm;
  return pad(date.getDate()) + "/" + pad(date.getMonth() + 1) + " " + hm;
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
}

function withinDays(iso, days, now) {
  try { const d = new Date(iso); return !isNaN(d.getTime()) && (now.getTime() - d.getTime()) < days * 24 * 3600 * 1000; }
  catch { return false; }
}

// ── Mapping trigger → agent ─────────────────────────────────────────────────
function isPiloteTrigger(t) {
  return t && t.type === "cron" && t.action && t.action.type === "spawn_session";
}

// Normalise les "needs" en objets exploitables par l'UI. Un need résoluble porte
// un "path" (ex "apply.fields.Categorie") ; les anciens needs en texte libre sont
// conservés en lecture seule (non résolubles → validation à forcer explicitement).
function normalizeNeeds(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((n, i) => {
    if (typeof n === "string") {
      return { field: null, path: null, question: n, options: [], value: null, legacy: true };
    }
    n = n || {};
    return {
      field: n.field || null,
      path: (typeof n.path === "string" && n.path.indexOf("apply.") === 0) ? n.path : null,
      question: n.question || n.field || ("champ " + (i + 1)),
      options: Array.isArray(n.options) ? n.options.map(String) : [],
      value: (n.value === undefined || n.value === "") ? null : n.value,
      legacy: false
    };
  });
}

// Écrit une valeur à un chemin pointé, restreint à "apply.*" (garde anti-pollution).
function setApplyPath(action, dotted, value) {
  if (typeof dotted !== "string" || dotted.indexOf("apply.") !== 0) return false;
  const parts = dotted.split(".");
  const unsafe = (k) => k === "__proto__" || k === "constructor" || k === "prototype";
  let cur = action;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (unsafe(k)) return false;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  if (unsafe(last)) return false;
  cur[last] = value;
  return true;
}

function readProposedActions(dir) {
  try {
    if (!dir || dir.startsWith("~")) return [];
    const p = path.join(dir, ".wikichat", "proposed-actions.json");
    if (!fs.existsSync(p)) return [];
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const arr = Array.isArray(raw) ? raw : (raw.actions || []);
    return arr.map((a, i) => ({
      id: a.id || ("p" + i),
      kind: a.kind || "action",
      icon: a.icon || (a.kind === "money" ? "+" : a.kind === "mail" ? "✉" : "•"),
      title: a.title || a.summary || "Action proposée",
      sub: a.sub || a.detail || "",
      amount: a.amount || "",
      status: a.status || "pending",
      needs: normalizeNeeds(a.needs),
      apply: a.apply || null
    })).filter((x) => x.status === "pending");
  } catch { return []; }
}

// Nombre d'actions validées en attente d'application (status "approved").
function countApproved(dir) {
  try {
    if (!dir || dir.startsWith("~")) return 0;
    const p = path.join(dir, ".wikichat", "proposed-actions.json");
    if (!fs.existsSync(p)) return 0;
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const arr = Array.isArray(raw) ? raw : (raw.actions || []);
    return arr.filter((a) => a.status === "approved").length;
  } catch { return 0; }
}

function triggerToAgent(t, registry, now) {
  const p = (t.action && t.action.params) || {};
  const cfg = t.config || {};
  const dir = p.repo_path || p.projectPath || "";
  const spawns = registry
    .filter((e) => String(e.spawned_by || "").indexOf("trigger:" + t.id + ":") === 0)
    .sort((a, b) => new Date(b.spawned_at || 0) - new Date(a.spawned_at || 0));
  const last = spawns[0];
  const lastWithSession = spawns.find((e) => e.claude_session_id || e.session_id);
  const running = spawns.some((e) => e.status === "running" || e.status === "starting");

  const nextDate = t.enabled ? cronNext(cfg.schedule, now) : null;

  // On affiche la sélection lisible (serveurs), pas les dizaines de tokens granulaires.
  const scopeSel = (Array.isArray(p.servers) && p.servers.length) ? p.servers
    : (Array.isArray(p.allowedTools) ? p.allowedTools : []);
  const scoped = Array.isArray(p.servers) && p.servers.length; // créé avec le split lecture/écriture
  const tools = scopeSel.length
    ? scopeSel.map((n) => ({
        name: n.indexOf("mcp__") === 0 ? n.replace(/^mcp__/, "").replace(/^claude_ai_/, "") : n,
        perm: n.indexOf("mcp__") === 0 ? (scoped ? "lecture seule" : "accès complet") : "intégré"
      }))
    : [{ name: "hérités du dossier", perm: ".mcp.json" }];

  const mission = String(p.initial_task || p.prompt || "(mission définie dans la SOP du dossier)")
    .split("\n").map((s) => s).slice(0, 20);

  const history = spawns.slice(0, 6).map((e) => {
    let text = "run · " + (e.status || "?");
    if (e.status === "done") text = "run terminé · OK";
    else if (e.status === "failed") text = "run échoué · exit " + (e.exit_code != null ? e.exit_code : "?");
    else if (e.status === "timeout") text = "run interrompu · timeout";
    else if (e.status === "error") text = "run en erreur";
    else if (e.status === "starting" || e.status === "running") text = "en cours…";
    return { date: fmtDate(e.spawned_at), text, err: ((e.exit_code && e.exit_code !== 0) || e.status === "error" || e.status === "timeout") ? 1 : 0 };
  });

  return {
    id: t.id,
    real: true,
    name: p.name || t.description || t.id,
    desc: t.description || (p.role || "Agent planifié"),
    base: running ? "actif" : "veille",
    next: humanNext(nextDate, now),
    cron: cfg.schedule || "—",
    enabled: t.enabled !== false,
    trigger: {
      freq: cfg.schedule || "—",
      tz: cfg.tz || "local",
      cooldown: (t.cooldown_s != null ? t.cooldown_s + " s" : "—"),
      cap: (t.max_per_day != null ? String(t.max_per_day) : "—"),
      src: (cfg.schedule || "") + (dir ? " cd " + dir + " && claude -p …" : "")
    },
    scope: {
      dir: dir || "—",
      mode: p.mode || "headless",
      tools
    },
    memory: {
      session: (lastWithSession && (lastWithSession.claude_session_id || lastWithSession.session_id)) || "—",
      sessionFile: (lastWithSession && lastWithSession.session_file) || "—",
      recover: last ? (last.status + " · " + fmtDate(last.spawned_at)) : "jamais exécuté",
      guide: "CLAUDE.md",
      facts: p.cursor || "cursor.json",
      turns: p.max_turns ? ("--max-turns " + p.max_turns) : "--max-turns —",
      budget: p.model || "—"
    },
    mission,
    queue: readProposedActions(dir),
    approvedCount: countApproved(dir),
    canResume: !!(lastWithSession && withinDays(lastWithSession.spawned_at || lastWithSession.ended_at, 30, now)),
    history,
    fired: t.fire_count || 0,
    lastFired: t.last_fired || null
  };
}

// ── Endpoints ───────────────────────────────────────────────────────────────
export function handlePiloteData(_req, res) {
  const now = new Date();
  let agents = [];
  try {
    agents = listTriggers().filter(isPiloteTrigger).map((t) => triggerToAgent(t, safeRegistry(), now));
  } catch { agents = []; }

  const armed = agents.filter((a) => a.enabled).length;
  // prochain réveil = plus proche next-run parmi les agents actifs
  let wakeDate = null, wakeAgent = "";
  try {
    listTriggers().filter(isPiloteTrigger).forEach((t) => {
      if (!t.enabled) return;
      const d = cronNext((t.config || {}).schedule, now);
      if (d && (!wakeDate || d < wakeDate)) { wakeDate = d; wakeAgent = ((t.action && t.action.params && t.action.params.name) || t.description || t.id); }
    });
  } catch { /* */ }

  const paused = readPause().paused;
  res.json({
    active: safeActive(),
    daemon: { armed, total: agents.length, wake: humanNext(wakeDate, now), wakeAgent, paused },
    agents
  });
}

// ── Pause réelle du pilote ──────────────────────────────────────────────────
// Mettre en pause DÉSACTIVE réellement les triggers cron des agents (et mémorise
// lesquels l'étaient) ; réactiver les restaure. Persisté → survit au redémarrage.
function readPause() {
  try { return JSON.parse(fs.readFileSync(PAUSE_FILE, "utf8")); }
  catch { return { paused: false, wasEnabled: [] }; }
}
function writePause(o) {
  try { fs.mkdirSync(path.dirname(PAUSE_FILE), { recursive: true }); fs.writeFileSync(PAUSE_FILE, JSON.stringify(o, null, 2)); }
  catch { /* non bloquant */ }
}

// ── Rattrapage au réveil ────────────────────────────────────────────────────
// Un cron ne peut pas partir pendant que la gate dormante est fermée (pas de
// session active) : le run est simplement sauté. Plutôt que de stocker une file
// de jobs (qui dupliquerait l'état), on recalcule ce qui a été manqué à partir
// de schedule + last_fired — les deux seules sources de vérité — et on relance
// UNE fois par agent. Le curseur de chaque agent absorbe le retard accumulé.
async function catchupMissed() {
  if (readPause().paused) return;
  const now = new Date();
  const due = listTriggers().filter(isPiloteTrigger).filter((t) => t.enabled !== false).filter((t) => {
    const since = t.last_fired ? new Date(t.last_fired) : (t.created_at ? new Date(t.created_at) : null);
    if (!since || isNaN(since.getTime())) return false;
    const next = cronNext((t.config || {}).schedule, since);
    return !!(next && next <= now);
  });
  for (const t of due) {
    // Pas de force : on hérite des garde-fous existants (cooldown, cap/jour, dormant).
    try { await fireTrigger(t.id, { source: "catchup" }); } catch { /* non bloquant */ }
  }
}

/** À appeler une fois au boot : relance les agents en retard dès que la gate s'ouvre. */
export function startPiloteCatchup() {
  onWake(() => { catchupMissed().catch(() => { /* non bloquant */ }); });
}

export function handlePiloteDaemon(req, res) {
  const want = !!(req.body && req.body.paused);
  const st = readPause();
  try {
    if (want && !st.paused) {
      const wasEnabled = listTriggers().filter(isPiloteTrigger).filter((t) => t.enabled !== false).map((t) => t.id);
      wasEnabled.forEach((id) => setEnabled(id, false));
      writePause({ paused: true, wasEnabled, at: new Date().toISOString() });
      return res.json({ ok: true, paused: true, disabled: wasEnabled.length });
    }
    if (!want && st.paused) {
      const ids = st.wasEnabled || [];
      ids.forEach((id) => { if (getTrigger(id)) setEnabled(id, true); });
      writePause({ paused: false, wasEnabled: [] });
      return res.json({ ok: true, paused: false, restored: ids.length });
    }
    res.json({ ok: true, paused: st.paused });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

function safeRegistry() { try { return loadSpawnRegistry(); } catch { return []; } }
function safeActive() { try { return isActive(); } catch { return true; } }

export function handlePiloteToggle(req, res) {
  const id = req.params.id;
  const t = getTrigger(id);
  if (!t) return res.status(404).json({ ok: false, error: "trigger introuvable" });
  const ok = setEnabled(id, !(t.enabled !== false));
  res.json({ ok, enabled: !(t.enabled !== false) });
}

export async function handlePiloteFire(req, res) {
  const id = req.params.id;
  if (!getTrigger(id)) return res.status(404).json({ ok: false, error: "trigger introuvable" });
  try {
    const r = await fireTrigger(id, { force: true, source: "pilote" });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

export function handlePiloteDelete(req, res) {
  const ok = deleteTrigger(req.params.id);
  res.json({ ok });
}

export function handlePiloteCreate(req, res) {
  const b = req.body || {};
  const name = String(b.name || "").trim();
  if (!name) return res.status(400).json({ ok: false, error: "nom requis" });
  const schedule = String(b.freq || "0 8 * * *").trim();
  const tools = Array.isArray(b.tools) && b.tools.length ? b.tools : ["Bash"];
  const readScope = expandTools(tools, "read"); // le proposeur ne reçoit que la lecture
  try {
    const spec = {
      // id fourni → remplacement en place (registerTrigger conserve id + stats) :
      // permet de migrer/éditer un agent sans casser son historique ni sa session.
      ...(b.id ? { id: String(b.id) } : {}),
      type: "cron",
      config: { schedule, tz: b.tz || "Europe/Paris" },
      action: {
        type: "spawn_session",
        params: {
          repo_path: b.dir || "",
          name,
          role: b.desc || "",
          mode: "headless",
          model: b.model || "sonnet",
          servers: tools,                // sélection coarse — source pour l'applicateur
          allowedTools: readScope.tools, // proposeur : LECTURE SEULE (garantie par permission)
          max_turns: b.max_turns != null ? Number(b.max_turns) : 15,
          append_system_prompt: PROPOSER_CONTRACT,
          initial_task: b.mission || "",
          prompt: b.mission || ""
        }
      },
      enabled: b.enabled !== false,
      cooldown_s: b.cooldown_s != null ? Number(b.cooldown_s) : 3600,
      max_per_day: b.max_per_day != null ? Number(b.max_per_day) : 24,
      description: b.desc || name
    };
    const t = registerTrigger(spec);
    res.json({ ok: true, id: t.id, readOnly: readScope.tools, unscoped: readScope.unscoped });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// Approuver / rejeter une action proposée. WikiChat ne touche JAMAIS Grist/Gmail
// lui-même : on persiste la décision dans .wikichat/proposed-actions.json, l'agent
// applique les actions "approved" à son prochain run (ou via /fire).
export function handlePiloteDecide(req, res) {
  const t = getTrigger(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: "trigger introuvable" });
  const dir = (t.action && t.action.params && t.action.params.repo_path) || "";
  const body = req.body || {};
  const decision = body.decision === "reject" ? "rejected" : "approved";
  const resolved = (body.resolved && typeof body.resolved === "object") ? body.resolved : null;
  const patched = {};
  if (!dir || dir.startsWith("~")) return res.json({ ok: true, persisted: false, note: "dossier non résolu — décision non persistée" });
  try {
    const p = path.join(dir, ".wikichat", "proposed-actions.json");
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: "aucune proposition sur disque" });
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const arr = Array.isArray(raw) ? raw : (raw.actions || []);
    let found = false;
    arr.forEach((a, i) => {
      if ((a.id || ("p" + i)) !== body.actionId) return;
      // Résolutions saisies par l'utilisateur : on patche apply.* AVANT d'approuver,
      // pour que l'applicateur écrive exactement ce qui a été choisi.
      if (decision === "approved" && resolved) {
        Object.keys(resolved).forEach((k) => {
          if (setApplyPath(a, k, resolved[k])) {
            patched[k] = resolved[k];
            if (Array.isArray(a.needs)) a.needs.forEach((n) => { if (n && n.path === k) n.value = resolved[k]; });
          }
        });
      }
      a.status = decision; a.decided_at = new Date().toISOString(); found = true;
    });
    if (!found) return res.status(404).json({ ok: false, error: "action introuvable" });
    fs.writeFileSync(p, JSON.stringify(raw, null, 2));
    try { fs.appendFileSync(path.join(dir, ".wikichat", "decisions.jsonl"), JSON.stringify({ at: new Date().toISOString(), actionId: body.actionId, decision, resolved: patched, forced: !!body.forced }) + "\n"); } catch { /* */ }
    res.json({ ok: true, persisted: true, decision, resolved: patched });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// Applicateur : spawne un agent headless (mêmes outils/modèle que l'agent) chargé
// d'EXÉCUTER les actions "approved" avec SES tools MCP, puis de les passer à "applied".
// C'est le seul endroit où l'écriture externe (Grist/Gmail) a lieu — côté agent, jamais serveur.
export async function handlePiloteApply(req, res) {
  const t = getTrigger(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: "trigger introuvable" });
  const p = (t.action && t.action.params) || {};
  const dir = p.repo_path || "";
  if (!dir || dir.startsWith("~")) return res.status(400).json({ ok: false, error: "dossier de travail non résolu" });
  if (countApproved(dir) === 0) return res.json({ ok: true, applied: 0, note: "aucune action validée à appliquer" });
  // Verrou anti-doublon : une seule application en vol par agent. Sans ça, deux
  // clics (ou deux appels) lancent deux applicateurs qui écrivent chacun la ligne.
  if (_applying.has(t.id)) return res.status(409).json({ ok: false, error: "une application est déjà en cours pour cet agent" });
  _applying.add(t.id);

  const applyPrompt = [
    "Tâche : appliquer les actions VALIDÉES par l'utilisateur.",
    "1. Lis le fichier .wikichat/proposed-actions.json de ce dossier.",
    "2. Pour CHAQUE action dont le champ status vaut exactement \"approved\" (ignore pending / rejected / applied) :",
    "   - Si l'action porte un objet \"apply\", exécute EXACTEMENT cette spécification avec l'outil qu'elle indique (n'invente rien, ne modifie aucune valeur). Ex : apply.tool='add_grist_records' → écris dans apply.doc/apply.table avec apply.fields tels quels.",
    "   - Sinon seulement, interprète title/sub/detail au mieux avec tes outils.",
    "3. Après exécution réussie, passe son status à \"applied\", ajoute applied_at (horodatage ISO), et réécris le fichier (Bash, puis vérifie par `cat`).",
    "4. N'exécute JAMAIS une action non-\"approved\". En cas d'échec sur une action, laisse-la en \"approved\" et note l'erreur dans un champ error.",
    "5. Sois concis. Termine dès que toutes les actions approuvées sont traitées."
  ].join("\n");

  try {
    const r = await spawnHeadless(dir, applyPrompt, {
      name: (p.name || t.id) + "-apply",
      role: "applicateur",
      model: p.model || "sonnet",
      // Seul l'applicateur obtient les outils d'ÉCRITURE (le proposeur est en lecture seule).
      allowedTools: expandTools(p.servers || p.allowedTools, "write").tools,
      maxTurns: p.max_turns || 15,
      spawnedBy: "trigger:" + t.id + ":apply"
    });
    // Contrôle post-application : ce qui reste "approved" n'a PAS été appliqué.
    const leftover = countApproved(dir);
    res.json({ ok: !!r.success, exitCode: r.exitCode, sessionId: r.sessionId || null, notApplied: leftover });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    _applying.delete(t.id);
  }
}

// Continuer : reprend la dernière session Claude de l'agent via --resume (repli
// impossible côté serveur ; si l'id est expiré, le CLI échoue et on le remonte).
export async function handlePiloteContinue(req, res) {
  const t = getTrigger(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: "trigger introuvable" });
  const p = (t.action && t.action.params) || {};
  const dir = p.repo_path || "";
  if (!dir || dir.startsWith("~")) return res.status(400).json({ ok: false, error: "dossier de travail non résolu" });
  const spawns = safeRegistry()
    .filter((e) => String(e.spawned_by || "").indexOf("trigger:" + t.id + ":") === 0)
    .sort((a, b) => new Date(b.spawned_at || 0) - new Date(a.spawned_at || 0));
  const withSession = spawns.find((e) => e.claude_session_id || e.session_id);
  if (!withSession) return res.status(400).json({ ok: false, error: "aucune session à reprendre" });
  const sid = withSession.claude_session_id || withSession.session_id;

  const contPrompt = "Reprends ta session précédente et poursuis ta mission là où tu t'étais arrêté. Sois concis, termine dès que c'est fait.";
  try {
    const r = await spawnHeadless(dir, contPrompt, {
      name: (p.name || t.id) + "-resume",
      role: p.role || "agent",
      model: p.model || "sonnet",
      allowedTools: p.allowedTools || null,
      maxTurns: p.max_turns || 15,
      appendSystemPrompt: p.append_system_prompt || null,
      resumeSessionId: sid,
      spawnedBy: "trigger:" + t.id + ":resume"
    });
    res.json({ ok: !!r.success, exitCode: r.exitCode, resumedFrom: sid, sessionId: r.sessionId || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── Transcript : retrouve le .jsonl de la dernière session et en extrait les tours ──
// Claude Code stocke les sessions sous ~/.claude/projects/<slug>/<sessionId>.jsonl ;
// le slug dépend du cwd, donc on cherche le fichier par son nom plutôt que de le deviner.
function findSessionFile(sessionId) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const target = sessionId + ".jsonl";
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, target);
      if (fs.existsSync(f)) return f;
    }
  } catch { /* pas de dossier projects */ }
  return null;
}

export function handlePiloteTranscript(req, res) {
  const t = getTrigger(req.params.id);
  if (!t) return res.status(404).json({ ok: false, error: "trigger introuvable" });
  const spawns = safeRegistry()
    .filter((e) => String(e.spawned_by || "").indexOf("trigger:" + t.id + ":") === 0)
    .sort((a, b) => new Date(b.spawned_at || 0) - new Date(a.spawned_at || 0));
  const withSession = spawns.find((e) => e.claude_session_id || e.session_id);
  if (!withSession) return res.json({ ok: true, turns: [], note: "aucune session enregistrée pour cet agent" });
  const sid = withSession.claude_session_id || withSession.session_id;
  const file = findSessionFile(sid);
  if (!file) return res.json({ ok: true, sessionId: sid, turns: [], note: "transcript introuvable (session purgée ?)" });
  try {
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const turns = [];
    for (const line of lines) {
      let o; try { o = JSON.parse(line); } catch { continue; }
      const m = o.message || o;
      const role = m.role || o.type;
      if (role !== "user" && role !== "assistant") continue;
      let text = "";
      const c = m.content;
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) {
        text = c.map((b) => b && b.type === "text" ? b.text
          : (b && b.type === "tool_use" ? "→ " + b.name
          : (b && b.type === "tool_result" ? "← résultat" : ""))).filter(Boolean).join("\n");
      }
      text = String(text || "").trim();
      if (text) turns.push({ role, text: text.slice(0, 1200) });
    }
    res.json({ ok: true, sessionId: sid, file, at: withSession.spawned_at || null, turns: turns.slice(-40) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── Architecte : conçoit un spec d'agent optimal à partir d'une intention NL ──
const ARCH_MODELS = ["haiku", "sonnet", "opus"];

function extractSpec(stdout) {
  const tryParse = (t) => {
    try { const s = t.indexOf("{"), e = t.lastIndexOf("}"); if (s < 0 || e < 0) return null; return JSON.parse(t.slice(s, e + 1)); }
    catch { return null; }
  };
  try {
    const env = JSON.parse(stdout);
    if (env && typeof env.result === "string") {
      const sp = tryParse(env.result.replace(/```json/gi, "").replace(/```/g, ""));
      if (sp) return sp;
    }
  } catch { /* stdout n'est pas l'enveloppe json */ }
  return tryParse(String(stdout || "").replace(/```json/gi, "").replace(/```/g, ""));
}

function validateSpec(sp) {
  const w = [];
  if (!sp || !sp.name) w.push("nom manquant");
  if (!sp || !sp.dir) w.push("dossier de travail à préciser");
  if (!sp || typeof sp.freq !== "string" || sp.freq.trim().split(/\s+/).length !== 5) w.push("cron non standard → 08:00 quotidien par défaut");
  if (sp && sp.model && !ARCH_MODELS.includes(String(sp.model).toLowerCase())) w.push("modèle inconnu → sonnet");
  return w;
}

function normalizeSpec(sp, universe) {
  sp = sp || {};
  const valid = Array.isArray(universe) && universe.length ? universe : BUILTIN_TOOLS;
  const freq = (typeof sp.freq === "string" && sp.freq.trim().split(/\s+/).length === 5) ? sp.freq.trim() : "0 8 * * *";
  let model = String(sp.model || "sonnet").toLowerCase();
  if (!ARCH_MODELS.includes(model)) model = "sonnet";
  // Moindre privilège : on ne garde que les outils réellement disponibles renvoyés
  // par l'architecte, sans inférer depuis la mission (les clauses d'interdiction
  // citent des outils qu'il ne faut justement PAS accorder). L'utilisateur ajuste.
  let tools = Array.isArray(sp.tools) ? sp.tools.filter((t) => valid.includes(t)) : [];
  if (!tools.length) tools = ["Bash"];
  if (!tools.includes("Bash")) tools.push("Bash"); // requis pour lire/écrire curseur + proposed-actions.json
  return {
    name: String(sp.name || "Agent").slice(0, 80),
    desc: String(sp.desc || "").slice(0, 160),
    dir: String(sp.dir || ""),
    freq, tz: sp.tz || "Europe/Paris",
    model, tools,
    max_turns: Number(sp.max_turns) || 15,
    cooldown_s: Number(sp.cooldown_s) || 3600,
    max_per_day: Number(sp.max_per_day) || 24,
    mission: String(sp.mission || "")
  };
}

export async function handlePiloteArchitect(req, res) {
  const intent = String((req.body && req.body.intent) || "").trim();
  if (!intent) return res.status(400).json({ ok: false, error: "intention requise" });
  try { fs.mkdirSync(ARCHITECT_DIR, { recursive: true }); } catch { /* */ }

  const mcp = await detectMcpServers();
  const universe = BUILTIN_TOOLS.concat(mcp.map((s) => s.allow));
  const toolList = BUILTIN_TOOLS.map((t) => "  " + t + "  (intégré)")
    .concat(mcp.map((s) => "  " + s.allow + "  (" + s.name + " — " + s.status + ")"))
    .join("\n");

  const prompt = [
    "Tu es l'ARCHITECTE d'agents planifiés du système WikiChat. À partir d'un besoin en langage naturel, tu conçois la spécification d'UN agent headless optimal (exécuté par `claude -p` déclenché par cron).",
    "",
    "Règles de conception impératives :",
    "- Moindre privilège : n'autorise QUE les outils strictement nécessaires (allowedTools).",
    "- Modèle adapté : 'haiku' pour surveillance/tri simple, 'sonnet' pour classement/extraction/rédaction, 'opus' uniquement pour raisonnement complexe.",
    "- Bornage : max_turns entre 8 et 20.",
    "- PLOMBERIE HÉRITÉE : un contrat système commun est déjà injecté dans l'agent (il PROPOSE dans .wikichat/proposed-actions.json ; pour chaque écriture il produit un objet apply auto-configuré + needs APRÈS introspection du schéma cible ; il gère un curseur ; il écrit puis vérifie par cat ; il n'écrit JAMAIS directement dans Grist/Gmail). NE répète PAS cette plomberie dans la mission.",
    "",
    "Le champ \"tools\" ne contient QUE des identifiants EXACTS de la liste ci-dessous (outils réellement disponibles), jamais de noms inventés. Inclus TOUJOURS Bash (lecture/écriture du curseur et de proposed-actions.json), et le strict nécessaire en plus (moindre privilège ; préfère les connecteurs 'connected') :",
    toolList,
    "Note : certains connecteurs sont des passerelles regroupant plusieurs services — mcp__claude_ai_BigMCP expose notamment Grist, GitHub et d'autres. Choisis le connecteur qui contient le service voulu (ex : écrire dans Grist → mcp__claude_ai_BigMCP).",
    "",
    "Besoin de l'utilisateur :",
    intent,
    "",
    "La 'mission' décrit UNIQUEMENT la LOGIQUE MÉTIER, en étapes numérotées : quelles données lire (et où), comment les traiter/classer/décider, et QUOI proposer. Ne mentionne pas la mécanique proposed-actions/apply/curseur/cat (héritée du contrat).",
    "",
    "Réponds STRICTEMENT par un unique objet JSON valide, sans prose ni balise markdown, de la forme :",
    '{"name":"","desc":"","dir":"~/...","freq":"m h * * *","tz":"Europe/Paris","model":"haiku|sonnet|opus","tools":["Bash"],"max_turns":10,"cooldown_s":3600,"max_per_day":24,"mission":"1. ...\\n2. ..."}'
  ].join("\n");

  try {
    const r = await spawnHeadless(ARCHITECT_DIR, prompt, {
      name: "pilote-architect",
      role: "architecte",
      model: "sonnet",
      allowedTools: ["Read"],
      maxTurns: 6,
      spawnedBy: "pilote:architect"
    });
    const raw = extractSpec(r.stdout);
    if (!raw) return res.status(502).json({ ok: false, error: "l'architecte n'a pas renvoyé de spec exploitable", sample: String(r.stdout || "").slice(0, 300) });
    res.json({ ok: true, spec: normalizeSpec(raw, universe), warnings: validateSpec(raw) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
