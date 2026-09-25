/**
 * projet-fichiers.mjs — Le suivi d'un projet, lu dans ses propres fichiers.
 *
 * Un projet de l'Atelier se décrit lui-même (docs/structure-projet.md de
 * l'Atelier) : `.atelier/projet.json` (titre, description, slug), `ETAT.md`
 * (seul endroit de l'état : lot courant, prochaine étape, « À décider »,
 * « Demandé à l'Atelier »), `docs/decisions/NNNN-*.md`.
 *
 * wikichat tenait à part une copie de tout cela (`project-state.json` :
 * description, décisions, questions ouvertes). Cette copie périmait —
 * « Projet sans nom », aucune décision, alors que le dépôt en comptait. Ici on
 * LIT les fichiers, on ne les écrit jamais : le contrat de sûreté de wikichat
 * interdit d'écrire hors de `.wikichat/` dans un projet.
 *
 * Tout est tolérant : un fichier absent, illisible ou mal formé donne une vue
 * partielle, jamais une erreur. Lecture mise en cache par date de modification.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";

/** Racine des projets de l'Atelier : `<racine>/<slug>/…` → projet `slug`. */
export function racineProjetsAtelier() {
  return process.env.WIKICHAT_ATELIER_PROJETS || path.join(os.homedir(), "work", "projects");
}

function existe(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function stat(p) { try { return fs.statSync(p); } catch { return null; } }
function lire(p, max = 256 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > max) {
      const fd = fs.openSync(p, "r");
      const buf = Buffer.alloc(max);
      fs.readSync(fd, buf, 0, max, 0);
      fs.closeSync(fd);
      return buf.toString("utf8");
    }
    return fs.readFileSync(p, "utf8");
  } catch { return null; }
}

