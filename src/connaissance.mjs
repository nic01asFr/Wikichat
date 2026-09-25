/**
 * connaissance.mjs — Le seul lecteur de la connaissance (lot W1).
 *
 * La connaissance est faite de fichiers markdown **à plat** :
 *   - `~/.wikichat/knowledge/*.md` : axes transverses (`<sujet>-axis.md`,
 *     brouillons `*.draft.md`, fiches de clôture `closure-<projet>.md`) ;
 *   - `<projet>/.wikichat/knowledge/*.md` pour chaque projet du registre.
 *
 * Trois lecteurs la lisaient chacun à leur façon : `search_knowledge` (à plat,
 * correct), `GET /api/knowledge` (qui attendait des sous-dossiers
 * `<sujet>/kb.md` et renvoyait donc une liste vide) et la ressource
 * `wikichat://kb/{topic}` (qui lisait `<cwd>/.wikichat/knowledge`). Ils passent
 * tous par ce module.
 *
 * Identifiant d'une fiche (`sujet`) : le nom du fichier sans `.md`, préfixé du
 * slug du projet pour une fiche de projet (`<slug>/<nom>`).
 */

import fs from "fs";
import path from "path";
import { CHEMINS } from "./chemins.mjs";
import { loadRegistry } from "./registry.mjs";
import { racineProjetsAtelier, slugifier } from "./projet-fichiers.mjs";

/** Dossier central (calculé à l'appel : les tests changent de HOME par processus). */
export function dossierCentral() { return CHEMINS.connaissance; }

function reel(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }

/**
 * Liste des fiches.
 * @param {{ portee?: "central"|"projects"|"all", projet?: string|null }} o
 *   `projet` (slug) : seule la connaissance de ce projet est lue côté projets
 *   (profil code) — le projet du registre qui porte ce slug, et le dossier
 *   `<racine des projets de l'Atelier>/<slug>`.
 * @returns {{ sujet: string, source: string, chemin: string, nom: string }[]}
 */
export function listerFiches({ portee = "all", projet = null } = {}) {
  const fiches = [];
  const vus = new Set(); // un projet enregistré sur ~ recouvrirait le dossier central
  const ajouter = (source, dossier, prefixe) => {
    let entrees;
    try { entrees = fs.readdirSync(dossier, { withFileTypes: true }); } catch { return; }
    for (const e of entrees) {
      if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) continue;
      const chemin = path.join(dossier, e.name);
      const cle = reel(chemin).toLowerCase();
      if (vus.has(cle)) continue;
      vus.add(cle);
      const nom = e.name.slice(0, -3);
      fiches.push({ sujet: prefixe ? `${prefixe}/${nom}` : nom, source, chemin, nom });
    }
  };
  if (portee === "central" || portee === "all") ajouter("central", dossierCentral(), "");
  if (portee === "projects" || portee === "all") {
    let projets = [];
    try { projets = loadRegistry().projects || []; } catch { /* registre absent */ }
    const borne = projet ? slugifier(projet) : null;
    for (const p of projets) {
      if (!p?.path || p.status === "missing") continue;
      const slug = p.slug || p.name;
      if (borne && slugifier(slug) !== borne && slugifier(p.name) !== borne) continue;
      ajouter(slug, path.join(p.path, ".wikichat", "knowledge"), slug);
    }
    if (borne) ajouter(borne, path.join(racineProjetsAtelier(), borne, ".wikichat", "knowledge"), borne);
  }
  return fiches;
}

/** Titre d'une fiche : premier `# `, sinon son nom. */
export function titreDe(texte, nom) {
  const m = String(texte || "").match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : nom;
}

/**
 * Lit une fiche par son sujet (`grist-axis`, `grist` pour `grist-axis`,
 * `<slug>/<nom>`). Refuse tout chemin qui sortirait des dossiers de
 * connaissance.
 * @returns {{ sujet, source, chemin, titre, texte, modifie }|null}
 */
export function lireFiche(sujet, { projet = null } = {}) {
  const s = String(sujet || "").trim().replace(/\.md$/i, "");
  if (!s || s.includes("..") || s.includes("\\")) return null;
  if (projet && s.includes("/") && slugifier(s.split("/")[0]) !== slugifier(projet)) return null;
  const fiches = listerFiches({ portee: s.includes("/") ? "projects" : "central", projet });
  const f = fiches.find(x => x.sujet === s) || fiches.find(x => x.sujet === `${s}-axis`)
    || fiches.find(x => x.sujet.toLowerCase() === s.toLowerCase());
  if (!f) return null;
  try {
    const texte = fs.readFileSync(f.chemin, "utf8");
    const st = fs.statSync(f.chemin);
    return { ...f, titre: titreDe(texte, f.nom), texte, modifie: new Date(st.mtimeMs).toISOString(), taille: st.size };
  } catch { return null; }
}

/**
 * Index des fiches (sans le texte) : sujet, source, titre, résumé, date.
 */
export function indexFiches({ portee = "all" } = {}) {
  return listerFiches({ portee }).map(f => {
    let texte = "";
    let st = null;
    try { texte = fs.readFileSync(f.chemin, "utf8"); st = fs.statSync(f.chemin); } catch { /* */ }
    const corps = texte.replace(/^---[\s\S]*?\n---\n/, "").split("\n").filter(l => l.trim() && !/^#/.test(l)).slice(0, 3).join(" ");
    return {
      sujet: f.sujet, source: f.source, titre: titreDe(texte, f.nom),
      resume: corps.replace(/\s+/g, " ").slice(0, 200),
      modifie: st ? new Date(st.mtimeMs).toISOString() : null,
      taille: st ? st.size : 0,
    };
  });
}

/**
 * Recherche plein texte. Score : terme dans le titre ×3, dans un intertitre ×2,
 * occurrences dans le corps ×1 (10 au plus par terme).
 * @returns {{ total: number, fichiers: number, resultats: object[] }}
 */
export function chercher(requete, { portee = "all", limite = 5, projet = null } = {}) {
  const termes = String(requete || "").toLowerCase().split(/\s+/).filter(t => t.length > 1);
  const fiches = listerFiches({ portee, projet });
  if (!termes.length) return { total: 0, fichiers: fiches.length, resultats: [] };
  const resultats = [];
  for (const f of fiches) {
    let texte;
    try { texte = fs.readFileSync(f.chemin, "utf8"); } catch { continue; }
    const bas = texte.toLowerCase();
    const titre = titreDe(texte, f.nom);
    const intertitres = [...texte.matchAll(/^#{1,3}\s+(.+)$/gm)].map(m => m[1].toLowerCase());
    let score = 0;
    for (const t of termes) {
      if (titre.toLowerCase().includes(t)) score += 3;
      for (const h of intertitres) if (h.includes(t)) score += 2;
      score += Math.min(bas.split(t).length - 1, 10);
    }
    if (!score) continue;
    let debut = -1;
    for (const t of termes) {
      const i = bas.indexOf(t);
      if (i >= 0 && (debut < 0 || i < debut)) debut = i;
    }
    const de = Math.max(0, debut - 80);
    resultats.push({
      sujet: f.sujet, source: f.source, chemin: f.chemin, titre, score,
      extrait: texte.slice(de, de + 280).replace(/\s+/g, " ").trim(),
    });
  }
  resultats.sort((a, b) => b.score - a.score);
  return { total: resultats.length, fichiers: fiches.length, resultats: resultats.slice(0, limite) };
}
