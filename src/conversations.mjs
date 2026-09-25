/**
 * conversations.mjs — Une conversation Claude = une identité wikichat.
 *
 * La clé est l'identifiant de session Claude (`session_id` des hooks,
 * `CLAUDE_CODE_SESSION_ID` des serveurs MCP stdio). Le hook SessionStart la
 * déclare ; le nom en découle, le même sur toutes les surfaces :
 *
 *   1. `WIKICHAT_AGENT` non générique → fait foi (tour de l'Atelier, agent lancé
 *      par wikichat) ;
 *   2. conversation déjà connue → son nom ;
 *   3. un agent a déclaré ce `session_id` par le passé → son nom ;
 *   4. `ATELIER_SESSION` → `<slug>-<ATELIER_SESSION[:6]>` ;
 *   5. sinon `<slug>-<session_id[:6]>` — la formule de l'Atelier
 *      (`sessions.py:_nom_wikichat`), donc le même nom qu'il donne à une
 *      conversation née chez lui.
 *
 * `atelier`, `session-…` et les `${…}` non développés sont GÉNÉRIQUES : ils ne
 * désignent personne et ne font jamais foi. Plus d'identité commune `atelier`.
 *
 * Quand le nom d'une conversation change (l'Atelier adopte une conversation née
 * dans VS Code), l'ancien devient un alias du nouveau : ce qui lui est adressé
 * arrive au nouveau.
 *
 * La présence (en ligne / hors ligne) vient des hooks SessionStart et
 * SessionEnd : elle ne dépend plus d'une connexion MCP, qui peut manquer.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { state, brancherConversations } from "./state.mjs";
import { remember, knownAgentNames, recall } from "./identity.mjs";
import { trouverRacineProjet, slugDuProjet } from "./projet-fichiers.mjs";
import { renommerDansFils } from "./fils.mjs";

const FICHIER = () => path.join(os.homedir(), ".wikichat", "conversations.json");
const MAX_CONVERSATIONS = 3000;
/** Au-delà, une conversation qui ne s'est pas manifestée n'est plus comptée présente. */
const PRESENCE_MAX_MS = parseInt(process.env.WIKICHAT_PRESENCE_MAX_MS || `${12 * 3600 * 1000}`);

/** @type {Map<string, object>} session_id → conversation */
const _conv = new Map();
/** alias (minuscule) → nom actuel */
const _alias = new Map();
let _timer = null;
let _charge = false;

const lc = (s) => String(s || "").toLowerCase();

export function nomsGeneriques() {
  return new Set(String(process.env.WIKICHAT_NOMS_GENERIQUES ?? "atelier")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

/** Un nom qui ne désigne personne : vide, anonyme, non développé, ou commun. */
export function estGenerique(nom) {
  const n = String(nom || "").trim();
  if (!n) return true;
  if (n.includes("${") || /^\$\{.*\}$/.test(n)) return true;
  if (/^session-/i.test(n)) return true;
  return nomsGeneriques().has(n.toLowerCase());
}

export function chargerConversations() {
  if (_charge) return;
  _charge = true;
  try {
    const brut = JSON.parse(fs.readFileSync(FICHIER(), "utf8"));
    for (const c of brut.conversations || []) {
      c.en_ligne = false; // un redémarrage du service ne dit rien de la présence
      _conv.set(c.session_id, c);
    }
    for (const [a, n] of Object.entries(brut.alias || {})) _alias.set(a, n);
  } catch { /* premier démarrage */ }
}

function sauver() {
  if (_timer) return;
  _timer = setTimeout(() => { _timer = null; ecrire(); }, 1000);
  _timer.unref?.();
}
function ecrire() {
  try {
    const f = FICHIER();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      conversations: [..._conv.values()],
      alias: Object.fromEntries(_alias),
    }));
    fs.renameSync(tmp, f);
  } catch { /* non bloquant */ }
}
export function flushConversations() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  ecrire();
}

function purger() {
  if (_conv.size <= MAX_CONVERSATIONS) return;
  const vieilles = [..._conv.values()].filter(c => !c.en_ligne)
    .sort((a, b) => new Date(a.vu) - new Date(b.vu));
  for (const c of vieilles) {
    if (_conv.size <= MAX_CONVERSATIONS) break;
    _conv.delete(c.session_id);
  }
}

