/**
 * profils.mjs — Profils d'accès : ce qu'une connexion MCP voit et peut appeler.
 *
 * Contrat : `docs/vision/profils-acces.md` de l'Atelier. L'entrée wikichat (pont
 * stdio, ou client SSE direct) annonce le profil de la conversation et son
 * projet ; c'est le SERVEUR qui filtre, dans `tools/list` comme dans
 * `tools/call`, et dans les ressources. Une consigne au modèle ne suffit pas.
 *
 *   - `code`      : un agent code, limité à son projet ;
 *   - `assistant` : l'Assistant de l'Atelier, tous les outils ;
 *   - rien        : comportement d'avant les profils (tous les outils), journalisé.
 *
 * Transport de l'annonce : `?profil=` et `?projet=` dans l'URL `/sse` (le pont
 * les tire de `WIKICHAT_PROFIL` et `WIKICHAT_PROJET`), ou les en-têtes
 * `x-wikichat-profil` et `x-wikichat-projet`.
 *
 * Mécanique : le profil est fixé à la connexion, et chaque connexion a son
 * propre serveur MCP. Un outil hors profil n'est donc jamais enregistré sur
 * cette connexion : il n'apparaît pas dans `tools/list`, et `tools/call` le
 * refuse comme un outil inconnu. Pour un outil gardé, le projet est celui du
 * profil, jamais un argument : un argument `project` qui vise un autre projet
 * est refusé.
 */

import { z } from "zod";
import { slugifier } from "./projet-fichiers.mjs";

export const PROFIL_CODE = "code";
export const PROFIL_ASSISTANT = "assistant";
export const PROFILS = [PROFIL_CODE, PROFIL_ASSISTANT];

/**
 * Outils du profil `code`. Liste fermée : un outil ajouté à wikichat n'est
 * donné à un agent code qu'en l'ajoutant ici.
 */
export const OUTILS_CODE = Object.freeze([
  // État et notes de son projet
  "project_state", "add_project_note",
  // Sa mémoire
  "remember", "recall", "forget",
  // Connaissance centrale et celle de son projet
  "search_knowledge",
  // Messagerie et fils, pour s'adresser aux agents d'autres projets
  "send_message", "read_messages", "poll", "list_threads", "contact_agent", "list_sessions",
  // Briefing
  "get_briefing",
  // Tâches de son projet
  "claim_task", "release_task",
  // Idées
  "add_idea",
  // Méta et clôture de son projet (d'un autre projet : refusé)
  "set_project_meta", "close_project",
]);

/** Outils dont l'argument `project` est remplacé par le projet du profil. */
export const OUTILS_LIES_AU_PROJET = Object.freeze([
  "project_state", "add_project_note", "claim_task", "release_task", "set_project_meta", "close_project",
]);

/** Ressources du profil `code` (nom d'enregistrement dans resources.mjs). */
export const RESSOURCES_CODE = Object.freeze(["briefing", "role", "identity", "knowledge"]);

const OUTILS_CODE_SET = new Set(OUTILS_CODE);
const LIES_SET = new Set(OUTILS_LIES_AU_PROJET);
const RESSOURCES_CODE_SET = new Set(RESSOURCES_CODE);

/** Une valeur absente, vide, ou une variable que le client n'a pas développée. */
function valeurAnnoncee(v) {
  const s = String(v ?? "").trim();
  if (!s || s.includes("${")) return "";
  return s;
}

/**
 * Lit l'annonce de profil d'une requête `/sse`.
 * @param {{ query?: object, headers?: object }} req
 * @returns {{ profil: "code"|"assistant"|null, projet: string|null, annonce: string, projetAnnonce: string, inconnu: boolean }}
 *   `profil` null : rien d'annoncé. Un profil inconnu est traité comme `code`
 *   (le plus restreint) et signalé par `inconnu`.
 */
export function lireAnnonce(req = {}) {
  const q = req.query || {};
  const h = req.headers || {};
  const annonce = valeurAnnoncee(q.profil) || valeurAnnoncee(h["x-wikichat-profil"]);
  const projetAnnonce = valeurAnnoncee(q.projet) || valeurAnnoncee(h["x-wikichat-projet"]);
  const bas = annonce.toLowerCase();
  let profil = null;
  let inconnu = false;
  if (bas) {
    if (PROFILS.includes(bas)) profil = bas;
    else { profil = PROFIL_CODE; inconnu = true; }
  }
  const projet = projetAnnonce ? (slugifier(projetAnnonce) || null) : null;
  return { profil, projet, annonce, projetAnnonce, inconnu };
}

/** Vrai si la session est en profil `code`. */
export function estCode(session) {
  return session?.profil === PROFIL_CODE;
}

