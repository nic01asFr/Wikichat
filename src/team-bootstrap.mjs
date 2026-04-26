/**
 * team-bootstrap.mjs — Default autonomous team configuration.
 *
 * Provisions a self-managed team of resident agents at server boot:
 *
 *   Orchestrator (Sonnet, daemon)  — supervises, dispatches, talks to user
 *      ↓ spawns subagents via spawn_session, tracks via poll_ticket
 *   Sentinel     (Haiku,  daemon)  — watches events, alerts Orchestrator
 *   Librarian    (Haiku,  daemon)  — absorbs artifacts → KB, nightly digest
 *
 * Each is spawned via a `lifecycle` trigger with condition
 *   `if_no_session_named:<Name>`
 * so they only boot if not already alive (idempotent across restarts).
 *
 * Recurring jobs are wired via `cron` triggers:
 *   - cartography refresh every 6h
 *   - clustering weekly (Sunday 03:00)
 *   - Librarian "digest mode" nightly (22:00) via broadcast
 *
 * Opt-in only: set WIKICHAT_AUTONOMOUS_TEAM=1 to enable.
 * To re-provision (overwrite existing): WIKICHAT_TEAM_RESET=1
 */

import { registerTrigger, listTriggers } from "./triggers.mjs";

const TEAM_TRIGGER_PREFIX = "team-";

const RESIDENT_DEFINITIONS = [
  {
    name: "Orchestrator",
    role: "daemon-orchestrator",
    model: "sonnet",
    task:
      "Tu es Orchestrator, l'agent superviseur de l'équipe WikiChat. " +
      "Tu es le seul à parler directement à Nicolas. " +
      "Lis docs/roles/orchestrator.md pour ton protocole exact. " +
      "Écoute #directives, dispatche le travail aux résidents et aux spawns headless via spawn_session, " +
      "suis-les via poll_ticket, agrège les résultats, rapporte sur #general.",
  },
  {
    name: "Sentinel",
    role: "daemon-sentinel",
    model: "haiku",
    task:
      "Tu es Sentinel, agent de surveillance. " +
      "Lis docs/roles/sentinel.md pour ton protocole exact. " +
      "Détecte les événements (queue, artifacts, sessions stales) et délègue. " +
      "Ne fais pas le travail toi-même — alerte Orchestrator via DM.",
  },
  {
    name: "Librarian",
    role: "daemon-librarian",
    model: "haiku",
    task:
      "Tu es Librarian, agent de connaissance. " +
      "Lis docs/roles/librarian.md pour ton protocole exact. " +
      "Écoute #library, absorbe les artifacts dans .wikichat/knowledge/. " +
      "Au signal 'digest', consolide la KB en Compiled Truth sur #digest.",
  },
];

const RECURRING_JOBS = [
  {
    id: "team-cron-cartography",
    description: "Cartography refresh every 6h",
    schedule: "0 */6 * * *",
    action: {
      type: "spawn_session",
      params: {
        name: "Cartographer",
        role: "cartographer",
        mode: "headless",
        prompt:
          "register(name='Cartographer', role='cartographer', agent_type='headless'). " +
          "Appelle run_cartography(). Termine.",
      },
    },
  },
  {
    id: "team-cron-clustering",
    description: "Cross-project clustering Sunday 03:00",
    schedule: "0 3 * * 0",
    action: {
      type: "spawn_session",
      params: {
        name: "Matchmaker",
        role: "matchmaker",
        mode: "headless",
        prompt:
          "register(name='Matchmaker', role='matchmaker', agent_type='headless'). " +
          "Appelle run_clustering(). Termine.",
      },
    },
  },
  {
    id: "team-cron-digest",
    description: "Trigger Librarian digest mode nightly 22:00",
    schedule: "0 22 * * *",
    action: {
      type: "broadcast",
      params: {
        channel: "library",
        content:
          "🌙 [DIGEST] @Librarian — heure du digest. Consolide les artifacts du jour " +
          "en Compiled Truth dans .wikichat/knowledge/. Switch en Sonnet pour 30min.",
      },
    },
  },
];

/**
 * Provision (or refresh) the default team triggers. Called once at boot.
 * Idempotent: existing triggers with the same id are preserved unless
 * WIKICHAT_TEAM_RESET=1, in which case they're overwritten.
 */
export function bootstrapAutonomousTeam() {
  // Opt-in: provisioning only happens if explicitly enabled. Default off
  // because residents are real Claude Code processes — they consume tokens
  // and shouldn't auto-start without the operator asking for them.
  if (process.env.WIKICHAT_AUTONOMOUS_TEAM !== "1") return { skipped: true };

  const reset = process.env.WIKICHAT_TEAM_RESET === "1";
  const existing = new Set(listTriggers().map(t => t.id));
  let provisioned = 0;

  // 1. Lifecycle triggers for residents
  for (const r of RESIDENT_DEFINITIONS) {
    const id = `${TEAM_TRIGGER_PREFIX}lifecycle-${r.name.toLowerCase()}`;
    if (existing.has(id) && !reset) continue;
    registerTrigger({
      id,
      type: "lifecycle",
      config: { condition: `if_no_session_named:${r.name}` },
      action: {
        type: "spawn_session",
        params: {
          name: r.name,
          role: r.role,
          mode: "daemon",
          model: r.model,
          task: r.task,
        },
      },
      cooldown_s: 60,
      max_per_day: 24,
      description: `Auto-spawn ${r.name} (${r.role}) at boot if absent`,
    });
    provisioned++;
  }

  // 2. Recurring cron jobs
  for (const job of RECURRING_JOBS) {
    if (existing.has(job.id) && !reset) continue;
    registerTrigger({
      id: job.id,
      type: "cron",
      config: { schedule: job.schedule },
      action: job.action,
      cooldown_s: 300,
      max_per_day: 24,
      description: job.description,
    });
    provisioned++;
  }

  return { provisioned, total: RESIDENT_DEFINITIONS.length + RECURRING_JOBS.length };
}
