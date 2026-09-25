/**
 * chemins.mjs — Où vivent les données de wikichat.
 *
 * Toutes les données du service sont sous `~/.wikichat/`, quel que soit le
 * dossier depuis lequel il est lancé. Elles étaient en partie sous
 * `process.cwd()` : la mémoire des agents, les messages, les fils, les
 * instantanés de session, les projets déclarés sans dépôt, le registre des
 * lancements et les dossiers d'agents dépendaient donc du dossier de
 * lancement (`~/work/wikichat/src/.wikichat/…` sur le pod). Un redémarrage
 * depuis un autre dossier repartait à vide sans rien dire.
 *
 * Calculé à l'import, comme le reste du service : un test qui veut un autre
 * dossier lance le serveur avec un autre HOME.
 *
 * Aucune dépendance interne : ce module est importé par la persistance.
 */

import os from "os";
import path from "path";
import { fileURLToPath } from "url";

export const WIKICHAT_HOME = path.join(os.homedir(), ".wikichat");

export const CHEMINS = Object.freeze({
  racine: WIKICHAT_HOME,
  memoires: path.join(WIKICHAT_HOME, "memories.json"),
  messages: path.join(WIKICHAT_HOME, "messages.json"),
  canaux: path.join(WIKICHAT_HOME, "channels.json"),
  fils: path.join(WIKICHAT_HOME, "fils.json"),
  sessions: path.join(WIKICHAT_HOME, "sessions"),
  projets: path.join(WIKICHAT_HOME, "projects"),
  registreLancements: path.join(WIKICHAT_HOME, "spawn_registry.json"),
  agents: path.join(WIKICHAT_HOME, "agents"),
  crons: path.join(WIKICHAT_HOME, "crons.json"),
  roles: path.join(WIKICHAT_HOME, "roles"),
  connaissance: path.join(WIKICHAT_HOME, "knowledge"),
  audits: path.join(WIKICHAT_HOME, "audits.json"),
  clusters: path.join(WIKICHAT_HOME, "clusters"),
  cartographie: path.join(WIKICHAT_HOME, "cartography"),
});

/** Dossier du dépôt wikichat (modèles livrés : `docs/roles/`, `public/`). */
export const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
