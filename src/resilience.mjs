/**
 * resilience.mjs — Watchdog, cron persistence, heartbeat, spawn retry.
 *
 * Responsibilities:
 *  - Persist cron job registrations to disk (survive server restart)
 *  - Session watchdog: detect stale/dead spawned sessions and auto-respawn
 *  - Heartbeat tracking: update lastSeen, flag dead sessions
 *  - Spawn retry queue: if a spawn fails, retry with backoff
 */

import fs from "fs";
import path from "path";
import { state, getSessionName } from "./state.mjs";
import { writeAtomicJSON, AGENTS_DIR } from "./persistence.mjs";
import { emitEvent } from "./events.mjs";

const CRON_REGISTRY = path.join(process.cwd(), "crons.json");

// ── Cron persistence ──────────────────────────────────────────────────────────

/**
 * Load cron registry from disk. Returns [] if file is missing or corrupt.
 */
export function loadCronRegistry() {
  try {
    return fs.existsSync(CRON_REGISTRY)
      ? JSON.parse(fs.readFileSync(CRON_REGISTRY, "utf8"))
      : [];
  } catch {
    return [];
  }
}

/**
 * Save cron registry to disk atomically.
 * @param {Array} entries
 */
export function saveCronRegistry(entries) {
  writeAtomicJSON(CRON_REGISTRY, entries);
}

/**
 * Atomic upsert of a cron entry by job_id.
 * @param {Object} entry — must have job_id
 */
export function upsertCron(entry) {
  const reg = loadCronRegistry();
  const idx = reg.findIndex(e => e.job_id === entry.job_id);
  if (idx >= 0) {
    reg[idx] = { ...reg[idx], ...entry };
  } else {
    reg.push({
      job_id: entry.job_id,
      session_name: entry.session_name ?? null,
      purpose: entry.purpose ?? null,
      interval_minutes: entry.interval_minutes ?? null,
      command: entry.command ?? null,
      created_at: entry.created_at ?? new Date().toISOString(),
      last_run: entry.last_run ?? null,
      active: entry.active ?? true,
    });
  }
  saveCronRegistry(reg);
}

/**
 * Mark a cron entry as inactive (soft delete) by job_id.
 * @param {string} jobId
 */
