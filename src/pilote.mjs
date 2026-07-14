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
import { isActive } from "./dormant.mjs";
import { spawnHeadless } from "./sampler.mjs";

// ── Page ────────────────────────────────────────────────────────────────────
export function handlePilotePage(_req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(readFileSync(join(process.cwd(), "public", "pilote.html")));
}

// Espace de travail neutre de l'architecte (évite de polluer le repo courant).
const ARCHITECT_DIR = path.join(os.tmpdir(), "wikichat-architect");

// ── Détection réelle des outils disponibles ─────────────────────────────────
// Built-ins Claude Code sûrs pour des agents planifiés + serveurs MCP réels de
// l'utilisateur (via `claude mcp list`, mis en cache 5 min car il fait des
// health-checks réseau lents).
const BUILTIN_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"];
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
      status: a.status || "pending"
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

  const tools = Array.isArray(p.allowedTools) && p.allowedTools.length
    ? p.allowedTools.map((n) => ({ name: n, perm: "--allowedTools" }))
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

  res.json({
    active: safeActive(),
    daemon: { armed, total: agents.length, wake: humanNext(wakeDate, now), wakeAgent },
    agents
  });
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
  try {
    const spec = {
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
          allowedTools: tools,
          max_turns: b.max_turns != null ? Number(b.max_turns) : 15,
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
    res.json({ ok: true, id: t.id });
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
  if (!dir || dir.startsWith("~")) return res.json({ ok: true, persisted: false, note: "dossier non résolu — décision non persistée" });
  try {
    const p = path.join(dir, ".wikichat", "proposed-actions.json");
    if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: "aucune proposition sur disque" });
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const arr = Array.isArray(raw) ? raw : (raw.actions || []);
    let found = false;
    arr.forEach((a, i) => {
      if ((a.id || ("p" + i)) === body.actionId) { a.status = decision; a.decided_at = new Date().toISOString(); found = true; }
    });
    if (!found) return res.status(404).json({ ok: false, error: "action introuvable" });
    fs.writeFileSync(p, JSON.stringify(raw, null, 2));
    try { fs.appendFileSync(path.join(dir, ".wikichat", "decisions.jsonl"), JSON.stringify({ at: new Date().toISOString(), actionId: body.actionId, decision }) + "\n"); } catch { /* */ }
    res.json({ ok: true, persisted: true, decision });
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
      allowedTools: p.allowedTools || null,
      maxTurns: p.max_turns || 15,
      spawnedBy: "trigger:" + t.id + ":apply"
    });
    res.json({ ok: !!r.success, exitCode: r.exitCode, sessionId: r.sessionId || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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
      resumeSessionId: sid,
      spawnedBy: "trigger:" + t.id + ":resume"
    });
    res.json({ ok: !!r.success, exitCode: r.exitCode, resumedFrom: sid, sessionId: r.sessionId || null });
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
    "- Agent NON destructif : il PROPOSE ses actions dans .wikichat/proposed-actions.json (tableau d'objets {id, title, sub, kind, amount, status:'pending', apply:{...}}) et n'exécute JAMAIS d'écriture externe (Grist/Gmail/API) sans validation humaine.",
    "- Application DÉTERMINISTE : chaque proposition DOIT porter un objet \"apply\" machine-exécutable décrivant l'écriture EXACTE que l'applicateur fera après validation — jamais une consigne vague. Ex Grist : apply={\"tool\":\"add_grist_records\",\"doc\":\"<docId>\",\"table\":\"<Table>\",\"fields\":{...}} où fields mappe les VRAIES colonnes (obtenues via list_columns à l'exécution). Ex Gmail : apply={\"op\":\"archive|label\",\"threadId\":\"...\",\"label\":\"...\"}. L'applicateur exécutera cet objet TEL QUEL, sans deviner.",
    "- Idempotence : lit et met à jour un curseur .wikichat/<slug>-cursor.json pour ne pas retraiter les mêmes données.",
    "- Persistance VÉRIFIÉE : la mission se termine TOUJOURS par — écrire proposed-actions.json via Bash, PUIS le relire avec `cat` et ne conclure que si le JSON s'affiche (un agent headless résume sinon sans persister le fichier).",
    "- Bornage : max_turns entre 8 et 20.",
    "",
    "Le champ \"tools\" ne contient QUE des identifiants EXACTS de la liste ci-dessous (outils réellement disponibles), jamais de noms inventés. Inclus TOUJOURS Bash (lecture/écriture du curseur et de proposed-actions.json), et le strict nécessaire en plus (moindre privilège ; préfère les connecteurs 'connected') :",
    toolList,
    "Note : certains connecteurs sont des passerelles regroupant plusieurs services — mcp__claude_ai_BigMCP expose notamment Grist, GitHub et d'autres. Choisis le connecteur qui contient le service voulu (ex : écrire dans Grist → mcp__claude_ai_BigMCP).",
    "",
    "Besoin de l'utilisateur :",
    intent,
    "",
    "La 'mission' doit être une procédure numérotée claire et exécutable : lecture du curseur, traitement, PROPOSITION dans .wikichat/proposed-actions.json, mise à jour du curseur, interdiction d'écrire sans validation.",
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