/** Surface d'où vient la conversation, pour l'affichage et les règles du guetteur. */
export function surfaceDe({ entrypoint, atelier_session, lance } = {}) {
  if (lance) return "wikichat";
  if (atelier_session) return "atelier";
  const e = lc(entrypoint);
  if (e.includes("vscode")) return "vscode";
  if (e === "cli") return "terminal";
  if (e.startsWith("sdk")) return "sdk";
  return e || "inconnue";
}

function nomDerive(slug, id) {
  const s = (slug || "atelier").slice(0, 40) || "atelier";
  return `${s}-${String(id).replace(/[^a-zA-Z0-9]/g, "").slice(0, 6).toLowerCase()}`;
}

/**
 * Nom que doit porter la conversation, et d'où il vient.
 * @param {{ session_id, cwd, agent, atelier_session }} e
 */
export function resoudreNom(e) {
  chargerConversations();
  const racine = trouverRacineProjet(e.cwd);
  const slug = racine ? slugDuProjet(racine) : "";
  if (e.agent && !estGenerique(e.agent)) return { nom: String(e.agent).trim(), source: "env", racine, slug };
  const connue = e.session_id ? _conv.get(e.session_id) : null;
  if (connue?.nom) return { nom: connue.nom, source: "connue", racine, slug };
  if (e.session_id) {
    try {
      const n = knownAgentNames().find(x => recall(x, "__claude_session_id") === e.session_id);
      if (n && !estGenerique(n)) return { nom: n, source: "memoire", racine, slug };
    } catch { /* */ }
  }
  if (e.atelier_session && !estGenerique(e.atelier_session)) {
    return { nom: nomDerive(slug, e.atelier_session), source: "atelier", racine, slug };
  }
  if (e.session_id) return { nom: nomDerive(slug, e.session_id), source: "derive", racine, slug };
  return { nom: null, source: null, racine, slug };
}

/** Change le nom d'une conversation : alias, fils, canaux DM, connexions MCP. */
function renommer(rec, nouveau) {
  const ancien = rec.nom;
  if (!ancien || lc(ancien) === lc(nouveau)) return null;
  _alias.set(lc(ancien), nouveau);
  _alias.delete(lc(nouveau));
  rec.alias = [...new Set([...(rec.alias || []), ancien])];
  rec.nom = nouveau;
  renommerDansFils(ancien, nouveau);
  // Le curseur de boîte suit la conversation : sans lui, le nouveau nom
  // repartirait d'un rattrapage et recevrait à nouveau ce qui a déjà été remis.
  try {
    const curseur = recall(ancien, "__inbox_cursor");
    if (curseur && !recall(nouveau, "__inbox_cursor")) remember(nouveau, "__inbox_cursor", curseur);
  } catch { /* */ }
  const a = lc(ancien), n = lc(nouveau);
  for (const ch of state.channels.values()) {
    if (!ch.isDM || !ch.participants) continue;
    const i = ch.participants.indexOf(a);
    if (i >= 0) ch.participants[i] = n;
  }
  return ancien;
}

/**
 * Donne à une connexion MCP de cette conversation le nom de la conversation.
 * Ne renomme qu'une connexion anonyme ou générique, et jamais au détriment
 * d'une autre connexion vivante qui porte déjà ce nom.
 * @returns {number} connexions renommées
 */
export function rattacherConnexionsMcp(sessionId, nom, ancien = null) {
  if (!sessionId || !nom) return 0;
  let n = 0;
  const detenteur = [...state.sessions.values()].find(s => lc(s.name) === lc(nom));
  for (const s of state.sessions.values()) {
    if (s.claude_session !== sessionId) continue;
    if (lc(s.name) === lc(nom)) continue;
    // Une connexion anonyme ou générique prend le nom ; une connexion qui
    // portait l'ancien nom de la conversation le suit.
    if (!estGenerique(s.name) && !(ancien && lc(s.name) === lc(ancien))) continue;
    if (detenteur && detenteur !== s) continue;
    s.name = nom;
    n++;
  }
  return n;
}

/**
 * Déclare le début (ou la reprise) d'une conversation. Appelé par le hook SessionStart.
 * @returns {{ conv: object, ancienNom: string|null, nouvelle: boolean }}
 */
