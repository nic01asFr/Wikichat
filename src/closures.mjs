/**
 * closures.mjs — Clôture d'un projet et absorption de la clôture (lot W5).
 *
 * Deux choses séparées :
 *
 *   1. Le **Closer** (agent) rédige les quatre sections d'une clôture. Son
 *      prompt donne les vrais chemins du projet : `ETAT.md`,
 *      `docs/decisions/`, `.atelier/projet.json`, `.wikichat/project-state.json`,
 *      `.wikichat/artifacts/`. Il lisait `projects/<projet>.json` (le fichier
 *      central, déplacé depuis dans le projet) et `docs/roles/closer.md` (un
 *      fichier du dépôt wikichat, introuvable depuis le dossier du projet où
 *      il tourne) : le rôle est désormais injecté dans le prompt.
 *
 *   2. L'**absorption** est du code : chaque clôture est rangée en fiche de
 *      connaissance `~/.wikichat/knowledge/closure-<slug>.md`, que
 *      `search_knowledge` retrouve aussitôt, sans agent. L'intégration dans un
 *      axe thématique (Librarian-Absorber, par #library) reste possible
 *      par-dessus, mais la capitalisation n'en dépend plus. Depuis mai, une
 *      seule clôture avait été absorbée.
 */

import fs from "fs";
import path from "path";
import { state } from "./state.mjs";
import { saveProject } from "./persistence.mjs";
import { CHEMINS, DEPOT } from "./chemins.mjs";
import { slugifier, lireProjet } from "./projet-fichiers.mjs";

/** Chemin de la fiche de connaissance d'une clôture. */
export function ficheDeCloture(proj) {
  const slug = slugifier(proj.slug || proj.name) || "projet";
  return path.join(CHEMINS.connaissance, `closure-${slug}.md`);
}

/** Texte markdown d'une clôture. */
export function texteCloture(proj) {
  const c = proj.closure || {};
  const slug = slugifier(proj.slug || proj.name);
  return [
    "---",
    "type: closure",
    `projet: ${JSON.stringify(proj.name)}`,
    `slug: ${slug}`,
    `cloture_le: ${c.closedAt || ""}`,
    `par: ${JSON.stringify(c.closedBy || "")}`,
    ...(proj.repo ? [`depot: ${JSON.stringify(proj.repo)}`] : []),
    "---",
    `# Clôture — ${proj.name}`,
    "",
    "## Documentation", String(c.documentation || "Pas d'élément identifié.").trim(), "",
    "## Livrables", String(c.deliverables || "Pas d'élément identifié.").trim(), "",
    "## Rétrospective", String(c.retro || "Pas d'élément identifié.").trim(), "",
    "## Capitalisation", String(c.capitalisation || "Pas d'élément identifié.").trim(), "",
  ].join("\n");
}

/** Range une clôture en fiche de connaissance et le note dans le projet. */
export function absorberCloture(proj) {
  if (!proj?.closure) return null;
  const fichier = ficheDeCloture(proj);
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  const tmp = `${fichier}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, texteCloture(proj));
  fs.renameSync(tmp, fichier);
  proj.closure.absorbee_le = new Date().toISOString();
  proj.closure.fiche = fichier;
  try { saveProject(proj); } catch { /* la fiche est écrite ; la marque sera reposée au prochain passage */ }
  return fichier;
}

/**
 * Job : absorbe toutes les clôtures qui ne l'ont pas encore été (ou dont la
 * fiche a disparu). Idempotent.
 */
export function absorberClotures() {
  let absorbees = 0, deja = 0;
  const fiches = [];
  for (const proj of state.projects.values()) {
    if (!proj?.closure) continue;
    if (proj.closure.absorbee_le && proj.closure.fiche && fs.existsSync(proj.closure.fiche)) { deja++; continue; }
    const f = absorberCloture(proj);
    if (f) { absorbees++; fiches.push(path.basename(f)); }
  }
  return { absorbees, deja, fiches };
}

/** Modèle de rôle livré avec wikichat (ou sa surcharge dans ~/.wikichat/roles). */
function roleCloser() {
  for (const f of [path.join(CHEMINS.roles, "closer.md"), path.join(DEPOT, "docs", "roles", "closer.md")]) {
    try { return fs.readFileSync(f, "utf8"); } catch { /* suivant */ }
  }
  return "";
}

/**
 * Prompt du Closer, avec les chemins réels du projet.
 * @param {{ projet: string, racine: string }} o
 */
export function promptCloser({ projet, racine }) {
  const vue = racine ? lireProjet(racine) : null;
  const rel = (p) => p.split(path.sep).join("/");
  const sources = [];
  if (vue?.etat) sources.push(`- \`${vue.etat.chemin}\` : état courant, « À décider », ce qui est fait et vérifié`);
  if (vue?.decisions?.length) sources.push(`- \`docs/decisions/\` : ${vue.decisions.length} décision(s) (${vue.decisions.slice(-3).map(d => d.num).join(", ")}…)`);
  if (fs.existsSync(path.join(racine || "", ".atelier", "projet.json"))) sources.push("- `.atelier/projet.json` : titre, description, fichiers du projet");
  if (fs.existsSync(path.join(racine || "", ".wikichat", "project-state.json"))) sources.push("- `.wikichat/project-state.json` : tâches, décisions, bloquants, questions notés par wikichat");
  if (fs.existsSync(path.join(racine || "", ".wikichat", "artifacts"))) sources.push("- `.wikichat/artifacts/` : artefacts produits pendant le projet");
  for (const f of ["README.md", "CLAUDE.md"]) if (fs.existsSync(path.join(racine || "", f))) sources.push(`- \`${f}\``);
  if (!sources.length) sources.push("- les fichiers du dossier (README, docs/, historique git)");
  const nom = `Closer-${projet.slice(0, 12)}`;
  const role = roleCloser();
  return [
    `Tu es ${nom}, agent de clôture wikichat. Ton identité est portée par ta connexion : pas de register.`,
    "",
    `MISSION : produire la clôture du projet "${projet}".`,
    `Dossier du projet (ton dossier de travail) : ${rel(racine || ".")}`,
    "",
    "À LIRE, dans ce dossier :",
    ...sources,
    "- `git log --oneline -30` si c'est un dépôt git",
    "- (facultatif) `search_knowledge` sur le sujet du projet, pour citer les projets liés",
    "",
    "PUIS :",
    "1. Rédige les 4 sections (Documentation, Livrables, Rétrospective, Capitalisation), 2000 mots au plus en tout, sans rien inventer (« Pas d'élément identifié » si une section est vide).",
    `2. close_project(project="${projet}", auto=false, closure={ documentation, deliverables, retro, capitalisation }) : wikichat persiste la clôture, la range en fiche de connaissance et la publie sur #library.`,
    "3. Ne modifie aucun fichier du projet. Sors.",
    ...(role ? ["", "Rôle détaillé (pour référence ; les chemins ci-dessus font foi) :", role] : []),
  ].join("\n");
}
