/**
 * memoire/vecteurs.mjs — La recherche par le sens sur les fiches de conversation.
 *
 * Décision de Nicolas du 26/09 : `qwen3-embedding-8b`, **en complément** de la
 * recherche lexicale, jamais à sa place.
 *
 *   - **Quoi** : le texte de la fiche (`knowledge/conversations/<projet>/<id>.md`),
 *     sans son en-tête, 6 000 caractères au plus. Ce texte est déjà filtré :
 *     il vient du transcript filtré par l'Atelier (T10) et passe
 *     `masquerJetons`. Le transcript brut n'est jamais envoyé.
 *   - **Quand** : à l'écriture ou à la mise à jour d'une fiche (passage des
 *     faits, nuit), et en rattrapage à chaque passage (32 fiches au plus) :
 *     une fiche dont le texte a changé depuis son vecteur est recalculée.
 *   - **Par qui** : l'Atelier (`POST /v1/memoire/vecteurs`, clé du lanceur),
 *     qui tient le point d'accès du modèle, sa clé, le filtre des secrets et
 *     le journal (S5 : l'Atelier porte l'état opérationnel). wikichat ne lit
 *     jamais la clé du modèle.
 *   - **Où** : `knowledge/conversations/vecteurs.jsonl`, à côté de l'index ; une
 *     ligne par fiche `{ id, projet, empreinte, modele, dim, v }`, `v` en
 *     Float32 normalisé, base64. L'export assaini (S6) ne publie que les `.md`.
 *
 * La recherche fusionne les deux classements par rang réciproque (RRF, k = 60).
 * Portée inchangée : un projet donné (profil `code`) ne compare que les
 * vecteurs de ce projet. Si le point d'accès ne répond pas, ou si aucune fiche
 * n'a de vecteur, la recherche reste lexicale, sans erreur.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CHEMINS } from "../chemins.mjs";
import { lireFicheConversation, lireIndexConversations, nomDuDossierProjet } from "../connaissance.mjs";
import { clientAtelier } from "./atelier.mjs";

export const TEXTE_MAX = 6000;
export const PAR_APPEL = 16;
export const RATTRAPAGE_MAX = 32;
export const RRF_K = 60;
// Similarité cosinus en deçà de laquelle une fiche trouvée par le seul sens
// n'est pas rendue. Non calibré sur de vraies fiches : réglable.
export function seuilDeSens() {
  const n = Number.parseFloat(process.env.WIKICHAT_MEMOIRE_SEUIL_SENS || "");
  return Number.isFinite(n) ? n : 0.35;
}
export function sensActif() { return process.env.WIKICHAT_MEMOIRE_SENS !== "0"; }

export function cheminDesVecteurs() { return path.join(CHEMINS.conversations, "vecteurs.jsonl"); }

// ── Stockage ─────────────────────────────────────────────────────────────────

function encoder(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  const f = Float32Array.from(v, x => x / n);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
}

function decoder(b64) {
  const b = Buffer.from(String(b64 || ""), "base64");
  const copie = new ArrayBuffer(b.length);
  new Uint8Array(copie).set(b);
  return new Float32Array(copie);
}

/** Les vecteurs rangés : Map id → { id, projet, empreinte, modele, dim, v: Float32Array }. */
export function lireVecteurs() {
  const sortie = new Map();
  let brut;
  try { brut = fs.readFileSync(cheminDesVecteurs(), "utf8"); } catch { return sortie; }
  for (const l of brut.split("\n")) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (o && o.id && o.v) sortie.set(o.id, { ...o, v: decoder(o.v) });
    } catch { /* ligne abîmée : ignorée, recalculée au prochain passage */ }
  }
  return sortie;
}

