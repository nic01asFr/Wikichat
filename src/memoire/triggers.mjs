/**
 * memoire/triggers.mjs — Les deux tâches automatiques de la capitalisation.
 *
 *   - `memoire-faits` : toutes les 15 min, job `capitaliser_faits` (faits par
 *     le code, sans modèle de langage ; vecteurs des fiches écrites par
 *     `qwen3-embedding-8b`, via l'Atelier). Actif dès sa création.
 *   - `memoire-nuit` : chaque nuit à 03:30, job `capitaliser_nuit` (fait
 *     résumer les conversations par l'Atelier : consomme du modèle).
 *     **Né désactivé** (J-b2 :
 *     l'activation revient à la personne, par le Pilote ou la vue Agents) ;
 *     `WIKICHAT_MEMOIRE_NUIT=1` le crée actif.
 *
 * Idempotent, et respecte un réglage de la personne : un trigger déjà là, même
 * désactivé ou modifié, n'est pas touché.
 */

import { getTrigger, registerTrigger } from "../triggers.mjs";

export const TRIGGER_FAITS = "memoire-faits";
export const TRIGGER_NUIT = "memoire-nuit";

export function assurerTriggersMemoire() {
  if (process.env.WIKICHAT_MEMOIRE === "0") return [];
  const crees = [];
  if (!getTrigger(TRIGGER_FAITS)) {
    crees.push(registerTrigger({
      id: TRIGGER_FAITS,
      type: "cron",
      config: { schedule: "*/15 * * * *" },
      action: { type: "job", params: { job: "capitaliser_faits" } },
      cooldown_s: 60,
      max_per_day: 96,
      description: "Mémoire : fiche les conversations au repos (faits extraits par le code, sans modèle)",
    }));
  }
  if (!getTrigger(TRIGGER_NUIT)) {
    crees.push(registerTrigger({
      id: TRIGGER_NUIT,
      type: "cron",
      config: { schedule: "30 3 * * *" },
      action: { type: "job", params: { job: "capitaliser_nuit" } },
      enabled: process.env.WIKICHAT_MEMOIRE_NUIT === "1",
      cooldown_s: 3600,
      max_per_day: 1,
      description: "Mémoire : routine de nuit plafonnée (20 conversations au plus, entrée de 58 000 caractères, qwen3-8-27b, résumé direct par l'Atelier)",
    }));
  }
  return crees;
}
