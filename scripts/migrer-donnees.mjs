#!/usr/bin/env node
/**
 * migrer-donnees.mjs — Reprise (ou retour arrière) des données du lot W2.
 *
 *   node scripts/migrer-donnees.mjs [--source <dossier>]      reprise (défaut : dossier courant)
 *   node scripts/migrer-donnees.mjs --retour --source <dossier>   recopie ~/.wikichat vers <dossier>
 *
 * Le service fait la reprise tout seul au démarrage ; ce script sert à la
 * faire service arrêté, ou à revenir à une version antérieure à W2.
 */
import { migrerDonnees, retourArriere } from "../src/migration.mjs";

const args = process.argv.slice(2);
const i = args.indexOf("--source");
const source = i >= 0 ? args[i + 1] : process.cwd();
if (args.includes("--retour")) {
  if (i < 0) { console.error("--retour exige --source <dossier de lancement de l'ancienne version>"); process.exit(2); }
  retourArriere({ source });
} else {
  const r = migrerDonnees({ sources: [source] });
  if (r.ignorees.length) console.log(`Déjà reprise(s) : ${r.ignorees.join(", ")} (témoin ~/.wikichat/migration-w2.json)`);
  if (!r.reprises.length && !r.ignorees.length) console.log("Rien à reprendre.");
}
