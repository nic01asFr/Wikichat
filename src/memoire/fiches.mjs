/**
 * memoire/fiches.mjs — Étape 3 de la capitalisation (W8) : le rangement, par le code.
 *
 * Une fiche par conversation, rattachée à son `session_id` (celui de
 * l'Atelier ; celui du CLI est noté à côté), dans le même stockage que la
 * connaissance : `~/.wikichat/knowledge/conversations/<projet>/<id>.md`. Une
 * ligne par fiche dans `conversations/index.jsonl`. `search_knowledge` les
 * trouve (lecteur unique `connaissance.mjs`) ; le rappel lit l'index.
 *
 * La fiche a deux parties, qui ne s'écrasent pas :
 *   - les **faits**, écrits par le code à chaque fois que la conversation
 *     grandit (étape 1) ;
 *   - le **sens**, écrit après la routine de nuit (étape 2) et gardé quand
 *     les faits sont réécrits ; il est marqué « antérieur » si la
 *     conversation a grandi depuis.
 *
 * Une conversation d'agent code donne une fiche de son projet (A-7) : le
 * profil `code` ne lit que les fiches de son projet.
 */

import fs from "fs";
import path from "path";
import { CHEMINS } from "../chemins.mjs";
import { lireIndexConversations, nomDuDossierProjet } from "../connaissance.mjs";
import { dateCourte, masquerJetons, objetsDe } from "./extraction.mjs";

const _ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;

function ecrireAtomique(chemin, contenu) {
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  const tmp = `${chemin}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contenu, "utf8");
  fs.renameSync(tmp, chemin);
}

export function cheminDeLaFiche(projet, id) {
  if (!_ID.test(String(id || ""))) throw new Error(`identifiant de conversation invalide : ${String(id).slice(0, 60)}`);
  return path.join(CHEMINS.conversations, nomDuDossierProjet(projet), `${id}.md`);
}

export function cheminDeLIndex() {
  return path.join(CHEMINS.conversations, "index.jsonl");
}

/** L'entrée d'index d'une fiche, ou null. */
export function entreeDeLIndex(id) {
  return lireIndexConversations().find(e => e.id === id || e.cli_id === id) || null;
}

/** Réécrit l'index avec cette entrée (remplacée ou ajoutée). */
export function mettreAJourLIndex(entree) {
  const index = lireIndexConversations().filter(e => e.id !== entree.id);
  index.push(entree);
  index.sort((a, b) => String(a.fin || "").localeCompare(String(b.fin || "")));
  ecrireAtomique(cheminDeLIndex(), index.map(e => JSON.stringify(e)).join("\n") + "\n");
  return entree;
}

const puces = (liste) => liste.map(x => `- ${x}`).join("\n");

function nombre(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(".", ",")} M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} k`;
  return String(n);
}

/** Le texte markdown d'une fiche. */
export function rendreFiche(f, sens = null) {
  const tete = [
    "---",
    `id: ${f.id}`,
    `cli_id: ${f.cli_id}`,
    `projet: ${nomDuDossierProjet(f.projet)}`,
    `genre: ${f.genre}`,
    `debut: ${f.debut}`,
    `fin: ${f.fin}`,
    `empreinte_source: ${f.empreinte_source}`,
    `sens: ${sens ? (sens.source === f.empreinte_source ? "a_jour" : "anterieur") : "a_venir"}`,
    "---",
  ];
  const titre = f.titre || `Conversation ${String(f.id).slice(0, 8)}`;
  const l = [...tete, `# ${titre}`, ""];
  l.push(`Projet ${f.projet || "—"} · ${f.genre === "assistant" ? "Assistant" : "agent code"} · du ${dateCourte(f.debut)} au ${dateCourte(f.fin)}${f.surfaces.length ? ` · ${f.surfaces.join(", ")}` : ""}`);
  l.push("");
  l.push(`Résumé : ${sens?.resume_court || "à venir (routine de nuit)."}`);
  l.push("");
  l.push("## Faits (extraits par le code)");
  const faits = [];
  faits.push(`${f.messages} message(s) de la personne, ${f.outils} appel(s) d'outils, ${f.erreurs} erreur(s)` +
    (f.jetons ? ` ; ${nombre(f.jetons.entree)} jetons en entrée, ${nombre(f.jetons.sortie)} en sortie` : ""));
  for (const x of f.faits.slice(0, 20)) faits.push(`${dateCourte(x.quand)} ${x.texte}`);
  if (f.faits.length > 20) faits.push(`… ${f.faits.length - 20} autre(s) fait(s)`);
  if (f.fichiers.length) faits.push(`fichiers touchés (${f.fichiers.length}) : ${f.fichiers.slice(0, 12).join(", ")}${f.fichiers.length > 12 ? "…" : ""}`);
  if (f.commits.length) faits.push(`commits (${f.commits.length}) : ${f.commits.slice(0, 5).map(c => `« ${c} »`).join(", ")}${f.commits.length > 5 ? "…" : ""}`);
  const erreurs = Object.entries(f.erreurs_par_outil || {});
  if (erreurs.length) faits.push(`erreurs : ${erreurs.map(([n, c]) => `${n} ×${c}`).join(", ")}`);
  if (f.lance_par) faits.push(`lancée par : ${f.lance_par}`);
  if (f.tronque) faits.push("transcript très long : fin non lue");
  l.push(puces(faits));
  if (f.citations.length) {
    l.push("", "## Premiers messages de la personne");
    for (const c of f.citations) l.push(`> ${c}`, "");
    if (l[l.length - 1] === "") l.pop();
  }
  if (sens) {
    l.push("", `## Sens (routine de nuit, ${String(sens.le || "").slice(0, 10)}${sens.source === f.empreinte_source ? "" : ", antérieur à la fin de la conversation"})`);
    if (sens.resume?.length) l.push(puces(sens.resume));
    if (sens.sujets?.length) l.push(`Sujets : ${sens.sujets.join(", ")}`);
    if (sens.decisions?.length) l.push("Décisions :", puces(sens.decisions));
    if (sens.questions?.length) l.push("Questions ouvertes :", puces(sens.questions));
  }
  return masquerJetons(l.join("\n") + "\n");
}

