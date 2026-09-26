/**
 * routines.mjs — Named, parameterized, idempotent multi-step workflows.
 *
 * A routine is a composable workflow built from atomic steps. It's the
 * top of the runtime stack: triggers fire routines, routines call dispatch
 * or spawn, and the system keeps a structured log of every execution.
 *
 * Persisted in ~/.wikichat/routines.json. Run history in ~/.wikichat/routine-runs.jsonl.
 *
 * Step types supported in this initial cut:
 *   - spawn     : { name, repo_path, mode, role?, task?, parentDepth?, permission_mode? } → ticket
 *
 * permission_mode (routine ou step) : default | acceptEdits | plan | dontAsk |
 * bypassPermissions. Absent : acceptEdits. Lu dans la définition seulement.
 *   - broadcast : { channel, content }                                  → message id
 *   - wait      : { tickets:[...], timeout_s? }                         → resolved when all complete
 *   - summarize : { artifacts:[...], target?, title? }                  → broadcast a summary
 *   - sleep     : { seconds }                                           → simple delay
 *   - job       : { job, args? }                                        → appelle une fonction JS
 *                 du catalogue (src/jobs/index.mjs) : run_cartography, run_clustering,
 *                 harmonize_ideas, audit_all_projects, scan_changes, absorb_closures.
 *                 Aucun agent, aucun modèle.
 *
 * Steps support param interpolation via `{paramName}` and outputs of
 * previous steps via `{stepN.field}` (e.g. `{step0.ticket}`).
 *
 * Routines are idempotent by `run_key` (optional). Re-running with the same
 * key within `cache_seconds` (default 300) returns the cached run record.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { writeAtomicJSON } from "./persistence.mjs";
import { executerJob, nomDuJob } from "./jobs/index.mjs";
import { politiqueDeBranche } from "./lancement.mjs";

/** Actions qu'une étape peut porter. Une action inconnue est refusée à l'enregistrement. */
export const ACTIONS_ETAPE = Object.freeze(["spawn", "broadcast", "wait", "summarize", "sleep", "job"]);
/** Actions qui ne lancent aucun agent : du code. */
const ACTIONS_CODE = new Set(["broadcast", "wait", "summarize", "sleep", "job"]);

/**
 * Vrai si la routine ne lance aucun agent (toutes ses étapes sont du code).
 * Décision J-c : la porte dormante ne s'applique qu'à ce qui lance un agent.
 */
export function routineEstDuCode(idOuDef) {
  const def = typeof idOuDef === "string" ? _routines.get(idOuDef) : idOuDef;
  return !!def && Array.isArray(def.steps) && def.steps.length > 0 && def.steps.every(st => ACTIONS_CODE.has(st?.action));
}

const ROUTINES_FILE = path.join(os.homedir(), ".wikichat", "routines.json");
const RUNS_FILE = path.join(os.homedir(), ".wikichat", "routine-runs.jsonl");

/** Map<id, RoutineDef> */
const _routines = new Map();
/** Map<run_key, { runId, startedAt, result }> — for idempotence */
const _recentRuns = new Map();

/** Optional callbacks injected from outside (avoid circular imports) */
let _ctx = {
  spawn: null,        // (params) => Promise<{ success, ticketId?, ... }>
  broadcast: null,    // ({channel, content}) => { id }
  pollTicket: null,   // (ticketId, timeoutS) => Promise<ticket>
  shareArtifact: null, // ({channel, title, content}) => { id }
};

let _saveTimer = null;
function _saveDebounced() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(_flush, 1000);
}
function _flush() {
  _saveTimer = null;
  try { writeAtomicJSON(ROUTINES_FILE, Object.fromEntries(_routines)); } catch { /* */ }
}

export function configureRoutines(ctx) {
  _ctx = { ..._ctx, ...ctx };
}

export function loadRoutines() {
  try {
    if (!fs.existsSync(ROUTINES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ROUTINES_FILE, "utf8"));
    for (const [id, def] of Object.entries(raw)) _routines.set(id, def);
  } catch { /* ignore */ }
}

export function listRoutines() {
  return [..._routines.values()];
}

export function getRoutine(id) {
  return _routines.get(id) || null;
}

