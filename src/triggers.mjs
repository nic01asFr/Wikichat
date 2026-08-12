/**
 * triggers.mjs — Declarative event-driven trigger engine.
 *
 * A trigger pairs an event source (cron, lifecycle, channel_match, …) with
 * an action (typically spawn_session). Triggers are persisted to
 * ~/.wikichat/triggers.json and survive restarts.
 *
 * Supported types in this initial cut:
 *   - cron       : node-cron schedule
 *   - lifecycle  : fires once at server boot if condition met
 *
 * Future types (file_watch, git_hook, channel_match, mention, threshold,
 * webhook) hook into the same dispatch path — see fireTrigger().
 *
 * Safety contract:
 *   - cooldown_s prevents rapid re-firing
 *   - max_per_day caps fires within 24h window
 *   - pre-flight checkBudget() refuses spawns when over WIKICHAT_MAX_SESSIONS
 *   - idempotent spawn: refuses if a session with the same name is alive
 *   - WIKICHAT_TRIGGERS_DISABLED=1 disables the whole engine
 */

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import cron from "node-cron";
import chokidar from "chokidar";
import { writeAtomicJSON } from "./persistence.mjs";
import { state, sysMsg } from "./state.mjs";
import { isActive, onWake } from "./dormant.mjs";
import { recall, knownAgentNames } from "./identity.mjs";

const TRIGGERS_FILE = path.join(os.homedir(), ".wikichat", "triggers.json");

/** In-memory registry of triggers. */
const _triggers = new Map();
/** node-cron task handles, keyed by trigger id. */
const _cronTasks = new Map();
/** chokidar watcher handles, keyed by trigger id. */
const _watchers = new Map();
/** Pending file_watch fires (debounce). */
const _watchDebounce = new Map();
/** Mention listeners, keyed by trigger id (predicate fn). */
const _mentionListeners = new Map();
/** Optional spawn function injected from outside (avoids circular import). */
let _spawnFn = null;
/** Optional budget checker. */
let _budgetCheckFn = null;
/** Optional routine runner — set by configureTriggers if available. */
let _routineFn = null;

let _saveTimer = null;
function _saveDebounced() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(_flush, 1000);
}
function _flush() {
  _saveTimer = null;
  try {
    const obj = Object.fromEntries(_triggers);
    writeAtomicJSON(TRIGGERS_FILE, obj);
  } catch { /* non-blocking */ }
}

function _isDisabled() {
  return process.env.WIKICHAT_TRIGGERS_DISABLED === "1";
}

/**
 * Wire the engine to the rest of the server. Called once at boot.
 *   spawnFn: (params) => Promise<{ success, ... }>  — handles spawn_session action
 *   budgetCheckFn: () => null | { error, current, max }
 */
export function configureTriggers({ spawnFn, budgetCheckFn, routineFn }) {
  _spawnFn = spawnFn || null;
  _budgetCheckFn = budgetCheckFn || null;
  _routineFn = routineFn || null;
}

// ── Rattrapage des crons manqués pendant le sommeil ──────────────────────────
//
// La dormant gate refuse tout fire quand aucune session nommée n'est ouverte.
// Or les routines de fond sont programmées la nuit — précisément aux heures où
// personne n'est là. Sans rattrapage, un cron nocturne ne s'exécute jamais :
// c'est ce qui a mis la chaîne de capitalisation à l'arrêt (digest quotidien
// à 22 h, dernier passage réel trois semaines plus tôt).
//
// Plutôt que d'empiler une file de jobs en attente, on recalcule ce qui était
// dû à partir de `schedule` + `last_fired` — les deux seules sources de vérité —
// et on relance UNE fois par trigger au réveil, quel que soit le nombre
// d'occurrences manquées. Les garde-fous habituels (cooldown, cap quotidien)
// restent en vigueur.

