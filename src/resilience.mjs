/**
 * resilience.mjs — Watchdog, cron persistence, heartbeat, spawn retry.
 *
 * Responsibilities:
 *  - Persist cron job registrations to disk (survive server restart)
 *  - Session watchdog: detect stale sessions (émet un événement stale)
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
 * (les paramètres spawnRegistryLoader/respawnFn ont disparu avec l'auto-respawn)
 * @returns {NodeJS.Timeout} — interval handle for stopWatchdog()
 */
export function startWatchdog(appState) {
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

    // L'auto-respawn vivait ici. Il testait `entry.type === "spawned"` et
    // `entry.autoRespawn`, deux champs qu'aucun writer n'a jamais posés : sur
    // 54 entrées du registre, zéro les portait. La boucle était donc
    // inatteignable depuis toujours, alors que README et CLAUDE.md annonçaient
    // un « daemon auto-respawn ». Retirée plutôt que réparée : les daemons
    // résidents ont été remplacés par des spawns déclenchés sur événement,
    // il n'y a plus de processus à maintenir en vie.

    // 2. Check overdue cron agents
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
 * Instructions injectées dans `<projet>/.wikichat/instructions.md` — le document
 * que lit tout agent travaillant dans un projet.
 *
 * Les cinq blocs précédents (LOCAL_FIRST / POLL / CRON / SPAWN / WAIT) décrivaient
 * un système qui n'a jamais existé : ils demandaient d'appeler resume_session,
 * ping, register_cron, respawn_session et update_project_state — cinq outils
 * absents de la surface MCP — et de gérer un curseur `since_id` à la main, alors
 * que le serveur en tient un par identité. Réécrits d'un bloc pour décrire ce que
 * le système fait réellement.
 */
export const AGENT_INSTRUCTIONS = `## Protocole local-first (obligatoire)

Écris TOUJOURS le fichier local avant de compter sur WikiChat.
Les fichiers locaux sont la vérité ; WikiChat est le canal de diffusion.
Si le MCP est injoignable, rien n'est perdu.

### Produire un résultat
1. Écris \`.wikichat/artifacts/<timestamp>_<titre>.md\` — toujours, sans condition.
2. Le service le récupère dans les 2 minutes et l'annonce sur #insights.
   Tu n'as rien d'autre à faire pour le partager.

### Si le MCP est injoignable
Écris \`.wikichat/queue/<timestamp>-<ton-nom>.json\` :
\`\`\`json
{"type":"artifact","agent":"<nom>","project":"<slug>","ts":"<ISO>",
 "data":{"title":"...","content":"..."}}
\`\`\`
Le service ramasse la queue au cycle suivant. Un agent qui ne joint pas
WikiChat n'est jamais bloqué : il fait son travail et écrit localement.

## Recevoir des messages

Tu n'as pas de boucle à tenir. Le serveur garde un curseur sur ton identité :
- \`poll()\` — relève tout ce qui t'est adressé depuis ta dernière relève.
  Sans argument. Pas de canal, pas de since_id à gérer.
- \`poll(timeout_seconds=N)\` — rendez-vous synchrone, quand tu attends une
  réponse maintenant.
- Ton hook de fin de tour relève la même boîte automatiquement : un message
  arrivé pendant que tu travailles t'est livré avant que tu rendes la main.

\`read_messages(channel=...)\` sert à relire l'historique d'un canal, pas à
recevoir : c'est le passé, quand \`poll()\` donne le nouveau.

## Envoyer

- \`send_message(channel="<canal>"|"@Nom", content=...)\`. Le canal est créé
  s'il n'existe pas. Précise ton intention : \`expects_reply=true\` si tu attends
  une réponse, \`status="over"\` quand tu rends la main, \`status="done"\` quand
  il n'y a rien à répondre, \`eta_seconds\` si tu pars travailler.
- \`contact_agent(target, message)\` pour joindre quelqu'un par son nom : le
  message est déposé chez lui et sa réponse te revient.

## Avant de terminer

Ce que tu laisses derrière toi est la seule chose qui te survit — ton historique
de conversation appartient à Claude Code et disparaît.

- Décision actée, blocage rencontré, question ouverte qui engage le projet
  → \`add_project_note(project, type="decision"|"blocker"|"question", content)\`.
- Chose comprise qui servira à la prochaine session portant TON nom
  → \`remember(clé, valeur)\`.
- Tâche prise ou rendue → \`claim_task\` / \`release_task\`.

N'y mets rien d'autre : pas de compte rendu, pas de recopie de l'artefact.
`;