/** Deux désignations d'un même projet (nom, slug, casse). */
export function memeProjet(a, b) {
  const sa = slugifier(a), sb = slugifier(b);
  return !!sa && sa === sb;
}

export function outilVisible(session, nom) {
  return !estCode(session) || OUTILS_CODE_SET.has(nom);
}

export function ressourceVisible(session, nom) {
  return !estCode(session) || RESSOURCES_CODE_SET.has(nom);
}

function texte(t) { return { content: [{ type: "text", text: t }] }; }

export function refusAutreProjet(demande, projet) {
  return `⛔ Refusé : profil code, limité au projet "${projet}". "${demande}" est un autre projet.\n` +
    `👉 Pour voir ou faire agir un autre projet, passe par ses agents : contact_agent(target="<agent de ce projet>", message=…), ` +
    `ou send_message. list_sessions montre qui est présent et sur quel projet.`;
}

export function refusSansProjet(outil) {
  return `⛔ Refusé : profil code sans projet annoncé (WIKICHAT_PROJET absent), ${outil} ne sait pas quel projet viser.\n` +
    `👉 C'est un défaut de configuration de l'entrée wikichat : à signaler à l'Atelier.`;
}

/** Gardes propres à un outil, en profil code. Rendent un texte de refus, ou null. */
const GARDES_CODE = {
  close_project: (args) => args?.repo_path
    ? `⛔ Refusé : profil code, repo_path n'est pas disponible. La clôture vise le dossier de ton projet, résolu par wikichat.`
    : null,
  contact_agent: (args) => {
    if (args?.wake) {
      return `⛔ Refusé : profil code, wake=true lancerait un agent. Le message est à déposer sans réveil ` +
        `(rappelle contact_agent sans wake) : l'agent le recevra à son prochain tour.`;
    }
    if (args?.repo_path) return `⛔ Refusé : profil code, repo_path n'est pas disponible.`;
    return null;
  },
};

/**
 * Nom sous lequel wikichat connaît le projet `slug` dans `projets` (Map
 * nom → projet), sinon le slug lui-même.
 */
export function nomCanonique(slug, projets) {
  if (projets?.has?.(slug)) return slug;
  for (const [nom, p] of projets || []) {
    if (p?.slug === slug || slugifier(nom) === slug) return nom;
  }
  return slug;
}

/**
 * Enveloppe le serveur MCP d'une connexion : `tool()` et `resource()` ne
 * reçoivent que ce que le profil de `session` autorise, et les outils liés au
 * projet sont bornés au projet du profil.
 *
 * @param {object} serveur McpServer de la connexion
 * @param {object} session objet de session (state.sessions), lu à chaque appel
 * @param {{ projets?: () => Map, journal?: (m: string) => void }} o
 */
export function serveurFiltre(serveur, session, { projets = () => new Map(), journal = () => {} } = {}) {
  if (!estCode(session)) return serveur;
  const caches = [];
  const enveloppe = Object.create(serveur);

  enveloppe.tool = (nom, ...reste) => {
    if (!outilVisible(session, nom)) { caches.push(nom); return undefined; }
    const iRappel = reste.length - 1;
    const rappel = reste[iRappel];
    const iForme = iRappel - 1;
    let forme = iForme >= 0 && reste[iForme] && typeof reste[iForme] === "object" ? reste[iForme] : null;
    const lie = LIES_SET.has(nom) && forme && "project" in forme;
    if (lie) {
      forme = { ...forme, project: z.string().optional().describe(
        `Toujours ton projet : laisse vide. Un autre projet est refusé (profil code) ; passe par ses agents (contact_agent).`) };
      reste[iForme] = forme;
    }
    const garde = GARDES_CODE[nom];
    if (!lie && !garde) return serveur.tool(nom, ...reste);
    reste[iRappel] = async (args = {}, extra) => {
      const projet = session.projet;
      if (lie) {
        if (!projet) return texte(refusSansProjet(nom));
        if (args.project && !memeProjet(args.project, projet)) {
          journal(`[profils] ${session.name} (code, ${projet}) : ${nom} refusé pour le projet "${args.project}"`);
          return texte(refusAutreProjet(args.project, projet));
        }
        args = { ...args, project: nomCanonique(projet, projets()) };
      }
      const refus = garde ? garde(args) : null;
      if (refus) {
        journal(`[profils] ${session.name} (code, ${projet || "-"}) : ${nom} refusé`);
        return texte(refus);
      }
      return rappel(args, extra);
    };
    return serveur.tool(nom, ...reste);
  };

  enveloppe.resource = (nom, ...reste) => {
    if (!ressourceVisible(session, nom)) return undefined;
    return serveur.resource(nom, ...reste);
  };

  enveloppe.outilsCaches = caches;
  return enveloppe;
}
