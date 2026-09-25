/**
 * fils.mjs — Fils de discussion entre agents : qui doit répondre, à quoi, pour quand.
 *
 * Les messages portaient déjà `reply_to`, `expects_reply`, `status` et
 * `eta_seconds`, mais rien ne les reliait : impossible de savoir quels
 * échanges étaient ouverts, qui devait une réponse, ni si un message avait été
 * lu. Un fil les regroupe :
 *
 *   - un DM (ou un message qui porte `thread`) appartient à un fil `f-xxxxxx` ;
 *   - `reply_to` rattache au fil du message cité ;
 *   - `expects_reply=true` ouvre (ou rouvre) le fil et désigne le destinataire
 *     comme débiteur de la réponse ; une réponse sans `expects_reply` solde la
 *     dette ; `status="done"` clôt le fil ;
 *   - `reply_by_seconds` fixe une échéance ; un fil en retard est signalé à
 *     celui qui attend (hooks SessionStart / UserPromptSubmit) ;
 *   - un message remis à son destinataire (hook, poll, /api/inbox) est marqué
 *     lu : le fil le montre à l'expéditeur.
 *
 * Persisté dans `.wikichat/fils.json` (dossier du service), à côté des messages.
 */

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { state } from "./state.mjs";

const FICHIER = path.join(process.cwd(), ".wikichat", "fils.json");
const MAX_FILS = 2000;
const MAX_MESSAGES_PAR_FIL = 50;
/** Un DM sans fil désigné rejoint le fil ouvert entre les mêmes personnes s'il a bougé depuis moins de… */
const FENETRE_SUITE_MS = parseInt(process.env.WIKICHAT_FIL_SUITE_MS || `${30 * 60 * 1000}`);

/** @type {Map<string, object>} */
const _fils = new Map();
/** messageId → filId */
const _parMessage = new Map();
let _timer = null;

const lc = (s) => String(s || "").toLowerCase();

export function chargerFils() {
  try {
    if (!fs.existsSync(FICHIER)) return;
    const brut = JSON.parse(fs.readFileSync(FICHIER, "utf8"));
    for (const f of brut.fils || []) {
      _fils.set(f.id, f);
      for (const m of f.messages || []) _parMessage.set(m.id, f.id);
    }
  } catch { /* fichier abîmé : on repart à vide */ }
}

function sauver() {
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    try {
      fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
      const tmp = FICHIER + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ fils: [..._fils.values()] }));
      fs.renameSync(tmp, FICHIER);
    } catch { /* non bloquant */ }
  }, 1500);
  _timer.unref?.();
}

export function flushFils() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  try {
    fs.mkdirSync(path.dirname(FICHIER), { recursive: true });
    fs.writeFileSync(FICHIER, JSON.stringify({ fils: [..._fils.values()] }));
  } catch { /* */ }
}

function nouvelId() { return `f-${randomBytes(3).toString("hex")}`; }

/** Retrouve un message par identifiant complet ou par ses 8 premiers caractères. */
export function trouverMessage(idOuPrefixe) {
  if (!idOuPrefixe) return null;
  const x = String(idOuPrefixe).trim();
  for (let i = state.messages.length - 1; i >= 0; i--) {
    const m = state.messages[i];
    if (m.id === x || (x.length >= 6 && m.id.startsWith(x))) return m;
  }
  return null;
}

/** Fil d'un message, s'il en a un. */
export function filDuMessage(messageId) {
  const id = _parMessage.get(messageId);
  return id ? _fils.get(id) || null : null;
}

export function getFil(id) {
  if (!id) return null;
  return _fils.get(String(id).trim()) || null;
}

function purger() {
  if (_fils.size <= MAX_FILS) return;
  // Les plus anciens fils clos partent d'abord ; un fil ouvert n'est jamais purgé.
  const clos = tries.filter(f => f.statut === "clos").sort((a, b) => new Date(a.maj) - new Date(b.maj));
  for (const f of clos) {
    if (_fils.size <= MAX_FILS) break;
    _fils.delete(f.id);
    for (const m of f.messages || []) _parMessage.delete(m.id);
  }
}