export function declarerDebut(e) {
  chargerConversations();
  if (!e.session_id) return { conv: null, ancienNom: null, nouvelle: false };
  const r = resoudreNom(e);
  const maintenant = new Date().toISOString();
  let conv = _conv.get(e.session_id);
  const nouvelle = !conv;
  if (!conv) {
    conv = { session_id: e.session_id, nom: r.nom, source_nom: r.source, debut: maintenant, alias: [] };
    _conv.set(e.session_id, conv);
  }
  let ancienNom = null;
  if (r.nom && lc(conv.nom) !== lc(r.nom)) {
    ancienNom = renommer(conv, r.nom);
    conv.source_nom = r.source;
  }
  Object.assign(conv, {
    cwd: e.cwd || conv.cwd || null,
    racine: r.racine || conv.racine || null,
    projet: r.slug || conv.projet || null,
    surface: surfaceDe(e),
    atelier_session: e.atelier_session || conv.atelier_session || null,
    derniere_source: e.source || null,
    vu: maintenant,
    en_ligne: true,
    fin: null, raison_fin: null,
  });
  // Mémoire d'identité : ce que `contact_agent` utilise pour reprendre un agent
  // hors ligne (`--resume`), et ce que les anciens chemins lisent encore.
  try {
    remember(conv.nom, "__claude_session_id", e.session_id);
    if (conv.cwd) remember(conv.nom, "__cwd", conv.cwd);
  } catch { /* */ }
  rattacherConnexionsMcp(e.session_id, conv.nom, ancienNom);
  purger();
  sauver();
  return { conv, ancienNom, nouvelle };
}

/** Une activité (prompt, fin de tour) : la conversation est là. */
export function toucher(sessionId, e = {}) {
  chargerConversations();
  let conv = _conv.get(sessionId);
  if (!conv) {
    // Conversation antérieure à l'installation du hook SessionStart : on la
    // déclare au premier signe de vie plutôt que de la laisser sans nom.
    if (!sessionId) return null;
    return declarerDebut({ ...e, session_id: sessionId }).conv;
  }
  conv.vu = new Date().toISOString();
  conv.en_ligne = true;
  sauver();
  return conv;
}

export function declarerFin(sessionId, raison) {
  chargerConversations();
  const conv = _conv.get(sessionId);
  if (!conv) return null;
  conv.en_ligne = false;
  conv.fin = new Date().toISOString();
  conv.raison_fin = raison || null;
  conv.guetteur = null;
  sauver();
  return conv;
}

export function getConversation(sessionId) {
  chargerConversations();
  return _conv.get(sessionId) || null;
}

/** Conversation la plus récente portant ce nom (ou cet alias). */
export function conversationParNom(nom) {
  chargerConversations();
  const n = lc(aliasVers(nom) || nom);
  let meilleure = null;
  for (const c of _conv.values()) {
    if (lc(c.nom) !== n) continue;
    if (!meilleure || new Date(c.vu) > new Date(meilleure.vu)) meilleure = c;
  }
  return meilleure;
}

/** Nom actuel derrière un alias, ou null. Suit les chaînes d'alias. */
export function aliasVers(nom) {
  chargerConversations();
  let n = lc(nom), vu = 0, res = null;
  while (_alias.has(n) && vu++ < 10) { res = _alias.get(n); n = lc(res); }
  return res;
}

/** Présente : déclarée, pas terminée, manifestée récemment. */
export function estPresente(conv) {
  return !!conv?.en_ligne && Date.now() - new Date(conv.vu).getTime() < PRESENCE_MAX_MS;
}

export function conversationsDuProjet(slug, { presentesSeulement = false } = {}) {
  chargerConversations();
  return [..._conv.values()]
    .filter(c => c.projet === slug)
    .filter(c => !presentesSeulement || estPresente(c))
    .sort((a, b) => new Date(b.vu) - new Date(a.vu));
}

/** Noms des conversations présentes (pour la porte dormante et la résolution des noms). */
export function nomsPresents() {
  chargerConversations();
  return [..._conv.values()].filter(estPresente).map(c => c.nom);
}

/** Tous les noms connus (présents ou non), pour résoudre un destinataire. */
export function nomsConnus() {
  chargerConversations();
  return [...new Set([..._conv.values()].map(c => c.nom).filter(Boolean))];
}

/** Réserve le guetteur de la conversation ; rend son identifiant de génération. */
export function nouveauGuetteur(sessionId) {
  const conv = _conv.get(sessionId);
  if (!conv) return null;
  conv.guetteur = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return conv.guetteur;
}
export function guetteurCourant(sessionId) {
  return _conv.get(sessionId)?.guetteur || null;
}

/** Pour les tests. */
export function _reinitialiserConversations() { _conv.clear(); _alias.clear(); _charge = true; }

// Branche la résolution des noms (state.mjs) sur les conversations connues.
brancherConversations({ presents: nomsPresents, connus: nomsConnus, alias: aliasVers });