export function registerRoutine(spec) {
  if (!spec.id) throw new Error("routine.id required");
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    throw new Error("routine.steps must be a non-empty array");
  }
  // Une étape d'action inconnue échouait à chaque exécution, jamais à
  // l'enregistrement (vécu sur le pod : 35 échecs « unknown action:
  // send_message »). On le dit tout de suite.
  spec.steps.forEach((st, i) => {
    if (!ACTIONS_ETAPE.includes(st?.action)) {
      throw new Error(`étape ${i} : action "${st?.action}" inconnue (connues : ${ACTIONS_ETAPE.join(", ")})`);
    }
    if (st.action === "job" && !nomDuJob(st.params?.job ?? st.params?.name)) {
      throw new Error(`étape ${i} : job "${st.params?.job ?? st.params?.name}" inconnu`);
    }
  });
  const existing = _routines.get(spec.id);
  const def = {
    id: spec.id,
    description: spec.description || "",
    params: spec.params || {},
    steps: spec.steps,
    cache_seconds: spec.cache_seconds ?? 300,
    // Mode de permission des agents que la routine lance. Absent : acceptEdits.
    // bypassPermissions n'est honoré que s'il est écrit ici ou dans le step.
    ...(spec.permission_mode ? { permission_mode: String(spec.permission_mode) } : {}),
    // J-b3 : où travaillent les agents de la routine (auto : sur une branche).
    ...(spec.branche ? { branche: politiqueDeBranche(spec.branche) } : {}),
    enabled: spec.enabled !== false,
    created_at: existing?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    run_count: existing?.run_count ?? 0,
    last_run_at: existing?.last_run_at || null,
    last_run_status: existing?.last_run_status || null,
  };
  _routines.set(spec.id, def);
  _saveDebounced();
  return def;
}

export function deleteRoutine(id) {
  if (!_routines.has(id)) return false;
  _routines.delete(id);
  _saveDebounced();
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a routine. Returns { runId, status, steps, result, error? }.
 * Idempotent : if run_key was used recently, returns the cached result.
 */
export async function runRoutine(id, params = {}, opts = {}) {
  const def = _routines.get(id);
  if (!def) return { error: `routine "${id}" not found` };
  if (!def.enabled) return { error: `routine "${id}" disabled` };

  // Idempotence cache
  if (opts.run_key) {
    const cached = _recentRuns.get(opts.run_key);
    if (cached && (Date.now() - cached.startedAt) < def.cache_seconds * 1000) {
      return { ...cached.result, cached: true };
    }
  }

  const runId = randomUUID().slice(0, 8);
  const startedAt = Date.now();
  const stepResults = [];
  let status = "completed";
  let error = null;

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i];
    try {
      const resolved = _resolveStep(step, params, stepResults);
      // L'origine d'un lancement nomme la routine : l'Atelier plafonne par origine.
      const out = await _executeStep(resolved, { ...opts, routineId: opts.routineId || id, permission: modeDeLaDefinition(def, step), politiqueBranche: brancheDeLaDefinition(def, step) });
      stepResults.push({ step: i, action: step.action, output: out });
    } catch (err) {
      status = "failed";
      error = `step ${i} (${step.action}) failed: ${err.message}`;
      stepResults.push({ step: i, action: step.action, error: err.message });
      break;
    }
  }

  const finishedAt = Date.now();
  const result = { runId, routineId: id, status, steps: stepResults, durationMs: finishedAt - startedAt, error };

  // Update routine stats + persist
  def.run_count = (def.run_count || 0) + 1;
  def.last_run_at = new Date(finishedAt).toISOString();
  def.last_run_status = status;
  _saveDebounced();

  // Append to run log (append-only JSONL)
  try {
    fs.mkdirSync(path.dirname(RUNS_FILE), { recursive: true });
    fs.appendFileSync(RUNS_FILE, JSON.stringify({ ...result, params, startedAt: new Date(startedAt).toISOString() }) + "\n");
  } catch { /* */ }

  // Cache for idempotence
  if (opts.run_key) {
    _recentRuns.set(opts.run_key, { runId, startedAt, result });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step internals
// ─────────────────────────────────────────────────────────────────────────────

/** Replace `{name}` in any string field of step.params with values from
 *  params or previous step outputs. Returns a new step. */
function _resolveStep(step, params, prevResults) {
  // Auto-inject {ts} (Unix timestamp) so all spawned agents have a unique
  // suffix without the caller having to provide it. Allows agents named
  // "FooAgent-{ts}" to all get distinct names per spawn.
  const enrichedParams = { ts: Math.floor(Date.now() / 1000), ...params };
  params = enrichedParams;
  const interpolated = JSON.parse(JSON.stringify(step));
  function walk(obj) {
    if (typeof obj === "string") {
      return obj.replace(/\{([^}]+)\}/g, (_, key) => {
        if (key in params) return params[key];
        const m = key.match(/^step(\d+)\.(.+)$/);
        if (m) {
          const idx = parseInt(m[1]);
          const path = m[2];
          const stepRes = prevResults[idx]?.output;
          return stepRes && path in stepRes ? stepRes[path] : `{${key}}`;
        }
        return `{${key}}`;
      });
    }
    if (Array.isArray(obj)) return obj.map(walk);
    if (obj && typeof obj === "object") {
      const out = {};
      for (const k of Object.keys(obj)) out[k] = walk(obj[k]);
      return out;
    }
    return obj;
  }
  if (interpolated.params) interpolated.params = walk(interpolated.params);
  return interpolated;
}