/**
 * Rattache un message émis à un fil (en crée un au besoin).
 *
 * @param {object} msg  message déjà poussé (id, fromName, timestamp, content)
 * @param {object} o
 * @param {string}   o.expediteur nom canonique de l'expéditeur
 * @param {string[]} o.destinataires noms canoniques des destinataires
 * @param {string}  [o.thread]  identifiant de fil demandé
 * @param {string}  [o.replyTo] message cité
 * @param {boolean} [o.expectsReply]
 * @param {string}  [o.status]  over | standby | done
 * @param {number}  [o.replyBySeconds]
 * @param {boolean} [o.forcer] créer un fil même sans DM ni thread (contact_agent)
 * @returns {object|null} le fil
 */
export function rattacherMessage(msg, o) {
  const exp = lc(o.expediteur);
  const dests = [...new Set((o.destinataires || []).map(lc).filter(d => d && d !== exp))];
  let fil = o.thread ? getFil(o.thread) : null;
  if (!fil && o.replyTo) {
    const cite = trouverMessage(o.replyTo);
    if (cite) fil = filDuMessage(cite.id);
  }
  if (!fil && !o.thread && !o.forcer && !msg.isDM) return null;
  // Un DM sans fil désigné poursuit l'échange ouvert récent entre les mêmes
  // personnes, plutôt que d'ouvrir un fil par message.
  if (!fil && !o.thread && msg.isDM) {
    const groupe = [exp, ...dests].sort().join("|");
    const limite = Date.now() - FENETRE_SUITE_MS;
    fil = [..._fils.values()]
      .filter(f => f.statut === "ouvert" && new Date(f.maj).getTime() >= limite)
      .filter(f => [...f.participants].sort().join("|") === groupe)
      .sort((a, b) => new Date(b.maj) - new Date(a.maj))[0] || null;
  }
  if (!fil && !dests.length && !o.thread) return null;

  const maintenant = new Date().toISOString();
  if (!fil) {
    fil = {
      id: o.thread && /^f-[0-9a-f]{4,12}$/.test(o.thread) ? o.thread : nouvelId(),
      participants: [exp, ...dests],
      sujet: String(msg.content || "").replace(/\s+/g, " ").trim().slice(0, 100),
      ouvert_par: exp,
      statut: "ouvert",
      attend: [],
      echeance: null,
      cree: maintenant,
      maj: maintenant,
      messages: [],
    };
    _fils.set(fil.id, fil);
  }
  for (const d of [exp, ...dests]) if (!fil.participants.includes(d)) fil.participants.push(d);

  // Qui doit quoi, maintenant ?
  const autres = dests.length ? dests : fil.participants.filter(p => p !== exp);
  fil.attend = fil.attend.filter(p => p !== exp); // l'expéditeur vient de parler : il ne doit plus rien
  if (o.status === "done") {
    fil.statut = "clos";
    fil.attend = [];
    fil.echeance = null;
  } else {
    if (o.expectsReply) {
      fil.statut = "ouvert";
      for (const a of autres) if (!fil.attend.includes(a)) fil.attend.push(a);
      fil.echeance = o.replyBySeconds > 0
        ? new Date(Date.now() + o.replyBySeconds * 1000).toISOString()
        : null;
    } else if (!fil.attend.length) {
      fil.echeance = null;
    }
  }
  fil.maj = maintenant;
  fil.messages.push({
    id: msg.id, de: exp, a: autres, t: maintenant,
    extrait: String(msg.content || "").replace(/\s+/g, " ").trim().slice(0, 160),
    attend_reponse: !!o.expectsReply, status: o.status || null,
  });
  if (fil.messages.length > MAX_MESSAGES_PAR_FIL) fil.messages = fil.messages.slice(-MAX_MESSAGES_PAR_FIL);
  _parMessage.set(msg.id, fil.id);
  msg.thread_id = fil.id;
  purger();
  sauver();
  return fil;
}

