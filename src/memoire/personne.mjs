/**
 * memoire/personne.mjs — La mémoire de la personne (A-7).
 *
 * Un fichier, `~/.wikichat/memoire/personne.json` :
 *   { version, elements: [{ id, type, texte, source, par, cree_le, modifie_le,
 *     empreinte, historique? }], oublies: [{ empreinte, le }] }
 *
 * Quatre types :
 *   - `profil`, `preference`, `interpretation` : n'entrent que par la personne
 *     (l'Atelier appelle la route après son accord dans « À valider », ou son
 *     geste dans « Ma mémoire ») ;
 *   - `fait` : enregistré d'office par le code de la capitalisation.
 *
 * Contre le bruit (`assistant-contexte.md` §3.4) : doublons ignorés par
 * empreinte ; un fait oublié par la personne n'est plus réenregistré ; profil
 * et préférences plafonnés (1 500 et 1 200 caractères) ; au plus 200 faits,
 * les plus anciens partent.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { CHEMINS } from "../chemins.mjs";
import { masquerJetons } from "./extraction.mjs";

export const TYPES = Object.freeze(["profil", "preference", "interpretation", "fait"]);
export const PLAFONDS = Object.freeze({ profil: 1500, preference: 1200, interpretation: 1500 });
export const FAITS_MAX = 200;
export const TEXTE_MAX = 300;

export function cheminPersonne() {
  return path.join(CHEMINS.memoire, "personne.json");
}

function vide() {
  return { version: 1, elements: [], oublies: [] };
}

export function lirePersonne() {
  try {
    const d = JSON.parse(fs.readFileSync(cheminPersonne(), "utf8"));
    return { ...vide(), ...d, elements: Array.isArray(d.elements) ? d.elements : [], oublies: Array.isArray(d.oublies) ? d.oublies : [] };
  } catch { return vide(); }
}

function ecrire(d) {
  const chemin = cheminPersonne();
  fs.mkdirSync(path.dirname(chemin), { recursive: true });
  const tmp = `${chemin}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), "utf8");
  fs.renameSync(tmp, chemin);
}

const normal = (t) => String(t || "").replace(/\s+/g, " ").trim();

export function empreinte(type, texte) {
  return crypto.createHash("sha256").update(`${type}|${normal(texte).toLowerCase()}`).digest("hex").slice(0, 16);
}

export class RefusMemoire extends Error {
  constructor(message, statut = 422) { super(message); this.statut = statut; }
}

function verifierTexte(type, texte) {
  if (!TYPES.includes(type)) throw new RefusMemoire(`type : ${TYPES.join(", ")}`);
  const t = masquerJetons(normal(texte));
  if (t.length < 3) throw new RefusMemoire("texte vide");
  if (t.length > TEXTE_MAX) throw new RefusMemoire(`texte : ${TEXTE_MAX} caractères au plus`);
  return t;
}

function verifierPlafond(d, type, texte, sauf = null) {
  const plafond = PLAFONDS[type];
  if (!plafond) return;
  const total = d.elements.filter(e => e.type === type && e.id !== sauf).reduce((s, e) => s + e.texte.length, 0) + texte.length;
  if (total > plafond) {
    throw new RefusMemoire(`plafond atteint pour « ${type} » (${total} caractères sur ${plafond}) : corriger ou oublier un élément d'abord`);
  }
}

/**
 * Retient un élément. `par` : qui (la personne, par l'Atelier ; `code` pour
 * un fait d'office). Rend `{ element, cree }` ; un doublon rend l'élément
 * existant, `cree: false`.
 */
