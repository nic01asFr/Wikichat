/**
 * jobs/index.mjs — Les jobs déterministes, appelés directement (lot W3).
 *
 * Un job est une fonction JS sans modèle : cartographie, clustering,
 * harmonisation des idées, audits des dépôts, détection de changements,
 * absorption des clôtures. Les routines (étape `job`) et les triggers (action
 * `job`) les appellent **directement**. Avant, les crons « Cartographer » et
 * « Matchmaker » lançaient un agent headless dont la seule mission était
 * d'appeler l'outil MCP correspondant : un processus `claude`, un modèle et
 * une connexion MCP pour exécuter une fonction du service — et quand l'agent
 * échouait (identité, permission, CLI absent), la carte ne se rafraîchissait
 * plus, sans erreur visible : la routine, elle, était « completed » dès le
 * lancement.
 *
 * Chaque job rend un résumé JSON (sérialisable, court) : c'est ce que la
 * routine garde dans `routine-runs.jsonl` et ce que le trigger renvoie.
 *
 * Décision J-c : un job n'est pas soumis à la porte dormante (seul ce qui
 * lance un agent l'est).
 */

import { sysMsg, pushMessage, state } from "../state.mjs";
import { randomUUID } from "crypto";
import { runCartography } from "./cartography.mjs";
import { runClustering } from "./clustering.mjs";
import { runHarmonizer, formatHarmonizerSummary } from "../harmonizer.mjs";
import { auditMany } from "../repo-audit.mjs";
import { scanForChanges } from "../snapshot.mjs";
import { loadRegistry } from "../registry.mjs";
import { saveProject, writeAtomicJSON } from "../persistence.mjs";
import { emitEvent } from "../events.mjs";
import { CHEMINS } from "../chemins.mjs";
import { absorberClotures } from "../closures.mjs";
import { capitaliserFaits } from "../memoire/capitalisation.mjs";
import { capitaliserNuit } from "../memoire/nuit.mjs";
import fs from "fs";

const journal = (m) => console.log(m);
const partager = (prefixe) => async ({ title, content, channel }) => {
  sysMsg(channel || "cartography", `${prefixe} ${title}\n\n${content}`);
};

/** Audits : lecture du dernier état connu (par chemin de dépôt). */
export function lireAudits() {
  try { return JSON.parse(fs.readFileSync(CHEMINS.audits, "utf8")); } catch { return { audits: {} }; }
}

/**
 * Audite tous les projets du registre. Le résultat va dans
 * `~/.wikichat/audits.json` (par chemin) — lu par la carte — et, pour les
 * projets déclarés, dans `project.health` comme le fait `audit_all_projects`.
 */
export async function auditerTout({ concurrence = 4, persister = true } = {}) {
  const reg = loadRegistry();
  const projets = (reg.projects || []).filter(p => p.path && p.name && p.status !== "missing");
  const audits = await auditMany(projets.map(p => ({ name: p.name, path: p.path })), concurrence);
  const parChemin = lireAudits();
  parChemin.audits = parChemin.audits || {};
  let persistes = 0;
  for (const p of projets) {
    const a = audits.get(p.name);
    if (!a?.exists) continue;
    parChemin.audits[p.path] = { slug: p.slug, name: p.name, ...a };
    if (persister) {
      const proj = state.projects.get(p.name);
      if (proj) { proj.health = a; proj.updatedAt = new Date(); proj.updatedBy = "job:audit_all_projects"; saveProject(proj); persistes++; }
    }
  }
  parChemin.calcule_le = new Date().toISOString();
  writeAtomicJSON(CHEMINS.audits, parChemin);
  const scores = [...audits.values()].filter(a => a.exists).map(a => a.score);
  return {
    projets: audits.size,
    audites: scores.length,
    score_moyen: scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : null,
    persistes,
  };
}

/**
 * Détection de changements sur les projets du registre (instantanés git et
 * fichiers), avec un événement #insights par changement. C'est le corps de la
 * tâche de nettoyage de 5 min, exposé comme job.
 */
export async function detecterChangements(options = {}) {
  const registry = loadRegistry();
  const projets = (registry.projects || []).filter(p => p.status !== "missing" && p.path);
  const changes = await scanForChanges(projets, options);
  let evenements = 0;
  for (const { project, changes: c } of changes) {
    if (c.type === "new") { emitEvent("new-project", `${project.name} — premier snapshot`, { project: project.name }); evenements++; continue; }
    for (const x of (c.changes || [])) { emitEvent(x.type, `${project.name} — ${x.detail}`, { project: project.name }); evenements++; }
  }
  return { projets_changes: changes.length, evenements, projets: changes.map(x => x.project.slug || x.project.name) };
}