/** Normalise un nom en slug : minuscules, [a-z0-9-], 40 caractères au plus. */
export function slugifier(s) {
  return String(s || "").normalize("NFD").replace(/\p{M}/gu, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/**
 * Racine du projet qui contient `cwd` : le premier dossier, en remontant, qui
 * porte `.atelier/projet.json`, `ETAT.md` ou `.git`. Sous la racine des
 * projets de l'Atelier, le dossier `<racine>/<slug>` l'emporte (un sous-dossier
 * qui aurait son propre `.git` reste dans le projet). S'arrête au dossier
 * personnel. Rend `cwd` lui-même à défaut.
 */
export function trouverRacineProjet(cwd) {
  if (!cwd) return null;
  let dir = path.resolve(String(cwd));
  const racineAtelier = path.resolve(racineProjetsAtelier());
  const rel = path.relative(racineAtelier, dir);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return path.join(racineAtelier, rel.split(path.sep)[0]);
  }
  const maison = path.resolve(os.homedir());
  let courant = dir;
  for (let i = 0; i < 40; i++) {
    if (existe(path.join(courant, ".atelier", "projet.json"))
      || existe(path.join(courant, "ETAT.md"))
      || existe(path.join(courant, ".git"))) return courant;
    if (courant === maison) break;
    const parent = path.dirname(courant);
    if (parent === courant) break;
    courant = parent;
  }
  return dir;
}

/** `.atelier/projet.json`, ou null. */
function lireProjetJson(racine) {
  const brut = lire(path.join(racine, ".atelier", "projet.json"));
  if (!brut) return null;
  try { const o = JSON.parse(brut); return o && typeof o === "object" ? o : null; } catch { return null; }
}

/** Slug du projet : dossier sous la racine Atelier, sinon `projet.json`, sinon nom du dossier. */
export function slugDuProjet(racine, pj = undefined) {
  if (!racine) return "";
  const racineAtelier = path.resolve(racineProjetsAtelier());
  const rel = path.relative(racineAtelier, path.resolve(racine));
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return slugifier(rel.split(path.sep)[0]);
  const json = pj === undefined ? lireProjetJson(racine) : pj;
  if (json?.slug) return slugifier(json.slug);
  return slugifier(path.basename(racine));
}

const PUCE = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const normaliserTitre = (t) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/**
 * Découpe `ETAT.md` : tête (avant la 2ᵉ section de niveau 2, ou avant la
 * première si le fichier commence par elle), sections nommées, puces de
 * « À décider » et « Demandé à l'Atelier ».
 */
export function analyserEtat(texte) {
  const lignes = String(texte || "").replace(/\r\n?/g, "\n").split("\n");
  const sections = [];
  let courante = { titre: "", lignes: [] };
  for (const l of lignes) {
    const m = /^##\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) { sections.push(courante); courante = { titre: m[1], lignes: [] }; continue; }
    courante.lignes.push(l);
  }
  sections.push(courante);

  // Tête : ce qui précède la première section de niveau 2, plus cette
  // première section si elle porte l'état courant (« Où on en est », « Lot
  // courant »…) — la structure met l'état en tête, puis l'historique.
  const utiles = (ls) => ls.filter(l => l.trim() && !/^#\s/.test(l) && !/^<!--/.test(l.trim()));
  let tete = utiles(sections[0].lignes);
  if (sections.length > 1) {
    const premiere = sections[1];
    if (!/d[ée]cider|demand[ée]/i.test(premiere.titre)) tete = tete.concat(utiles(premiere.lignes));
  }
  const puces = (motif) => {
    const s = sections.find(x => motif.test(normaliserTitre(x.titre)));
    if (!s) return [];
    return s.lignes.map(l => PUCE.exec(l)?.[1]).filter(Boolean)
      .filter(x => !/^(rien|aucun|aucune|néant|neant|—|-)\.?$/i.test(x.trim()));
  };
  const titre = lignes.find(l => /^#\s+/.test(l))?.replace(/^#\s+/, "").trim() || null;
  return {
    titre,
    tete: tete.slice(0, 10).map(l => l.trim()),
    aDecider: puces(/^a decider/),
    demandeAtelier: puces(/^demande(s)? a l.?atelier/),
    sections: sections.slice(1).map(s => s.titre),
  };
}

/** Une décision : `docs/decisions/0007-asm-js.md` → numéro, titre, statut, date. */
export function analyserDecision(nomFichier, texte) {
  const num = /^(\d{1,5})/.exec(nomFichier)?.[1] || null;
  const t = String(texte || "").replace(/\r\n?/g, "\n");
  const titre = (/^#\s+(.+)$/m.exec(t)?.[1] || nomFichier.replace(/\.md$/i, "").replace(/^\d+-/, "").replace(/-/g, " ")).trim();
  const statut = (/^\s*(?:[-*]\s*)?\**\s*statut\s*\**\s*[:：]\s*\**\s*([^\n*]+)/im.exec(t)?.[1]
    || /^\s*(?:[-*]\s*)?\**\s*status\s*\**\s*[:：]\s*\**\s*([^\n*]+)/im.exec(t)?.[1] || "").trim() || null;
  const date = /(\d{4}-\d{2}-\d{2})/.exec(t)?.[1] || null;
  return { num, titre: titre.replace(/^\d+\s*[-—:.]\s*/, ""), statut, date, fichier: nomFichier };
}

const _cache = new Map(); // racine → { empreinte, vue }

/** Empreinte des fichiers suivis : change dès qu'un d'eux change. */
function empreinteDe(racine, fichierEtat, dossierDecisions) {
  const parts = [];
  for (const f of [path.join(racine, ".atelier", "projet.json"), fichierEtat]) {
    const st = stat(f);
    parts.push(st ? `${f}:${st.mtimeMs}:${st.size}` : `${f}:-`);
  }
  const std = stat(dossierDecisions);
  parts.push(std ? `${dossierDecisions}:${std.mtimeMs}` : `${dossierDecisions}:-`);
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/**
 * Vue d'un projet depuis ses fichiers.
 *
 * @param {string} cwdOuRacine dossier de travail (ou racine) du projet
 * @returns {{ racine, slug, titre, description, aDesFichiers, etat, decisions, empreinte }|null}
 */
export function lireProjet(cwdOuRacine) {
  const racine = trouverRacineProjet(cwdOuRacine);
  if (!racine || !existe(racine)) return null;
  const pj = lireProjetJson(racine);
  const relEtat = pj?.fichiers?.etat || pj?.etat || "ETAT.md";
  const fichierEtat = path.resolve(racine, String(relEtat));
  const dossierDecisions = path.resolve(racine, String(pj?.fichiers?.decisions || "docs/decisions"));
  const empreinte = empreinteDe(racine, fichierEtat, dossierDecisions);
  const enCache = _cache.get(racine);
  if (enCache && enCache.empreinte === empreinte) return enCache.vue;

  const texteEtat = lire(fichierEtat);
  const stEtat = texteEtat != null ? stat(fichierEtat) : null;
  const etat = texteEtat != null
    ? { chemin: path.relative(racine, fichierEtat).split(path.sep).join("/"), modifie: stEtat ? new Date(stEtat.mtimeMs).toISOString() : null, ...analyserEtat(texteEtat) }
    : null;

  let decisions = [];
  try {
    decisions = fs.readdirSync(dossierDecisions)
      .filter(f => /^\d+.*\.md$/i.test(f))
      .sort()
      .map(f => analyserDecision(f, lire(path.join(dossierDecisions, f), 16 * 1024)));
  } catch { /* pas de dossier de décisions */ }

  const titre = (pj?.titre || pj?.title || etat?.titre || null);
  const vue = {
    racine,
    slug: slugDuProjet(racine, pj),
    titre: titre ? String(titre).trim() : null,
    description: pj?.description ? String(pj.description).trim() : null,
    aDesFichiers: !!(pj || etat || decisions.length),
    etat,
    decisions,
    empreinte,
  };
  _cache.set(racine, { empreinte, vue });
  if (_cache.size > 500) _cache.delete(_cache.keys().next().value);
  return vue;
}

/** Âge lisible d'une date ISO : « il y a 3 min », « il y a 2 j ». */
export function ageLisible(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return "à l'instant";
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

/** Coupe une chaîne à `n` caractères, avec une ellipse. */
export function couper(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + "…" : t;
}

/**
 * Bloc texte du projet pour un briefing (faits, pas d'ordres).
 * @param {object} vue résultat de lireProjet
 * @param {{ lignesTete?: number, decisions?: number, max?: number }} opts
 */
export function blocProjet(vue, { lignesTete = 6, decisions = 3, max = 1400 } = {}) {
  if (!vue || !vue.aDesFichiers) return "";
  const l = [];
  const nom = vue.titre ? `« ${vue.titre} »` : vue.slug;
  if (vue.etat) {
    l.push(`Projet ${nom} — ${vue.etat.chemin} (modifié ${ageLisible(vue.etat.modifie)}) :`);
    for (const x of vue.etat.tete.slice(0, lignesTete)) l.push(`  ${couper(x, 160)}`);
    if (vue.etat.aDecider.length) l.push(`  À décider : ${vue.etat.aDecider.slice(0, 5).map(x => couper(x, 80)).join(" ; ")}`);
    if (vue.etat.demandeAtelier.length) l.push(`  Demandé à l'Atelier : ${vue.etat.demandeAtelier.slice(0, 3).map(x => couper(x, 80)).join(" ; ")}`);
  } else {
    l.push(`Projet ${nom}${vue.description ? ` — ${couper(vue.description, 160)}` : ""} (pas d'ETAT.md).`);
  }
  if (vue.decisions.length && decisions > 0) {
    const d = vue.decisions.slice(-decisions).reverse()
      .map(x => `${x.num || "?"} ${couper(x.titre, 70)}${x.statut ? ` (${couper(x.statut, 20)})` : ""}`);
    l.push(`Décisions récentes (${vue.decisions.length} au total) : ${d.join(" ; ")}`);
  }
  const texte = l.join("\n");
  return texte.length > max ? texte.slice(0, max - 1) + "…" : texte;
}
