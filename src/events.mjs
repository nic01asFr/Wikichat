/**
 * events.mjs — Bus d'événements système.
 *
 * Les détecteurs déterministes (change detection, watchdog, queue pickup,
 * artifact recovery, cleanup) publient ici ; les triggers `channel_match`
 * écoutent. Aucun LLM entre les deux : une surveillance qui ne détecte rien
 * coûte zéro token, et un agent n'est spawné que quand il a réellement
 * quelque chose à faire.
 *
 * Format publié sur #insights :
 *
 *     [event:commits project:zebra] 2 nouveau(x) commit(s)
 *     └──── préfixe machine ────┘  └──── résumé humain ────┘
 *
 * Les triggers matchent sur le préfixe (`\[event:commits\b`), stable et
 * insensible à la formulation. Le reste est pour l'humain qui lit le canal.
 * Faire transiter les événements par le bus de messages plutôt que par un
 * émetteur dédié est délibéré : ils héritent gratuitement de la persistance,
 * de la dormant gate et du routage vers les triggers.
 */

import { sysMsg, state } from "./state.mjs";

/** Canal où atterrissent tous les événements système. */
export const EVENT_CHANNEL = "insights";

/** Types émis par les détecteurs. Sert de référence pour écrire un pattern. */
export const EVENT_TYPES = [
  "commits",      // nouveaux commits sur un projet du registry
  "branch",       // changement de branche
  "uncommitted",  // modifications non committées apparues
  "git-init",     // dépôt git initialisé
  "claude-md",    // CLAUDE.md modifié — le projet a changé de nature
  "deps",         // dépendances modifiées
  "version",      // version bumpée
  "files",        // fichiers ajoutés/supprimés en nombre
  "artifact",     // artefact déposé par un agent — candidat absorption KB
  "queue",        // action offline d'un agent récupérée
  "stale",        // session sans activité au-delà du seuil
  "daemon-down",  // daemon dont le PID est mort
  "task-expired", // claim de tâche expiré par TTL
];

let _channelReady = false;

/** Crée #insights si absent. Idempotent, coût nul après le premier appel. */
function ensureChannel() {
  if (_channelReady || state.channels.has(EVENT_CHANNEL)) {
    _channelReady = true;
    return;
  }
  state.channels.set(EVENT_CHANNEL, {
    name: EVENT_CHANNEL,
    description: "Événements détectés automatiquement — écoutés par les triggers",
    createdBy: "system",
    createdAt: new Date(),
  });
  _channelReady = true;
  import("./persistence.mjs").then(m => m.saveChannels()).catch(() => { /* non-bloquant */ });
}

/**
 * Publie un événement système.
 *
 * @param {string} type     - Un des EVENT_TYPES (libre, mais restez-y pour que
 *                            les patterns des triggers restent prévisibles)
 * @param {string} summary  - Résumé lisible, une ligne
 * @param {object} [meta]   - Paires clé/valeur intégrées au préfixe machine
 *                            (ex: {project: "zebra"} → `[event:commits project:zebra]`)
 * @returns {object|null} le message poussé
 */
export function emitEvent(type, summary, meta = {}) {
  if (!type) return null;
  ensureChannel();
  const tags = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}:${String(v).replace(/\s+/g, "-")}`)
    .join(" ");
  const prefix = `[event:${type}${tags ? ` ${tags}` : ""}]`;
  return sysMsg(EVENT_CHANNEL, `${prefix} ${summary}`);
}