async function harmoniser(args = {}) {
  const report = await runHarmonizer(args);
  if (args.post_to_channel !== false && state.channels.has("ideation") && report.clusters.length > 0) {
    pushMessage({ id: randomUUID(), from: "system", fromName: "🔔 Système", channel: "ideation", content: formatHarmonizerSummary(report), timestamp: new Date() });
  }
  return { idees: report.total_ideas, liens: report.links_found, clusters: report.clusters.length, seuil: report.threshold };
}

/**
 * Catalogue. Chaque nom accepte aussi le nom de la fonction JS (`runCartography`)
 * et le nom de l'outil MCP qui fait la même chose.
 */
const CATALOGUE = {
  run_cartography: {
    description: "Scan des projets, instantanés, carte thématique (runCartography)",
    executer: async () => {
      const r = await runCartography({ log: journal, share: partager("📊") });
      return { scannes: r.scanned, changes: r.changed, carte: r.mapPath };
    },
  },
  run_clustering: {
    description: "Proximité entre projets par dépendances, langages, étiquettes (runClustering)",
    executer: async () => {
      const r = await runClustering({ log: journal, share: partager("🔗") });
      return { projets: r.projects, liaisons: r.edges, clusters: r.clusters, fichier: r.path };
    },
  },
  harmonize_ideas: {
    description: "Regroupement des idées par similarité (runHarmonizer)",
    executer: harmoniser,
  },
  audit_all_projects: {
    description: "Santé des dépôts du registre (auditMany), gardée dans ~/.wikichat/audits.json",
    executer: (args = {}) => auditerTout({ concurrence: args.concurrency ?? 4, persister: args.persist !== false }),
  },
  scan_changes: {
    description: "Détection de changements git et fichiers, événements #insights (scanForChanges)",
    executer: (args = {}) => detecterChangements(args),
  },
  absorb_closures: {
    description: "Range chaque clôture non encore absorbée en fiche de connaissance (closure-<projet>.md)",
    executer: () => absorberClotures(),
  },
  // W8 : capitalisation des conversations (src/memoire/).
  capitaliser_faits: {
    description: "Fiche les conversations au repos : faits extraits par le code, depuis le transcript filtré de l'Atelier",
    executer: (args = {}) => capitaliserFaits({ ids: Array.isArray(args.ids) ? args.ids : null }),
  },
  capitaliser_nuit: {
    description: "Routine de nuit plafonnée : le sens de 20 conversations au plus, par des lancements de l'Atelier",
    executer: (args = {}) => capitaliserNuit({ force: args.force === true }),
  },
};

const ALIAS = {
  runCartography: "run_cartography", cartographie: "run_cartography",
  runClustering: "run_clustering", clustering: "run_clustering",
  runHarmonizer: "harmonize_ideas", harmonisation: "harmonize_ideas",
  auditMany: "audit_all_projects", audits: "audit_all_projects",
  scanForChanges: "scan_changes", instantanes: "scan_changes",
  absorberClotures: "absorb_closures",
  capitaliserFaits: "capitaliser_faits", memoire_faits: "capitaliser_faits",
  capitaliserNuit: "capitaliser_nuit", memoire_nuit: "capitaliser_nuit",
};

/** Nom canonique d'un job, ou null s'il n'existe pas. */
export function nomDuJob(nom) {
  const n = String(nom || "").trim();
  if (CATALOGUE[n]) return n;
  return ALIAS[n] || null;
}

export function listerJobs() {
  return Object.entries(CATALOGUE).map(([nom, j]) => ({ nom, description: j.description }));
}

/** Verrous : un même job ne tourne pas deux fois en même temps. */
const _enCours = new Map();

/**
 * Exécute un job. Lève une erreur si le job est inconnu ; si le même job est
 * déjà en cours, attend sa fin et rend son résultat (pas de double passe).
 */
export async function executerJob(nom, args = {}) {
  const canon = nomDuJob(nom);
  if (!canon) throw new Error(`job inconnu : ${nom} (connus : ${Object.keys(CATALOGUE).join(", ")})`);
  if (_enCours.has(canon)) return _enCours.get(canon);
  const debut = Date.now();
  const p = (async () => {
    try {
      const resultat = await CATALOGUE[canon].executer(args || {});
      return { job: canon, duree_ms: Date.now() - debut, ...resultat };
    } finally {
      _enCours.delete(canon);
    }
  })();
  _enCours.set(canon, p);
  return p;
}