export function retenir({ type, texte, source = {}, par = "personne" }) {
  const t = verifierTexte(type, texte);
  const d = lirePersonne();
  const e = empreinte(type, t);
  const existant = d.elements.find(x => x.empreinte === e);
  if (existant) return { element: existant, cree: false };
  if (type === "fait" && d.oublies.some(o => o.empreinte === e)) return { element: null, cree: false, oublie: true };
  verifierPlafond(d, type, t);
  const maintenant = new Date().toISOString();
  const element = {
    id: `m-${crypto.randomBytes(5).toString("hex")}`,
    type, texte: t,
    source: source && typeof source === "object" ? Object.fromEntries(Object.entries(source).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [k, v.slice(0, 200)])) : {},
    par: String(par || "personne").slice(0, 120),
    cree_le: maintenant, modifie_le: maintenant, empreinte: e,
  };
  d.elements.push(element);
  // Oublier un fait puis le revalider à la main : il n'est plus « oublié ».
  d.oublies = d.oublies.filter(o => o.empreinte !== e);
  const faits = d.elements.filter(x => x.type === "fait");
  if (faits.length > FAITS_MAX) {
    const trop = new Set(faits.sort((a, b) => a.cree_le.localeCompare(b.cree_le)).slice(0, faits.length - FAITS_MAX).map(x => x.id));
    d.elements = d.elements.filter(x => !trop.has(x.id));
  }
  ecrire(d);
  return { element, cree: true };
}

/** Corrige le texte d'un élément ; l'ancien texte est gardé dans `historique`. */
export function corriger(id, texte, { par = "personne" } = {}) {
  const d = lirePersonne();
  const el = d.elements.find(x => x.id === id);
  if (!el) throw new RefusMemoire(`élément inconnu : ${id}`, 404);
  const t = verifierTexte(el.type, texte);
  verifierPlafond(d, el.type, t, id);
  const avant = el.texte;
  el.historique = [...(el.historique || []), { texte: avant, le: el.modifie_le, par: el.par }].slice(-10);
  el.texte = t;
  el.empreinte = empreinte(el.type, t);
  el.modifie_le = new Date().toISOString();
  el.par = String(par || "personne").slice(0, 120);
  ecrire(d);
  return { element: el, avant };
}

/** Oublie un élément. Un fait oublié ne sera plus réenregistré par le code. */
export function oublier(id) {
  const d = lirePersonne();
  const el = d.elements.find(x => x.id === id);
  if (!el) throw new RefusMemoire(`élément inconnu : ${id}`, 404);
  d.elements = d.elements.filter(x => x.id !== id);
  const empreintes = [el.empreinte, ...(el.historique || []).map(h => empreinte(el.type, h.texte))];
  for (const e of empreintes) if (!d.oublies.some(o => o.empreinte === e)) d.oublies.push({ empreinte: e, le: new Date().toISOString() });
  ecrire(d);
  return { element: el };
}

/** Les faits extraits par le code, enregistrés d'office (A-7). Rend le nombre de nouveaux. */
export function enregistrerFaitsDOffice(faits) {
  let nouveaux = 0;
  for (const f of faits || []) {
    try {
      const r = retenir({ type: "fait", texte: f.texte, source: f.source, par: "code" });
      if (r.cree) nouveaux++;
    } catch { /* un fait mal formé n'empêche pas les autres */ }
  }
  return nouveaux;
}

/**
 * Le texte d'une partie, pour un import `@` du contexte de l'Assistant (C1),
 * sous son plafond.
 */
export function rendrePartie(partie) {
  const titres = { profil: "Profil de la personne", preference: "Préférences de la personne", interpretation: "Ce que l'Assistant a compris", fait: "Faits récents" };
  if (!titres[partie]) throw new RefusMemoire(`partie : ${Object.keys(titres).join(", ")}`);
  const d = lirePersonne();
  let elements = d.elements.filter(e => e.type === partie);
  if (partie === "fait") elements = elements.sort((a, b) => b.cree_le.localeCompare(a.cree_le)).slice(0, 15);
  const lignes = [`# ${titres[partie]}`, "", "Tenu par l'Atelier (« Ma mémoire »). Validé par la personne, sauf les faits, extraits par le code.", ""];
  for (const e of elements) lignes.push(`- ${e.texte}`);
  if (!elements.length) lignes.push("- (rien pour l'instant)");
  return lignes.join("\n") + "\n";
}