function ecrireVecteurs(map) {
  fs.mkdirSync(path.dirname(cheminDesVecteurs()), { recursive: true });
  const lignes = [...map.values()].map(({ v, ...reste }) => JSON.stringify({ ...reste, v: v instanceof Float32Array ? Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64") : v }));
  const tmp = `${cheminDesVecteurs()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, lignes.join("\n") + (lignes.length ? "\n" : ""), "utf8");
  fs.renameSync(tmp, cheminDesVecteurs());
}

/** Le texte d'une fiche qu'on vectorise : sans en-tête, espaces réduits, borné. */
export function texteAVectoriser(texteDeLaFiche) {
  return String(texteDeLaFiche || "")
    .replace(/^---[\s\S]*?\n---\n/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TEXTE_MAX);
}

const empreinteDe = (t) => crypto.createHash("sha256").update(t).digest("hex").slice(0, 16);

// ── Calcul ───────────────────────────────────────────────────────────────────

/**
 * Calcule les vecteurs manquants ou périmés. `ids` : seulement ces fiches ;
 * sinon toutes celles de l'index, `max` au plus. Ne lève jamais : un point
 * d'accès absent laisse les fiches sans vecteur (recherche lexicale).
 */
export async function indexerVecteurs({ atelier = clientAtelier(), ids = null, max = RATTRAPAGE_MAX } = {}) {
  const bilan = { calcules: 0, a_jour: 0, retires: 0, erreur: null };
  if (!sensActif()) return { ...bilan, erreur: "désactivé (WIKICHAT_MEMOIRE_SENS=0)" };
  const index = lireIndexConversations();
  const vecteurs = lireVecteurs();
  const connus = new Set(index.map(e => e.id));
  for (const id of [...vecteurs.keys()]) {
    if (!connus.has(id)) { vecteurs.delete(id); bilan.retires++; }
  }
  const voulus = ids ? new Set(ids.map(String)) : null;
  const a_faire = [];
  for (const e of [...index].reverse()) {
    if (voulus && !voulus.has(e.id) && !voulus.has(e.cli_id)) continue;
    const f = lireFicheConversation(e.id, { projet: e.projet });
    if (!f) continue;
    const texte = texteAVectoriser(f.texte);
    if (!texte) continue;
    const empreinte = empreinteDe(texte);
    const deja = vecteurs.get(e.id);
    if (deja && deja.empreinte === empreinte && deja.projet === e.projet) { bilan.a_jour++; continue; }
    if (a_faire.length >= max) break;
    a_faire.push({ id: e.id, projet: e.projet, texte, empreinte });
  }
  for (let i = 0; i < a_faire.length; i += PAR_APPEL) {
    const lot = a_faire.slice(i, i + PAR_APPEL);
    let r;
    try { r = typeof atelier?.vecteurs === "function" ? await atelier.vecteurs(lot.map(x => x.texte), "fiche") : { absent: true, raison: "client sans vecteurs" }; }
    catch (err) { r = { absent: true, raison: err.message }; }
    const vecs = r?.json?.vecteurs;
    if (r?.absent || r?.statut !== 200 || !Array.isArray(vecs) || vecs.length !== lot.length) {
      bilan.erreur = r?.absent ? r.raison : `HTTP ${r?.statut} ${r?.json?.erreur || ""}`.trim();
      break;
    }
    lot.forEach((x, k) => {
      vecteurs.set(x.id, { id: x.id, projet: x.projet, empreinte: x.empreinte, modele: r.json.modele || "", dim: vecs[k].length, v: encoder(vecs[k]) });
    });
    bilan.calcules += lot.length;
  }
  if (bilan.calcules || bilan.retires) ecrireVecteurs(vecteurs);
  return bilan;
}

// ── Recherche ────────────────────────────────────────────────────────────────

function cosinus(a, b) {
  if (a.length !== b.length) return -1;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Les fiches proches par le sens, dans la portée : `[{ id, similarite }]`
 * triées, au-dessus du seuil. `null` si le sens est indisponible (point
 * d'accès absent, aucun vecteur) : l'appelant reste lexical.
 */
export async function rangParLeSens(requete, { projet = null, depuis = null, atelier = clientAtelier(), limite = 20 } = {}) {
  const q = String(requete || "").trim();
  if (!q || !sensActif()) return null;
  const vecteurs = lireVecteurs();
  if (!vecteurs.size) return null;
  const dossier = projet ? nomDuDossierProjet(projet) : null;
  const index = new Map(lireIndexConversations().map(e => [e.id, e]));
  const candidats = [...vecteurs.values()].filter(v => {
    const e = index.get(v.id);
    if (!e) return false;
    if (dossier && (e.projet !== dossier || v.projet !== dossier)) return false;
    if (depuis && String(e.fin || e.debut || "") < String(depuis)) return false;
    return true;
  });
  if (!candidats.length) return [];
  let r;
  if (typeof atelier?.vecteurs !== "function") return null;
  try { r = await atelier.vecteurs([q.slice(0, 1000)], "requete"); } catch { return null; }
  const qv = r?.json?.vecteurs?.[0];
  if (r?.absent || r?.statut !== 200 || !Array.isArray(qv) || !qv.length) return null;
  const qn = decoder(encoder(qv));
  const seuil = seuilDeSens();
  return candidats
    .map(v => ({ id: v.id, similarite: cosinus(qn, v.v) }))
    .filter(x => x.similarite >= seuil)
    .sort((a, b) => b.similarite - a.similarite)
    .slice(0, limite);
}

/** Fusion par rang réciproque : `listes` de clés ordonnées → Map clé → score. */
export function fusionnerRangs(listes, k = RRF_K) {
  const scores = new Map();
  for (const liste of listes) {
    liste.forEach((cle, rang) => scores.set(cle, (scores.get(cle) || 0) + 1 / (k + rang + 1)));
  }
  return scores;
}

/**
 * Le rappel fusionné (route `/api/memoire/rappel`, donc `atelier_rappel`) :
 * même forme que `chercherConversations`, plus `sens` (`fait`, `indisponible`)
 * et, par résultat, `similarite` quand le sens l'a trouvé.
 */
export async function rappelFusionne(requete, { projet = null, depuis = null, limite = 5, atelier = clientAtelier(), lexical } = {}) {
  const lex = lexical(requete, { projet, depuis, limite: 50 });
  const sens = await rangParLeSens(requete, { projet, depuis, atelier });
  if (!sens) return { ...lex, resultats: lex.resultats.slice(0, limite), sens: "indisponible" };
  const index = new Map(lireIndexConversations().map(e => [e.id, e]));
  const parId = new Map(lex.resultats.map(r => [r.id, r]));
  const sim = new Map(sens.map(s => [s.id, s.similarite]));
  const scores = fusionnerRangs([lex.resultats.map(r => r.id), sens.map(s => s.id)]);
  const ordre = [...scores.keys()].sort((a, b) => scores.get(b) - scores.get(a));
  const resultats = [];
  for (const id of ordre) {
    let r = parId.get(id);
    if (!r) {
      const e = index.get(id);
      if (!e) continue;
      r = { id: e.id, projet: e.projet, genre: e.genre, debut: e.debut, fin: e.fin, titre: e.titre,
        resume: e.resume || "", objets: (e.objets || []).slice(0, 5), statut: e.statut, score: 0 };
    }
    resultats.push(sim.has(id) ? { ...r, similarite: Math.round(sim.get(id) * 1000) / 1000 } : r);
    if (resultats.length >= limite) break;
  }
  const total = new Set([...lex.resultats.map(r => r.id), ...sens.map(s => s.id)]).size;
  return { total, fiches: lex.fiches, resultats, sens: "fait" };
}

/**
 * `search_knowledge` : complète le classement lexical de la connaissance par
 * le sens des fiches de conversation, dans la même portée (`projet` pour un
 * profil `code`). `r` : le résultat de `chercher` (demandé avec une marge).
 */
export async function completerParLeSens(requete, r, { projet = null, limite = 5, atelier = clientAtelier() } = {}) {
  const sens = await rangParLeSens(requete, { projet, atelier });
  if (!sens || !sens.length) return { ...r, resultats: r.resultats.slice(0, limite), sens: sens ? "fait" : "indisponible" };
  const cle = (id) => `conversation:${id}`;
  const parSujet = new Map(r.resultats.map(x => [x.sujet, x]));
  const sim = new Map(sens.map(s => [cle(s.id), s.similarite]));
  const scores = fusionnerRangs([r.resultats.map(x => x.sujet), sens.map(s => cle(s.id))]);
  const ordre = [...scores.keys()].sort((a, b) => scores.get(b) - scores.get(a));
  const resultats = [];
  for (const sujet of ordre) {
    let x = parSujet.get(sujet);
    if (!x) {
      const f = lireFicheConversation(sujet.slice("conversation:".length), { projet });
      if (!f) continue;
      const resume = (f.texte.match(/^Résumé : (.+)$/m) || [])[1] || "";
      x = { sujet, source: f.source, chemin: f.chemin, titre: f.titre, score: 0, extrait: resume.slice(0, 280) };
    }
    resultats.push(sim.has(sujet) ? { ...x, similarite: Math.round(sim.get(sujet) * 1000) / 1000 } : x);
    if (resultats.length >= limite) break;
  }
  const total = new Set([...r.resultats.map(x => x.sujet), ...sim.keys()]).size;
  return { ...r, total: Math.max(r.total, total), resultats, sens: "fait" };
}
