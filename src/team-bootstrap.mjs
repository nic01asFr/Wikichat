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

// Knowledge layer : 3 routines + 2 triggers pour entretenir la KB transverse
// (~/.wikichat/knowledge/<topic>-axis.md) de manière automatique. S'appuie sur :
//   - search_knowledge (MCP tool) pour cross-référencer
//   - close_project broadcast sur #library (déjà existant)
//   - channel_match trigger (Phase 6 récent)
const KNOWLEDGE_ROUTINES = [
  {
    id: "team:knowledge-compile-axis",
    description: "Spawne un Librarian-Compiler headless qui produit ~/.wikichat/knowledge/{topic}-axis.md. Travail séquencé en 3 phases bornées pour éviter le hang sur gros registry.",
    steps: [
      {
        action: "spawn",
        params: {
          name: "LibrarianCompiler-{topic}-{ts}",
          role: "librarian-compiler",
          mode: "headless",
          model: "sonnet",
          task: "Tu es Librarian-Compiler. Mission : produire ~/.wikichat/knowledge/{topic}-axis.md, format inspiré de grist-axis.md.\n\n" +
            "TRAVAIL EN 3 PHASES SÉQUENTIELLES, STRICTEMENT BORNÉES :\n\n" +
            "**PHASE 1 — Discovery (max 60s)**\n" +
            "1. register(name='LibrarianCompiler-{topic}-{ts}', role='librarian-compiler', agent_type='headless')\n" +
            "2. list_projects() pour récupérer la liste\n" +
            "3. Filtre : garde uniquement les projets dont le name OU slug OU path OU stack contient '{topic}' (case-insensitive)\n" +
            "4. **CAP À 10 PROJETS MAX** — si plus, garde les 10 plus pertinents (priorité : match exact name > stack > path)\n" +
            "5. Note la liste des 10 paths sélectionnés. Si 0 projet trouvé : poste sur #insights et sors immédiatement.\n\n" +
            "**PHASE 2 — Read (max 90s, lecture minimale)**\n" +
            "6. Pour chaque projet sélectionné, lis UNIQUEMENT :\n" +
            "   - Les 50 PREMIÈRES LIGNES du CLAUDE.md (pas plus, pas le README, pas le project-state.json)\n" +
            "   - Si CLAUDE.md absent : les 30 premières lignes du README.md\n" +
            "7. Pour chaque projet, extrais 1 phrase de description et 1 ligne de stack/keywords\n\n" +
            "**PHASE 3 — Synthesis (max 120s, écriture finale)**\n" +
            "8. Produis le markdown avec ces sections (chacune ≤30 lignes) :\n" +
            "   - Frontmatter YAML : type=axis, topic, last_compiled=2026-05-01, producer, status=DRAFT\n" +
            "   - # Axe {topic} — synthèse transverse\n" +
            "   - ## TL;DR (3-5 lignes)\n" +
            "   - ## Briques disponibles (tableau projet | path | description courte)\n" +
            "   - ## Patterns observés (3-5 patterns max, avec source)\n" +
            "   - ## Pour démarrer un nouveau projet {topic} (3 conseils max)\n" +
            "9. share_artifact(channel='library', title='Compiled axis: {topic}', artifact_type='text', content=<markdown>)\n" +
            "10. Écris le fichier dans ~/.wikichat/knowledge/{topic}-axis.md\n" +
            "11. Sors immédiatement.\n\n" +
            "**RÈGLES CRITIQUES** :\n" +
            "- NE LIS JAMAIS plus de 10 fichiers projets au total\n" +
            "- NE LIS JAMAIS plus de 50 lignes par fichier\n" +
            "- Si une phase dépasse son budget, passe à la suivante avec ce que tu as\n" +
            "- Markdown final ≤ 200 lignes total\n" +
            "- Sors propre, pas de boucle.",
        },
      },
    ],
  },
  {
    id: "team:knowledge-absorb-closure",
    description: "Spawne un Librarian-Absorber qui ingère un artifact de closure dans l'axe pertinent",
    steps: [
      {
        action: "spawn",
        params: {
          name: "LibrarianAbsorber-{ts}",
          role: "librarian-absorber",
          mode: "headless",
          model: "haiku",
          task: "Tu es Librarian-Absorber. Mission : ingérer le dernier artifact de closure de #library dans le bon axe de connaissance. " +
            "1. register(name='LibrarianAbsorber-{ts}', role='librarian-absorber', agent_type='headless'). " +
            "2. read_messages(channel='library', limit=5) pour trouver le dernier artifact 'Closure: <slug>'. " +
            "3. search_knowledge(query=<topic principal du projet>, scope='central') pour identifier l'axe pertinent (ex: grist-axis.md). " +
            "4. Si axe trouvé : lire l'axe, identifier la section pertinente (Briques disponibles, Patterns, Anti-patterns), append le contenu de la closure mappé. " +
            "5. Si pas d'axe correspondant : créer un brouillon ~/.wikichat/knowledge/<topic>-axis.draft.md avec la closure et alerter sur #insights. " +
            "6. Sors.",
        },
      },
    ],
  },
  {
    id: "team:knowledge-axis-discovery",
    description: "Spawne un Discoverer qui scan le registry et propose des nouveaux axes orphelins",
    steps: [
      {
        action: "spawn",
        params: {
          name: "AxisDiscoverer-{ts}",
          role: "axis-discoverer",
          mode: "headless",
          model: "haiku",
          task: "Tu es AxisDiscoverer. Mission : détecter les topics récurrents dans le registry qui n'ont pas encore d'axe compilé. " +
            "1. register(name='AxisDiscoverer-{ts}', role='axis-discoverer', agent_type='headless'). " +
            "2. list_projects() pour récupérer la liste. " +
            "3. Pour chaque projet, extraire les keywords du nom + path + description. " +
            "4. Compter les keywords récurrents (apparaissent dans 3+ projets). " +
            "5. Lister les fichiers existants dans ~/.wikichat/knowledge/*-axis.md. " +
            "6. Pour chaque keyword récurrent SANS axe existant : poster sur #insights 'Axe candidat : <keyword> (N projets concernés). Lance team:knowledge-compile-axis avec topic=<keyword> pour compiler.' " +
            "7. Sors.",
        },
      },
    ],
  },
];