/** Marque des messages comme lus par `lecteur` (accusés de lecture). */
export function marquerLus(messages, lecteur) {
  const l = lc(lecteur);
  if (!l) return;
  let change = false;
  for (const m of messages || []) {
    if (!m?.id) continue;
    let s = state.reads.get(m.id);
    if (!s) { s = new Set(); state.reads.set(m.id, s); }
    if (!s.has(l)) { s.add(l); change = true; }
    const fil = filDuMessage(m.id);
    if (fil) {
      const e = fil.messages.find(x => x.id === m.id);
      if (e) { e.lu_par = e.lu_par || []; if (!e.lu_par.includes(l)) { e.lu_par.push(l); change = true; } }
    }
  }
  if (change) sauver();
}

/** Remplace un nom par un autre dans les fils (renommage d'une conversation). */
export function renommerDansFils(ancien, nouveau) {
  const a = lc(ancien), n = lc(nouveau);
  if (!a || !n || a === n) return;
  for (const f of _fils.values()) {
    f.participants = [...new Set(f.participants.map(p => p === a ? n : p))];
    f.attend = [...new Set(f.attend.map(p => p === a ? n : p))];
    if (f.ouvert_par === a) f.ouvert_par = n;
  }
  sauver();
}

/**
 * Fils d'un agent.
 * @param {string} nom
 * @param {{ statut?: "ouvert"|"clos"|"tous", limite?: number }} opts
 */
export function filsDe(nom, { statut = "ouvert", limite = 20 } = {}) {
  const n = lc(nom);
  return [..._fils.values()]
    .filter(f => f.participants.includes(n))
    .filter(f => statut === "tous" || f.statut === statut)
    .sort((a, b) => new Date(b.maj) - new Date(a.maj))
    .slice(0, limite);
}

/** Fils d'un ensemble de participants (ex. tous les agents d'un projet). */
export function filsEntre(noms, opts = {}) {
  const set = new Set((noms || []).map(lc));
  const vus = new Map();
  for (const n of set) for (const f of filsDe(n, { ...opts, limite: 200 })) vus.set(f.id, f);
  return [...vus.values()].sort((a, b) => new Date(b.maj) - new Date(a.maj)).slice(0, opts.limite || 20);
}

/** Vrai si l'échéance du fil est passée alors qu'une réponse est due. */
export function enRetard(fil) {
  return fil.statut === "ouvert" && fil.attend.length > 0 && !!fil.echeance
    && new Date(fil.echeance).getTime() < Date.now();
}

/** Une ligne lisible par fil, du point de vue de `nom`. */
export function resumerFil(fil, nom) {
  const n = lc(nom);
  const autres = fil.participants.filter(p => p !== n);
  const qui = fil.attend.includes(n)
    ? "réponse attendue de ta part"
    : fil.attend.length ? `réponse attendue de ${fil.attend.join(", ")}` : "rien d'attendu";
  const retard = enRetard(fil) ? " — échéance dépassée" : "";
  const dernier = fil.messages.at(-1);
  const lu = dernier && dernier.de === n && dernier.lu_par?.length ? ` (lu par ${dernier.lu_par.join(", ")})` : "";
  return `${fil.id} avec ${autres.join(", ") || "?"} : ${qui}${retard}${lu} — « ${fil.sujet.slice(0, 60)} »`;
}

/** Vue sérialisable d'un fil pour l'API. */
export function filPourApi(fil) {
  return { ...fil, en_retard: enRetard(fil) };
}

/** Pour les tests. */
export function _reinitialiserFils() { _fils.clear(); _parMessage.clear(); }