/**
 * Le mode de permission d'un step `spawn`, lu dans la DÉFINITION de la routine
 * (step brut, puis routine) — jamais dans les paramètres d'exécution. Une
 * valeur à interpoler (`{mode}`) est ignorée : un appelant de run_routine ne
 * doit pas pouvoir lever les garde-fous d'une routine qu'il n'a pas écrite.
 */
export function brancheDeLaDefinition(def, step) {
  const brut = step?.params?.branche ?? def?.branche ?? "auto";
  if (typeof brut !== "string" || brut.includes("{")) return "auto";
  try { return politiqueDeBranche(brut); } catch { return "auto"; }
}

export function modeDeLaDefinition(def, step) {
  const brut = step?.params?.permission_mode ?? def?.permission_mode ?? null;
  if (!brut || typeof brut !== "string" || brut.includes("{")) return null;
  return brut;
}

async function _executeStep(step, opts) {
  const action = step.action;
  const p = step.params || {};
  switch (action) {
    case "spawn": {
      if (!_ctx.spawn) throw new Error("spawn handler not configured");
      const { permission_mode: _ignore, permissionMode: _ignore2, bypassAutorise: _ignore3, branche: _ignore4, ...reste } = p;
      const res = await _ctx.spawn({
        ...reste,
        permission_mode: opts.permission || null,
        bypassAutorise: Boolean(opts.permission),
        // Une routine est un travail planifié : en `auto`, sur une branche.
        politiqueBranche: opts.politiqueBranche || "auto",
        planifie: true,
        spawnedBy: opts.spawnedBy || `routine:${opts.routineId || "?"}`,
        parentDepth: opts.parentDepth ?? 0,
      });
      if (!res.success) throw new Error(res.error || "spawn failed");
      return { ticket: res.ticketId || res.ticket || null, name: p.name, pid: res.pid };
    }
    case "broadcast": {
      if (!_ctx.broadcast) throw new Error("broadcast handler not configured");
      const out = _ctx.broadcast({ channel: p.channel || "coordination", content: p.content });
      return { id: out?.id || null };
    }
    case "wait": {
      if (!_ctx.pollTicket) throw new Error("pollTicket handler not configured");
      const tickets = Array.isArray(p.tickets) ? p.tickets.filter(Boolean) : [];
      const timeoutS = p.timeout_s ?? 120;
      const results = await Promise.all(tickets.map(t => _ctx.pollTicket(t, timeoutS)));
      return { tickets: results };
    }
    case "summarize": {
      if (!_ctx.shareArtifact) throw new Error("shareArtifact handler not configured");
      const items = Array.isArray(p.artifacts) ? p.artifacts : [];
      const lines = items.map((a, i) => `## Item ${i + 1}\n${typeof a === "string" ? a : JSON.stringify(a, null, 2)}`);
      const content = `# ${p.title || "Routine summary"}\n\n${lines.join("\n\n")}`;
      const out = _ctx.shareArtifact({
        channel: p.target || "coordination",
        title: p.title || "Routine summary",
        type: "text",
        content,
      });
      return { id: out?.id || null };
    }
    case "job": {
      // Appel direct d'une fonction JS : le résultat est un résumé JSON.
      return await executerJob(p.job ?? p.name, p.args || {});
    }
    case "sleep": {
      const ms = (p.seconds ?? 1) * 1000;
      await new Promise(r => setTimeout(r, ms));
      return { slept: p.seconds ?? 1 };
    }
    default:
      throw new Error(`unknown action: ${action}`);
  }
}
