/**
 * team-bootstrap.mjs — Default autonomous team provisioned via routines.
 *
 * Phase 6 redesign : triggers no longer carry inline actions, they call
 * named routines. Each resident and each recurring job becomes a routine
 * registered in ~/.wikichat/routines.json. Triggers point to routine ids.
 *
 * Architecture :
 *   - 3 routines `team:spawn-<name>` to spawn each resident as a daemon
 *   - 2 routines `team:job-<name>` for cartography / clustering
 *   - 1 routine `team:digest` for nightly Librarian digest broadcast
 *   - 6 triggers (3 lifecycle + 3 cron) that each call one of those routines
 *
 * Benefits :
 *   - Routines testable manually via `run_routine team:spawn-sentinel`
 *   - Same routines can be edited / disabled without touching triggers
 *   - Parameters factorized (role, model, task) in routine def, trigger
 *     just supplies `params: { ... }`
 *
 * Opt-in only: WIKICHAT_AUTONOMOUS_TEAM=1
 * To re-provision (overwrite): WIKICHAT_TEAM_RESET=1
 */

import { registerTrigger, listTriggers } from "./triggers.mjs";
import { registerRoutine } from "./routines.mjs";

const TEAM_TRIGGER_PREFIX = "team-";
const TEAM_ROUTINE_PREFIX = "team:";

const RESIDENTS = [
  {
    name: "Orchestrator",
    role: "daemon-orchestrator",
    model: "sonnet",
    task: "Tu es Orchestrator, l'agent superviseur de l'équipe WikiChat. Tu es le seul à parler directement à Nicolas. Lis docs/roles/orchestrator.md pour ton protocole exact. Écoute #directives, dispatche le travail (utilise dispatch() ou spawn_session), suis-les via poll_ticket, agrège les résultats, rapporte sur #general.",
  },
  {
    name: "Sentinel",
    role: "daemon-sentinel",
    model: "haiku",
    task: "Tu es Sentinel, agent de surveillance. Lis docs/roles/sentinel.md pour ton protocole exact. Détecte les événements (queue, artifacts, sessions stales) et délègue. Ne fais pas le travail toi-même — alerte Orchestrator via DM ou poste sur #dispatch.",
  },
  {
    name: "Librarian",
    role: "daemon-librarian",
    model: "haiku",
    task: "Tu es Librarian, agent de connaissance. Lis docs/roles/librarian.md pour ton protocole exact. Écoute #library, absorbe les artifacts dans .wikichat/knowledge/. Au signal 'digest', consolide la KB en Compiled Truth sur #digest.",
  },
];

const RECURRING_JOBS = [
  {
    id: "team-cron-cartography",
    description: "Cartography refresh every 6h",
    schedule: "0 */6 * * *",
    routine: "team:job-cartography",
    routineDef: {
      description: "Spawn a Cartographer headless agent that runs run_cartography",
      steps: [
        {
          action: "spawn",
          params: {
            name: "Cartographer-{ts}",
            role: "cartographer",
            mode: "headless",
            task: "register(name='Cartographer', role='cartographer', agent_type='headless'). Appelle run_cartography(). Termine.",
          },
        },
      ],
    },
  },
  {
    id: "team-cron-clustering",
    description: "Cross-project clustering Sunday 03:00",
    schedule: "0 3 * * 0",
    routine: "team:job-clustering",
    routineDef: {
      description: "Spawn a Matchmaker headless agent that runs run_clustering",
      steps: [
        {
          action: "spawn",
          params: {
            name: "Matchmaker-{ts}",
            role: "matchmaker",
            mode: "headless",
            task: "register(name='Matchmaker', role='matchmaker', agent_type='headless'). Appelle run_clustering(). Termine.",
          },
        },
      ],
    },
  },
  {
    id: "team-cron-digest",
    description: "Trigger Librarian digest mode nightly 22:00",
    schedule: "0 22 * * *",
    routine: "team:digest",
    routineDef: {
      description: "Broadcast a digest signal on #library for Librarian",
      steps: [
        {
          action: "broadcast",
          params: {
            channel: "library",
            content: "🌙 [DIGEST] @Librarian — heure du digest. Consolide les artifacts du jour en Compiled Truth dans .wikichat/knowledge/. Switch en Sonnet pour 30min.",
          },
        },
      ],
    },
  },
];

export function bootstrapAutonomousTeam() {
  if (process.env.WIKICHAT_AUTONOMOUS_TEAM !== "1") return { skipped: true };

  const reset = process.env.WIKICHAT_TEAM_RESET === "1";
  const existing = new Set(listTriggers().map(t => t.id));
  let provisioned = 0;

  // 1. Routines for resident spawns
  for (const r of RESIDENTS) {
    const routineId = `${TEAM_ROUTINE_PREFIX}spawn-${r.name.toLowerCase()}`;
    registerRoutine({
      id: routineId,
      description: `Spawn the ${r.name} resident daemon if absent`,
      steps: [
        {
          action: "spawn",
          params: {
            name: r.name,
            role: r.role,
            mode: "daemon",
            model: r.model,
            task: r.task,
          },
        },
      ],
    });
  }

  // 2. Lifecycle triggers calling resident routines
  for (const r of RESIDENTS) {
    const id = `${TEAM_TRIGGER_PREFIX}lifecycle-${r.name.toLowerCase()}`;
    if (existing.has(id) && !reset) continue;
    registerTrigger({
      id,
      type: "lifecycle",
      config: { condition: `if_no_session_named:${r.name}` },
      action: {
        type: "run_routine",
        params: { id: `${TEAM_ROUTINE_PREFIX}spawn-${r.name.toLowerCase()}` },
      },
      cooldown_s: 60,
      max_per_day: 24,
      description: `Auto-spawn ${r.name} via routine at boot if absent`,
    });
    provisioned++;
  }

  // 3. Recurring jobs : routine + cron trigger
  for (const job of RECURRING_JOBS) {
    if (job.routineDef) {
      registerRoutine({ id: job.routine, ...job.routineDef });
    }
    if (existing.has(job.id) && !reset) continue;
    registerTrigger({
      id: job.id,
      type: "cron",
      config: { schedule: job.schedule },
      action: {
        type: "run_routine",
        params: { id: job.routine },
      },
      cooldown_s: 300,
      max_per_day: 24,
      description: job.description,
    });
    provisioned++;
  }

  return { provisioned, residents: RESIDENTS.length, jobs: RECURRING_JOBS.length };
}