const KNOWLEDGE_TRIGGERS = [
  {
    id: "team-channel-library-closure",
    description: "Quand un artifact de closure est posté sur #library, déclencher l'absorption automatique",
    type: "channel_match",
    config: {
      channel: "library",
      pattern: "^📎 Closure:",
      flags: "m",
    },
    routine: "team:knowledge-absorb-closure",
    cooldown_s: 30,
    max_per_day: 50,
  },
  {
    id: "team-cron-axis-discovery",
    description: "Discover potential new axes — Monday 08:00",
    type: "cron",
    config: { schedule: "0 8 * * 1" },
    routine: "team:knowledge-axis-discovery",
    cooldown_s: 3600,
    max_per_day: 1,
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

  // 4. Knowledge layer : routines (toujours enregistrées, déclenchables manuellement
  //    via run_routine) + 2 triggers (1 channel_match auto + 1 cron weekly).
  for (const routine of KNOWLEDGE_ROUTINES) {
    registerRoutine(routine);
  }
  for (const tr of KNOWLEDGE_TRIGGERS) {
    if (existing.has(tr.id) && !reset) continue;
    registerTrigger({
      id: tr.id,
      type: tr.type,
      config: tr.config,
      action: {
        type: "run_routine",
        params: { id: tr.routine },
      },
      cooldown_s: tr.cooldown_s ?? 60,
      max_per_day: tr.max_per_day ?? 24,
      description: tr.description,
    });
    provisioned++;
  }

  return {
    provisioned,
    residents: RESIDENTS.length,
    jobs: RECURRING_JOBS.length,
    knowledge_routines: KNOWLEDGE_ROUTINES.length,
    knowledge_triggers: KNOWLEDGE_TRIGGERS.length,
  };
}