/**
 * Écrit (ou réécrit) la fiche des faits, en gardant le sens déjà tiré ; met
 * l'index à jour. Rend l'entrée d'index.
 */
export function rangerFaits(f) {
  const avant = entreeDeLIndex(f.id);
  const sens = avant?.sens || null;
  // Un projet renommé : l'ancienne fiche part, la nouvelle la remplace.
  if (avant && avant.projet !== nomDuDossierProjet(f.projet)) {
    try { fs.unlinkSync(cheminDeLaFiche(avant.projet, f.id)); } catch { /* déjà partie */ }
  }
  ecrireAtomique(cheminDeLaFiche(f.projet, f.id), rendreFiche(f, sens));
  return mettreAJourLIndex(entreeDIndex(f, sens, avant));
}

function entreeDIndex(f, sens, avant) {
  return {
    id: f.id,
    cli_id: f.cli_id,
    projet: nomDuDossierProjet(f.projet),
    genre: f.genre,
    titre: f.titre,
    debut: f.debut,
    fin: f.fin,
    messages: f.messages,
    statut: sens ? (sens.source === f.empreinte_source ? "sens" : "sens_anterieur") : "faits",
    resume: sens?.resume_court || "",
    sujets: sens?.sujets || [],
    decisions: sens?.decisions || [],
    objets: objetsDe(f),
    citations: f.citations,
    empreinte_source: f.empreinte_source,
    faits_le: new Date().toISOString(),
    sens_le: sens?.le || null,
    sens,
    // Ce que la fiche garde pour être réécrite sans relire la conversation.
    faits: f,
    ...(avant?.tentatives_nuit ? { tentatives_nuit: avant.tentatives_nuit } : {}),
  };
}

/** Range le sens tiré par la routine de nuit dans la fiche et l'index. */
export function rangerSens(id, sens) {
  const avant = entreeDeLIndex(id);
  if (!avant?.faits) throw new Error(`fiche inconnue : ${id}`);
  const f = avant.faits;
  ecrireAtomique(cheminDeLaFiche(f.projet, f.id), rendreFiche(f, sens));
  return mettreAJourLIndex({ ...entreeDIndex(f, sens, avant), tentatives_nuit: 0 });
}

/** Note un échec de la routine sur une fiche (elle ne sera pas retentée sans fin). */
export function noterTentative(id, cause) {
  const avant = entreeDeLIndex(id);
  if (!avant) return null;
  return mettreAJourLIndex({ ...avant, tentatives_nuit: (avant.tentatives_nuit || 0) + 1, derniere_cause: String(cause || "").slice(0, 200) });
}

/** L'index, sans le détail des faits (ce que rend la route de liste). */
export function indexPublic({ projet = null, limite = 50 } = {}) {
  let index = lireIndexConversations();
  if (projet) index = index.filter(e => e.projet === nomDuDossierProjet(projet));
  return index.slice(-limite).reverse().map(({ faits, sens, ...reste }) => reste);
}