export function deleteCron(jobId) {
  const reg = loadCronRegistry();
  const idx = reg.findIndex(e => e.job_id === jobId);
  if (idx >= 0) {
    reg[idx].active = false;
    saveCronRegistry(reg);
  }
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

/**
 * Update lastSeen for a session and write a heartbeat file to agents/<name>/heartbeat.json.
 * @param {string} sessionId
 */
export function recordHeartbeat(sessionId) {
  const session = state.sessions.get(sessionId);
  if (!session) return;

  session.lastSeen = new Date();

  const name = getSessionName(sessionId);
  const agentDir = path.join(AGENTS_DIR, name);
  const heartbeatPath = path.join(agentDir, "heartbeat.json");

  try {
    fs.mkdirSync(agentDir, { recursive: true });
    writeAtomicJSON(heartbeatPath, {
      name,
      sessionId,
      ts: new Date().toISOString(),
      availability: session.availability ?? "available",
    });
  } catch { /* non-blocking */ }
}

// ── Watchdog ──────────────────────────────────────────────────────────────────

const STALE_THRESHOLD_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Start a watchdog that runs every 60 seconds.
 *
 * @param {Object} appState  — shared in-memory state (state.sessions, etc.)
 * @param {Function} spawnRegistryLoader — () => Array of spawn registry entries
 * @param {Function} respawnFn — async (entry) => void, called when auto-respawn needed
 * @param {Function} pushUpdate — () => void, called after each cycle
 * @returns {NodeJS.Timeout} — interval handle for stopWatchdog()
 */
export function startWatchdog(appState, spawnRegistryLoader, respawnFn, pushUpdate) {
  const handle = setInterval(async () => {
    const now = Date.now();

    // 1. Mark stale sessions
    for (const [, session] of appState.sessions) {
      if (
        session.lastSeen &&
        now - new Date(session.lastSeen).getTime() > STALE_THRESHOLD_MS &&
        session.availability !== "stale"
      ) {
        session.availability = "stale";
        const mins = Math.round(STALE_THRESHOLD_MS / 60000);
        console.log(`[Watchdog] Session "${session.name}" marked stale (no activity for ${mins}min)`);
        emitEvent("stale", `${session.name} sans activité depuis ${mins} min`, { agent: session.name });
      }
    }

    // 2. Auto-respawn dead spawned sessions
    let spawnRegistry;
    try {
      spawnRegistry = spawnRegistryLoader();
    } catch {
      spawnRegistry = [];
    }

    for (const entry of spawnRegistry) {
      if (entry.type !== "spawned") continue;
      if (!entry.autoRespawn) continue;

      const live = [...appState.sessions.values()].find(s => s.name === entry.name);
      if (!live) {
        console.log(`[Watchdog] "${entry.name}" not found — attempting auto-respawn…`);
        try {
          await respawnFn(entry);
        } catch (err) {
          console.error(`[Watchdog] Respawn failed for "${entry.name}":`, err.message);
        }
      }
    }

    // 3. Check overdue cron agents
    let crons;
    try {
      crons = loadCronRegistry();
    } catch {
      crons = [];
    }

    for (const cron of crons) {
      if (!cron.active) continue;
      if (!cron.interval_minutes) continue;

      const intervalMs = cron.interval_minutes * 60 * 1000;
      const lastRunMs = cron.last_run ? new Date(cron.last_run).getTime() : null;
      const overdue = lastRunMs === null || now - lastRunMs > intervalMs * 1.5;

      if (overdue) {
        console.warn(
          `[Watchdog] Cron "${cron.job_id}" (${cron.session_name}) may be dead — ` +
          `last_run: ${cron.last_run ?? "never"}, interval: ${cron.interval_minutes}min`
        );
      }
    }

    // 4. Notify dashboard
    try {
      pushUpdate();
    } catch { /* non-blocking */ }
  }, 60 * 1000);

  return handle;
}

/**
 * Stop a watchdog interval.
 * @param {NodeJS.Timeout} handle
 */
export function stopWatchdog(handle) {
  clearInterval(handle);
}

// ── Instruction constants ─────────────────────────────────────────────────────

/**
 * LOCAL-FIRST PROTOCOL — principe fondateur de toute action agent.
 *
 * Règle absolue : écrire localement AVANT d'essayer WikiChat MCP.
 * Les fichiers locaux sont la vérité. WikiChat est le canal de diffusion.
 * Si WikiChat est down, les fichiers locaux permettent la reconstruction complète.
 */
export const LOCAL_FIRST_INSTRUCTIONS = `## Protocole LOCAL-FIRST (obligatoire)

### Principe
Écris TOUJOURS localement avant d'essayer WikiChat MCP.
Les fichiers locaux = source de vérité permanente.
WikiChat MCP = canal de diffusion (optionnel, peut être indisponible).

### Pour chaque résultat ou rapport produit:
1. Écrire dans .wikichat/artifacts/<timestamp>_<titre>.md (toujours, sans condition)
2. PUIS tenter share_artifact sur WikiChat
3. Si WikiChat MCP échoue → le fichier local est déjà là, c'est suffisant

### Format fichier artifact local:
\`\`\`
# <Titre>
_type: <plan|text|json|code> | channel: <canal cible> | agent: <ton nom>_

<contenu>
\`\`\`

### Pour chaque action ou décision:
1. Écrire dans .wikichat/queue/<timestamp>-<nom>.json si MCP unavailable:
\`\`\`json
{
  "type": "update|task_done|message|artifact",
  "agent": "<nom>",
  "project": "<slug>",
  "ts": "<ISO>",
  "data": { "message": "...", "title": "...", "content": "..." }
}
\`\`\`
2. Le service pickup ce fichier dans les 2 minutes

### Pour lire l'état du projet sans MCP:
- .wikichat/context.json → état courant (mis à jour par le service)
- .wikichat/artifacts/ → tous les rapports produits par les agents
- .wikichat/queue/processed/ → historique des actions traitées
- ~/.wikichat/projects/<slug>/wikichat.json → état canonique central

### Règle d'or
Un agent qui ne peut pas joindre WikiChat MCP n'est PAS bloqué.
Il lit context.json, fait son travail, écrit dans artifacts/, et termine.
Le coordinateur lira les fichiers locaux pour récupérer le rapport.`;

export const POLL_INSTRUCTIONS = `## Pattern poll_messages (résilient)

poll_messages est un long-poll (timeout 25s par défaut).
Si la connexion SSE tombe ou que le poll retourne une erreur:

1. Écrire l'état courant dans .wikichat/artifacts/ (LOCAL-FIRST)
2. Attendre 2s (backoff minimal)
3. Rappeler register() pour vérifier que la session est encore active
4. Si register() répond "nom déjà pris" → appeler resume_session()
5. Relancer poll_messages avec le dernier since_id connu

Boucle recommandée:
  loop:
    result = poll_messages(channel, since_id, timeout_ms=25000)
    if result.messages → traiter, mettre à jour since_id
    if result.timeout  → relancer directement (normal)
    if result.error    → écrire queue/ → backoff 2s → register/resume → relancer`;

export const CRON_INSTRUCTIONS = `## Pattern cron (résilient)

Un cron agent doit:
1. À chaque réveil: écrire heartbeat dans .wikichat/artifacts/heartbeat-<nom>.json
2. Appeler ping() si MCP disponible — sinon le fichier local suffit
3. Appeler register_cron(job_id, purpose, interval_minutes) si MCP disponible
4. Effectuer son travail
5. Écrire le résultat dans .wikichat/artifacts/ (LOCAL-FIRST, toujours)
6. PUIS tenter share_artifact sur WikiChat

Si MCP indisponible: tout va dans .wikichat/queue/ et .wikichat/artifacts/.
Le service pickup et reconstruit l'état au prochain cycle (toutes les 2min).

Si un cron agent ne se manifeste pas pendant 1.5x son intervalle,
le watchdog signale l'agent mort. Le coordinateur lit les artifacts locaux
pour comprendre ce qui s'est passé.`;

export const SPAWN_INSTRUCTIONS = `## Pattern spawn/respawn (résilient)

spawn_session crée un processus enfant. En cas d'échec:
1. Le service retente jusqu'à 3 fois avec backoff exponentiel (2s, 4s, 8s)
2. Si le spawn échoue définitivement → status="failed" dans spawn_registry.json
3. Pour respawn manuel: appeler respawn_session(name)

Un agent spawné doit AU DÉMARRAGE:
1. Lire .wikichat/context.json pour le contexte projet (fonctionne sans MCP)
2. Tenter register() sur WikiChat — si échec, continuer quand même
3. Appeler resume_session() si register() a réussi
4. Écrire dans .wikichat/artifacts/startup-<nom>-<ts>.md : nom, rôle, mission, timestamp

EN CAS D'ÉCHEC TOTAL MCP:
- Lire context.json pour comprendre l'état
- Faire le travail demandé
- Écrire résultat dans .wikichat/artifacts/
- Écrire dans .wikichat/queue/ pour signaler l'action
- Terminer proprement (exit code 0)
Le coordinateur lira les fichiers locaux pour récupérer le résultat.`;

export const WAIT_INSTRUCTIONS = `## Pattern wait (attente structurée)

Pour attendre un événement spécifique:
1. poll_messages(channel="coordination", timeout_ms=30000) — attend une notif
2. Si timeout sans message pertinent → vérifier via read_messages(since_minutes=1)
3. Maximum 5 polls consécutifs sans traitement → appeler get_context() pour réévaluer
4. Si attente > 5min sans activité → déclarer via declare_delay(eta, reason)
5. Toujours écrire l'état d'attente dans .wikichat/artifacts/wait-status-<nom>.md

Ne jamais bloquer indéfiniment. Toujours avoir une action de sortie de boucle.
Si MCP down pendant l'attente → écrire dans queue/ et terminer proprement.`;