/** Développe un champ cron ("*", "1-5", "*∕15", "1,3") en ensemble de valeurs. */
export function parseCronField(f, min, max) {
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

/** Prochaine occurrence d'un schedule après `from`, ou null au-delà de 60 jours. */
export function cronNext(schedule, from) {
  const parts = String(schedule || "").trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const mins = parseCronField(parts[0], 0, 59), hrs = parseCronField(parts[1], 0, 23),
        doms = parseCronField(parts[2], 1, 31), mons = parseCronField(parts[3], 1, 12),
        dows = parseCronField(parts[4], 0, 6);
  const domStar = parts[2] === "*", dowStar = parts[4] === "*";
  let d = new Date(from.getTime() + 60000); d.setSeconds(0, 0);
  const limit = new Date(from.getTime() + 60 * 24 * 3600 * 1000);
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

/** Relance les crons dont une occurrence est passée pendant le sommeil. */
export async function catchupMissedCrons() {
  const now = new Date();
  const due = [..._triggers.values()].filter(t => {
    if (t.type !== "cron" || t.enabled === false) return false;
    const since = t.last_fired ? new Date(t.last_fired) : (t.created_at ? new Date(t.created_at) : null);
    if (!since || isNaN(since.getTime())) return false;
    const next = cronNext(t.config?.schedule, since);
    return !!(next && next <= now);
  });
  if (due.length === 0) return { fired: 0 };
  console.log(`[Triggers] Rattrapage au réveil : ${due.length} cron(s) en retard — ${due.map(t => t.id).join(", ")}`);
  let fired = 0;
  for (const t of due) {
    try {
      const r = await fireTrigger(t.id, { source: "catchup-wake" });
      if (r.ok) fired++;
    } catch { /* non bloquant */ }
  }
  return { fired, due: due.length };
}

/** Branche le rattrapage sur l'ouverture de la gate. À appeler une fois au boot. */
export function startCronCatchup() {
  onWake(() => { catchupMissedCrons().catch(() => { /* non bloquant */ }); });
}

export function loadTriggers() {
  try {
    if (!fs.existsSync(TRIGGERS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(TRIGGERS_FILE, "utf8"));
    for (const [id, t] of Object.entries(raw)) {
      // Même normalisation qu'à l'enregistrement : le fichier peut contenir des
      // configs sérialisées en chaîne, écrites avant que registerTrigger ne les
      // normalise. Les réparer ici évite de faire migrer triggers.json à la main.
      t.config = _asObject(t.config);
      if (t.action) t.action.params = _asObject(t.action.params);
      _triggers.set(id, t);
      // CRITICAL : activate the runtime side of each enabled trigger.
      // Without this, persisted triggers are "in memory" but their cron tasks /
      // chokidar watchers / channel_match listeners are never started → fired 0x.
      // Only lifecycle triggers were working before because runLifecycleTriggers()
      // is called explicitly elsewhere.
      if (t.enabled) {
        try { _activate(t); } catch (err) { console.warn(`[triggers] failed to activate ${id}: ${err.message}`); }
      }
    }
  } catch { /* ignore */ }
}

export function listTriggers() {
  return [..._triggers.values()];
}

export function getTrigger(id) {
  return _triggers.get(id) || null;
}

/**
 * Register a new trigger (or replace an existing one with the same id).
 * Returns the stored trigger object.
 */
/**
 * Les appelants MCP passent souvent `config` / `action.params` en JSON encodé
 * (le schéma est `z.any()`, qui accepte une chaîne sans broncher). Stockée
 * telle quelle, la chaîne fait échouer tous les accès `config.pattern` en
 * silence — et un channel_match sans pattern matche alors tout. On normalise
 * ici plutôt que chez chaque appelant.
 */
function _asObject(v) {
  if (typeof v !== "string") return v || {};
  try {
    const parsed = JSON.parse(v);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function registerTrigger(spec) {
  const id = spec.id || randomUUID().slice(0, 8);
  const action = spec.action ? { ...spec.action, params: _asObject(spec.action.params) } : spec.action;
  const trigger = {
    id,
    type: spec.type,
    config: _asObject(spec.config),
    action,
    enabled: spec.enabled !== false,
    cooldown_s: spec.cooldown_s ?? 30,
    max_per_day: spec.max_per_day ?? 100,
    last_fired: null,
    fire_count: 0,
    created_at: new Date().toISOString(),
    description: spec.description || "",
  };
  // If replacing an existing trigger, preserve fire stats
  const existing = _triggers.get(id);
  if (existing) {
    trigger.last_fired = existing.last_fired;
    trigger.fire_count = existing.fire_count;
    trigger.created_at = existing.created_at;
    _deactivate(existing);
  }
  _triggers.set(id, trigger);
  if (trigger.enabled) _activate(trigger);
  _saveDebounced();
  return trigger;
}

/** Identifiant du trigger générique de réveil. */
export const WAKE_TRIGGER_ID = "evt-wake-any";

/**
 * Garantit l'existence du trigger générique de réveil. Appelé au boot, après
 * loadTriggers().
 *
 * Un trigger par agent ne passerait pas l'échelle — il en faudrait un de plus à
 * chaque identité créée, et aucun pour les agents nés après le dernier boot.
 * Celui-ci écoute toutes les mentions assorties d'une demande de réponse et
 * laisse `_cibleDuReveil()` décider, message par message, s'il y a quelqu'un à
 * réveiller. Le cooldown est nul : la protection contre les doublons est par
 * cible (REVEIL_GARDE_MS), pas globale, sinon un réveil légitime en avalerait
 * un autre sans rapport.
 *
 * Idempotent, et respecte une désactivation manuelle : si le trigger existe
 * déjà — même désactivé — on n'y touche pas.
 */
export function ensureWakeTrigger() {
  if (_triggers.has(WAKE_TRIGGER_ID)) return _triggers.get(WAKE_TRIGGER_ID);
  return registerTrigger({
    id: WAKE_TRIGGER_ID,
    type: "mention",
    config: { target_name: "*" },
    action: { type: "spawn_session", params: { mode: "headless" } },
    cooldown_s: 0,
    max_per_day: 40,
    description: "Réveille l'agent nommé mentionné dans un message attendant une réponse, s'il est hors ligne",
  });
}

export function deleteTrigger(id) {
  const t = _triggers.get(id);
  if (!t) return false;
  _deactivate(t);
  _triggers.delete(id);
  _saveDebounced();
  return true;
}

export function setEnabled(id, enabled) {
  const t = _triggers.get(id);
  if (!t) return false;
  t.enabled = !!enabled;
  if (t.enabled) _activate(t); else _deactivate(t);
  _saveDebounced();
  return true;
}

/** Manually fire a trigger (bypasses cooldown only if force=true). */
export async function fireTrigger(id, { force = false, source = "manual", message = null } = {}) {
  const t = _triggers.get(id);
  if (!t) return { ok: false, reason: "not_found" };
  if (!force && _isDisabled()) return { ok: false, reason: "engine_disabled" };
  if (!force && !isActive()) return { ok: false, reason: "dormant" };
  if (!force && !_quotaOk(t)) return { ok: false, reason: "quota" };
  if (!force && _onCooldown(t)) return { ok: false, reason: "cooldown" };

  const result = await _runAction(t, source, message);
  t.last_fired = new Date().toISOString();
  t.fire_count = (t.fire_count || 0) + 1;
  _saveDebounced();
  return { ok: result.ok, reason: result.reason, detail: result.detail };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function _activate(t) {
  if (t.type === "cron") _startCron(t);
  if (t.type === "file_watch") _startFileWatch(t);
  if (t.type === "channel_match" || t.type === "mention") _startListener(t);
  // lifecycle / webhook fire on demand (boot or POST endpoint)
}

function _deactivate(t) {
  _stopCron(t.id);
  _stopFileWatch(t.id);
  _mentionListeners.delete(t.id);
}

function _startCron(t) {
  const schedule = t.config?.schedule;
  if (!schedule || !cron.validate(schedule)) return;
  try {
    const task = cron.schedule(schedule, () => {
      fireTrigger(t.id, { source: "cron" }).catch(() => {});
    }, { timezone: t.config?.tz || undefined });
    _cronTasks.set(t.id, task);
  } catch { /* invalid schedule, silently skip */ }
}

function _stopCron(id) {
  const task = _cronTasks.get(id);
  if (task) {
    try { task.stop(); } catch { /* */ }
    _cronTasks.delete(id);
  }
}

// ── file_watch ──────────────────────────────────────────────────────────────
// Path safety: only watch under home directory or absolute paths the operator
// explicitly registered. Always ignore .git/, node_modules/, .wikichat/.
function _startFileWatch(t) {
  const paths = Array.isArray(t.config?.paths) ? t.config.paths : [t.config?.path];
  const safePaths = paths.filter(p => typeof p === "string" && p.length > 0);
  if (safePaths.length === 0) return;
  const debounceMs = t.config?.debounce_ms ?? 500;
  try {
    const w = chokidar.watch(safePaths, {
      ignored: [/(^|[\/\\])\..*\.swp$/, /node_modules/, /\.git\//, /\.wikichat\//, /dist\//, /build\//],
      persistent: true,
      ignoreInitial: true,
      depth: t.config?.depth ?? 5,
    });
    w.on("all", (event, filePath) => {
      // Debounce per trigger id
      clearTimeout(_watchDebounce.get(t.id));
      _watchDebounce.set(t.id, setTimeout(() => {
        _watchDebounce.delete(t.id);
        fireTrigger(t.id, { source: `file_watch:${event}:${filePath}` }).catch(() => {});
      }, debounceMs));
    });
    _watchers.set(t.id, w);
  } catch { /* invalid path */ }
}

function _stopFileWatch(id) {
  const w = _watchers.get(id);
  if (w) {
    try { w.close(); } catch { /* */ }
    _watchers.delete(id);
  }
  const tm = _watchDebounce.get(id);
  if (tm) { clearTimeout(tm); _watchDebounce.delete(id); }
}

// ── channel_match / mention ─────────────────────────────────────────────────
function _startListener(t) {
  if (t.type === "mention") {
    const target = t.config?.target_name || t.config?.name;
    if (!target) return;
    // target_name "*" : trigger générique de réveil. Il écoute toute mention
    // assortie d'une demande de réponse, et laisse _runSpawnAction décider qui
    // réveiller. Un trigger par agent ne passerait pas l'échelle : 100 identités
    // aujourd'hui, une de plus à chaque agent créé.
    if (target === "*") {
      _mentionListeners.set(t.id, (msg) =>
        !!msg.expects_reply && /@[\w.-]{2,}/.test(msg.content || "")
      );
      return;
    }
    const rx = new RegExp(`@${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
    _mentionListeners.set(t.id, (msg) => rx.test(msg.content));
    return;
  }
  if (t.type === "channel_match") {
    const channel = t.config?.channel;
    // Sans canal ni pattern, le prédicat matcherait chaque message de chaque
    // canal — un spawn par message. On refuse d'activer plutôt que de laisser
    // une config incomplète se comporter comme un curseur universel.
    if (!channel && !t.config?.pattern) {
      console.warn(`[Triggers] "${t.id}" ignoré : channel_match sans channel ni pattern (matcherait tout).`);
      return;
    }
    let pattern = null;
    if (t.config?.pattern) {
      try {
        pattern = new RegExp(t.config.pattern, t.config?.flags || "i");
      } catch (err) {
        console.warn(`[Triggers] "${t.id}" ignoré : pattern invalide (${err.message}).`);
        return;
      }
    }
    _mentionListeners.set(t.id, (msg) => {
      if (channel && msg.channel !== channel) return false;
      if (pattern && !pattern.test(msg.content)) return false;
      return true;
    });
  }
}

/** Hook called by pushMessage upstream (wired in server.mjs) to test
 *  channel_match and mention triggers against new messages. */
export function notifyMessageForTriggers(msg) {
  if (_isDisabled() || !isActive()) return;
  for (const [id, predicate] of _mentionListeners) {
    try {
      if (predicate(msg)) {
        // Le message voyage avec le fire : un trigger générique (celui qui
        // réveille n'importe quel agent mentionné) doit pouvoir lire qui est
        // appelé, par qui, et ce qui lui est demandé.
        fireTrigger(id, { source: `${_triggers.get(id)?.type || "match"}:${msg.id}`, message: msg }).catch(() => {});
      }
    } catch { /* */ }
  }
}

/** Webhook : public hook to fire from REST endpoint. */
export async function fireWebhook(id, payload, sourceLabel = "webhook") {
  const t = _triggers.get(id);
  if (!t || t.type !== "webhook") return { ok: false, reason: "not_a_webhook" };
  return fireTrigger(id, { source: sourceLabel, payload });
}

function _onCooldown(t) {
  if (!t.last_fired) return false;
  const elapsed = (Date.now() - new Date(t.last_fired).getTime()) / 1000;
  return elapsed < (t.cooldown_s || 0);
}

function _quotaOk(t) {
  if (!t.last_fired) return true;
  const cap = t.max_per_day ?? 100;
  if (t.fire_count >= cap) {
    // Reset rolling window once 24h have passed since first fire of the day
    const dayMs = 24 * 60 * 60 * 1000;
    if (Date.now() - new Date(t.last_fired).getTime() > dayMs) {
      t.fire_count = 0;
      return true;
    }
    return false;
  }
  return true;
}

async function _runAction(t, source, message = null) {
  const action = t.action || {};
  if (action.type === "spawn_session") {
    return _runSpawnAction(t, action.params || {}, source, message);
  }
  if (action.type === "broadcast") {
    sysMsg(action.params?.channel || "coordination",
      `🔔 [trigger ${t.id}] ${action.params?.content || ""}`);
    return { ok: true };
  }
  if (action.type === "run_routine") {
    if (!_routineFn) return { ok: false, reason: "routine_runner_not_configured" };
    try {
      const res = await _routineFn(action.params?.id, action.params?.params || {}, {
        spawnedBy: `trigger:${t.id}:${source}`,
      });
      return { ok: !res.error && res.status !== "failed", detail: res };
    } catch (err) {
      return { ok: false, reason: "routine_threw", detail: err.message };
    }
  }
  return { ok: false, reason: `unknown_action:${action.type}` };
}

/**
 * Réveils déjà lancés, par nom d'agent → horodatage. Un agent réveillé met
 * plusieurs secondes à démarrer et à s'enregistrer ; pendant ce temps il n'est
 * pas « vivant », et deux messages successifs le mentionnant le spawneraient
 * deux fois. Ce délai de garde est PAR CIBLE, contrairement au cooldown du
 * trigger, qui est global : avec un seul trigger générique, un cooldown global
 * ferait qu'un réveil légitime en avale un autre, sans rapport.
 */
const _reveilsRecents = new Map();
/** Délai avant qu'un même agent puisse être réveillé à nouveau (démarrage en cours). */
const REVEIL_GARDE_MS = 120000;
/** Fenêtre pendant laquelle un agent réveillé ne peut pas en réveiller un autre. */
const ANTI_BOUCLE_MS = 3600000;

/** Un nom horodaté désigne un agent jeté après sa mission — rien à réveiller. */
function _estJetable(nom) {
  return /[-_]\d{9,}$|[-_]\d{4}-\d{2}-\d{2}$/.test(nom);
}

/**
 * Résout qui réveiller pour un trigger générique (`target_name: "*"`).
 *
 * Renvoie { name } ou { refus } — jamais null, pour qu'un refus porte sa raison
 * et remonte dans le résultat du fire plutôt que de disparaître en silence.
 */
function _cibleDuReveil(message) {
  if (!message) return { refus: "pas_de_message" };

  const auteur = (message.fromName || "").toLowerCase();
  // Anti-boucle : un agent lui-même réveillé ne peut pas en réveiller un autre.
  // Sans cela, A appelle B, B répond en mentionnant A, A est réveillé, répond à
  // son tour… La liste des réveils que nous avons nous-mêmes déclenchés est la
  // seule provenance fiable ici — un message ne porte pas son origine de spawn.
  const reveilAuteur = [..._reveilsRecents].find(([n]) => n.toLowerCase() === auteur)?.[1];
  if (reveilAuteur && Date.now() - reveilAuteur < ANTI_BOUCLE_MS) return { refus: "auteur_lui_meme_reveille" };

  const candidats = [...(message.content || "").matchAll(/@([\w.-]{2,})/g)].map(m => m[1]);
  for (const brut of candidats) {
    const nom = _resolveNomConnu(brut);
    if (!nom) continue;                                   // pas d'identité connue
    if (nom.toLowerCase() === auteur) continue;           // auto-mention
    if (_estJetable(nom)) continue;                       // agent horodaté, mission passée
    if ([...state.sessions.values()].some(s => s.name === nom)) continue; // déjà en ligne : son hook suffit
    const dernier = _reveilsRecents.get(nom);
    if (dernier && Date.now() - dernier < REVEIL_GARDE_MS) continue;      // réveil déjà en route
    return { name: nom };
  }
  return { refus: "aucune_cible_eligible" };
}

/** Un nom mentionné correspond-il à une identité mémorisée ? (casse ignorée) */
function _resolveNomConnu(brut) {
  const lc = brut.toLowerCase();
  return knownAgentNames().find(n => n.toLowerCase() === lc) || null;
}

async function _runSpawnAction(t, params, source, message = null) {
  if (!_spawnFn) return { ok: false, reason: "spawn_fn_not_configured" };

  // Trigger générique de réveil : la cible et son repo viennent du message.
  if ((t.config?.target_name || t.config?.name) === "*") {
    const cible = _cibleDuReveil(message);
    if (cible.refus) return { ok: false, reason: cible.refus };
    const repo = recall(cible.name, "__cwd");
    if (!repo || !fs.existsSync(repo)) return { ok: false, reason: "repo_inconnu" };
    const extrait = String(message.content || "").replace(/\s+/g, " ").slice(0, 300);
    params = {
      ...params,
      name: cible.name,
      repo_path: repo,
      mode: "headless",
      // Reprendre la session Claude Code de cet agent quand son transcript est
      // encore là : réveillé avec son historique, il sait déjà de quoi on parle.
      // resolveResumeSession() retombe sur un démarrage frais si le transcript
      // manque ou dépasse la taille admise.
      resumeSessionId: recall(cible.name, "__claude_session_id") || undefined,
      // L'agent réveillé doit savoir POURQUOI il est là. Sans cela il découvre un
      // message dans sa boîte sans comprendre ce qui l'a lancé — vécu : un agent
      // réveillé par trigger a répondu « aucun wake automatique, je suis headless ».
      prompt:
        `${message.fromName || "Un agent"} t'appelle et attend une réponse :\n\n` +
        `« ${extrait} »\n\n` +
        `Tu es "${cible.name}". Tu as été réveillé pour ce message précis. ` +
        `register(name="${cible.name}", claude_session_id="$CLAUDE_SESSION_ID"), relève avec poll(), ` +
        `réponds via send_message(channel="@${message.fromName}", status="over"), ` +
        `consigne ce qui doit survivre (add_project_note / remember), puis termine.`,
    };
    _reveilsRecents.set(cible.name, Date.now());
    console.log(`[Triggers] Réveil de "${cible.name}" demandé par ${message.fromName} (${repo})`);
  }

  // Pre-flight: budget
  if (_budgetCheckFn) {
    const budget = _budgetCheckFn();
    if (budget) return { ok: false, reason: "budget", detail: budget };
  }

  // Pre-flight: idempotence (don't re-spawn if name already alive)
  if (params.name) {
    const alive = [...state.sessions.values()].some(s => s.name === params.name);
    if (alive) return { ok: false, reason: "already_running" };
  }

  try {
    const result = await _spawnFn({ ...params, spawnedBy: `trigger:${t.id}:${source}` });
    sysMsg("coordination",
      `🔔 [trigger ${t.id}] ${result?.success ? "✅" : "❌"} spawn "${params.name}" (${params.mode || "headless"})`);
    return { ok: !!result?.success, detail: result };
  } catch (err) {
    return { ok: false, reason: "spawn_threw", detail: err.message };
  }
}

/**
 * Run all `lifecycle` triggers at boot.
 * Lifecycle triggers fire once during startup if their condition is met.
 * Condition (`config.condition`) currently supports:
 *   - "always"
 *   - "if_no_session_named:<name>"  → fires if no live session with that name
 */
export async function runLifecycleTriggers() {
  if (_isDisabled()) return;
  for (const t of _triggers.values()) {
    if (t.type !== "lifecycle" || !t.enabled) continue;
    if (!_lifecycleConditionMet(t)) continue;
    fireTrigger(t.id, { source: "lifecycle" }).catch(() => {});
  }
}

function _lifecycleConditionMet(t) {
  const cond = t.config?.condition || "always";
  if (cond === "always") return true;
  if (cond.startsWith("if_no_session_named:")) {
    const name = cond.slice("if_no_session_named:".length);
    const alive = [...state.sessions.values()].some(s => s.name === name);
    return !alive;
  }
  return false;
}

/** Stop all active cron tasks + watchers. Called at graceful shutdown. */
export function shutdownTriggers() {
  for (const id of [..._cronTasks.keys()]) _stopCron(id);
  for (const id of [..._watchers.keys()]) _stopFileWatch(id);
  _mentionListeners.clear();
  _flush();
}
