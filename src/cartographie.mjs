/**
 * cartographie.mjs — Le graphe des projets (lot W4), servi par
 * `GET /api/cartographie`. Contrat : docs/cartographie-contrat.md.
 *
 * Calculé à chaque appel à partir des briques existantes, sans rien saisir :
 *   - registre (registry.json) et projets de l'Atelier (WIKICHAT_ATELIER_PROJETS) ;
 *   - méta déclarée (state.projects : lifecycle, purpose, axes, relations, health, closure) ;
 *   - instantanés (<projet>/.wikichat/state-snapshot.json) ;
 *   - audits (~/.wikichat/audits.json) ;
 *   - fichiers d'état (ETAT.md, docs/decisions/, .atelier/projet.json) ;
 *   - clustering (~/.wikichat/clusters/<date>.json) ;
 *   - connecteurs (<projet>/.mcp.json : noms seulement).
 */

import fs from "fs";
import path from "path";
import { state } from "./state.mjs";
import { loadRegistry } from "./registry.mjs";
import { loadSnapshot } from "./snapshot.mjs";
import { lireProjet, racineProjetsAtelier, slugifier } from "./projet-fichiers.mjs";
import { CHEMINS } from "./chemins.mjs";

export const VERSION_CARTOGRAPHIE = 1;
export const TYPES_ARETES = Object.freeze(["relation", "proximite", "meme_connecteur"]);

function lireJson(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

/** Dernier fichier de clustering : { date, graphe } ou null. */
export function dernierClustering() {
  let fichiers = [];
  try { fichiers = fs.readdirSync(CHEMINS.clusters).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); } catch { return null; }
  for (let i = fichiers.length - 1; i >= 0; i--) {
    const g = lireJson(path.join(CHEMINS.clusters, fichiers[i]));
    if (g && Array.isArray(g.edges)) return { date: fichiers[i].slice(0, 10), graphe: g };
  }
  return null;
}

/** Noms des serveurs MCP déclarés par le projet ; null si pas de .mcp.json lisible. */
export function connecteursDuProjet(chemin) {
  if (!chemin) return null;
  const j = lireJson(path.join(chemin, ".mcp.json"));
  if (!j || typeof j !== "object") return null;
  const serveurs = j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : {};
  return Object.keys(serveurs).sort();
}

function connecteursCommunsFixes() {
  return String(process.env.WIKICHAT_CONNECTEURS_COMMUNS ?? "wikichat,atelier")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

function instantaneDe(chemin) {
  const s = chemin ? loadSnapshot(chemin) : null;
  if (!s) return null;
  const g = s.git || null;
  return {
    le: s.ts || null,
    branche: g?.branch && g.branch !== "?" ? g.branch : null,
    dernier_commit: g?.lastCommit ? { hash: g.lastCommit.hash || null, date: g.lastCommit.date || null, message: g.lastCommit.message || null } : null,
    commits_5j: g?.commitCount5d || 0,
    modifs_non_commitees: !!g?.uncommitted,
  };
}

function santeDe(audit) {
  if (!audit || !audit.exists || typeof audit.score !== "number") return null;
  return { score: audit.score, le: audit.audited_at || null, alertes: Array.isArray(audit.warnings) ? audit.warnings : [] };
}

/**
 * Calcule le graphe.
 * @param {{ absents?: boolean, liens?: string[], seuil?: number }} o
 */
export function calculerCartographie(options = {}) {
  const cle = JSON.stringify([!!options.absents, options.liens || TYPES_ARETES, options.seuil ?? 0.2]);
  const c = _cache.get(cle);
  if (c && Date.now() - c.le < CACHE_MS && !options.sansCache) return c.graphe;
  const graphe = _calculer(options);
  _cache.set(cle, { le: Date.now(), graphe });
  if (_cache.size > 20) _cache.delete(_cache.keys().next().value);
  return graphe;
}

/**
 * Le calcul lit quelques fichiers par projet (environ 0,6 s pour 160 projets
 * sous Windows) : il est gardé 15 s, ce qui suffit à un affichage de carte
 * sans masquer un instantané (toutes les 5 min).
 */
const CACHE_MS = parseInt(process.env.WIKICHAT_CARTOGRAPHIE_CACHE_MS || "15000");
const _cache = new Map();

function _calculer({ absents = false, liens = TYPES_ARETES, seuil = 0.2 } = {}) {
  const registre = (() => { try { return loadRegistry(); } catch { return { projects: [] }; } })();
  const audits = lireJson(CHEMINS.audits) || { audits: {} };
  const racineAtelier = path.resolve(racineProjetsAtelier());
  const cleChemin = (p) => path.resolve(p).toLowerCase();

  // ── Nœuds ────────────────────────────────────────────────────────────────
  const noeuds = [];
  const parChemin = new Map();
  const ids = new Set();
  let absentsExclus = 0;
  const nouvelId = (base) => {
    let id = base || "projet";
    for (let n = 2; ids.has(id); n++) id = `${base}~${n}`;
    ids.add(id);
    return id;
  };
  const creer = (p, origine) => {
    const vue = p.path && fs.existsSync(p.path) ? lireProjet(p.path) : null;
    const n = {
      id: nouvelId(p.slug || slugifier(p.name) || (p.path ? slugifier(path.basename(p.path)) : "")),
      nom: p.name || p.slug || path.basename(p.path || ""),
      titre: vue?.titre || null,
      description: vue?.description || (p.description ? String(p.description) : null) || null,
      chemin: p.path || null,
      origine: [origine],
      statut: p.status || (origine === "atelier" ? "atelier" : "discovered"),
      cycle_de_vie: null, but: null, axes: [],
      pile: Array.isArray(p.stack) ? p.stack : [],
      github: p.github?.url ? { url: p.github.url, visibilite: p.github.visibility || null } : null,
      instantane: instantaneDe(p.path),
      sante: santeDe(p.path ? audits.audits?.[p.path] : null),
      etat: vue?.etat ? {
        fichier: vue.etat.chemin, modifie: vue.etat.modifie || null,
        tete: (vue.etat.tete || []).slice(0, 3), a_decider: (vue.etat.aDecider || []).length,
      } : null,
      decisions: vue?.decisions?.length || 0,
      cloture: null,
      connecteurs: connecteursDuProjet(p.path),
      atelier: null,
    };
    noeuds.push(n);
    if (p.path) parChemin.set(cleChemin(p.path), n);
    return n;
  };

  for (const p of registre.projects || []) {
    if (p.status === "missing" && !absents) { absentsExclus++; continue; }
    if (p.path && parChemin.has(cleChemin(p.path))) continue; // doublon de chemin au registre
    creer(p, "registre");
  }
  try {
    for (const e of fs.readdirSync(racineAtelier, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const chemin = path.join(racineAtelier, e.name);
      const deja = parChemin.get(cleChemin(chemin));
      if (deja) { if (!deja.origine.includes("atelier")) deja.origine.push("atelier"); continue; }
      creer({ path: chemin, slug: slugifier(e.name), name: e.name }, "atelier");
    }
  } catch { /* pas de racine Atelier sur ce poste */ }

  // Index nom/slug → nœud, pour la méta déclarée et les relations.
  const index = new Map();
  for (const n of noeuds) {
    for (const k of [n.id, n.nom, slugifier(n.nom), n.chemin ? slugifier(path.basename(n.chemin)) : null]) {
      if (k && !index.has(String(k).toLowerCase())) index.set(String(k).toLowerCase(), n);
    }
  }
  const trouver = (nom) => {
    if (!nom) return null;
    return index.get(String(nom).toLowerCase()) || index.get(slugifier(nom)) || null;
  };

  // ── Méta déclarée ────────────────────────────────────────────────────────
  const declares = [];
  for (const proj of state.projects.values()) {
    const n = (proj.repo && parChemin.get(cleChemin(proj.repo))) || trouver(proj.slug) || trouver(proj.name);
    if (!n) continue;
    declares.push([proj, n]);
    if (!n.origine.includes("declare")) n.origine.push("declare");
    if (proj.lifecycle) n.cycle_de_vie = proj.lifecycle;
    if (proj.purpose) n.but = proj.purpose;
    if (Array.isArray(proj.axes)) n.axes = proj.axes;
    if (!n.description && proj.description) n.description = String(proj.description);
    if (!n.sante) n.sante = santeDe(proj.health);
    if (proj.closure) {
      n.cloture = { le: proj.closure.closedAt || null, fiche: proj.closure.fiche ? path.basename(proj.closure.fiche, ".md") : null };
      n.cycle_de_vie = "closed";
    }
  }

  // ── Arêtes ───────────────────────────────────────────────────────────────
  const aretes = [];
  const vues = new Set();
  const paire = (a, b) => (a < b ? [a, b] : [b, a]);
  let relationsSansCible = 0;

  if (liens.includes("relation")) {
    for (const [proj, n] of declares) {
      for (const r of Array.isArray(proj.relations) ? proj.relations : []) {
        if (!r || typeof r !== "object" || !r.project) continue; // ancien format (chaînes) : sans type, ignoré
        const cible = trouver(r.project);
        if (!cible || cible === n) { relationsSansCible++; continue; }
        const id = `relation:${n.id}>${cible.id}:${r.type}`;
        if (vues.has(id)) continue;
        vues.add(id);
        aretes.push({ id, type: "relation", de: n.id, vers: cible.id, oriente: true, sous_type: r.type, note: r.note || null, source: "set_project_meta" });
      }
    }
  }

  const clustering = dernierClustering();
  const groupes = [];
  if (clustering) {
    if (liens.includes("proximite")) {
      for (const e of clustering.graphe.edges || []) {
        if (typeof e.score !== "number" || e.score < seuil) continue;
        const a = trouver(e.a), b = trouver(e.b);
        if (!a || !b || a === b) continue;
        const [de, vers] = paire(a.id, b.id);
        const id = `proximite:${de}~${vers}`;
        if (vues.has(id)) continue;
        vues.add(id);
        aretes.push({ id, type: "proximite", de, vers, oriente: false, poids: e.score, dependances_communes: (e.common_deps || []).slice(0, 8), source: `clustering:${clustering.date}` });
      }
    }
    (clustering.graphe.clusters || []).forEach((membres, i) => {
      const m = [...new Set((membres || []).map(trouver).filter(Boolean).map(x => x.id))];
      if (m.length > 1) groupes.push({ id: `clustering-${i + 1}`, type: "clustering", membres: m });
    });
  }

  // Connecteurs communs : fixés, plus ceux présents dans plus de la moitié des
  // nœuds qui en déclarent (quand il y en a assez pour que ce soit parlant).
  const avecConnecteurs = noeuds.filter(n => n.connecteurs?.length);
  const frequence = new Map();
  for (const n of avecConnecteurs) for (const c of n.connecteurs) frequence.set(c.toLowerCase(), (frequence.get(c.toLowerCase()) || 0) + 1);
  const communs = new Set(connecteursCommunsFixes());
  if (avecConnecteurs.length > 4) {
    for (const [c, f] of frequence) if (f > avecConnecteurs.length / 2) communs.add(c);
  }
  if (liens.includes("meme_connecteur")) {
    const parConnecteur = new Map();
    for (const n of avecConnecteurs) {
      for (const c of n.connecteurs) {
        if (communs.has(c.toLowerCase())) continue;
        if (!parConnecteur.has(c)) parConnecteur.set(c, []);
        parConnecteur.get(c).push(n.id);
      }
    }
    const parPaire = new Map();
    for (const [c, membres] of parConnecteur) {
      for (let i = 0; i < membres.length; i++) for (let j = i + 1; j < membres.length; j++) {
        const [de, vers] = paire(membres[i], membres[j]);
        const k = `${de}~${vers}`;
        if (!parPaire.has(k)) parPaire.set(k, { de, vers, connecteurs: [] });
        parPaire.get(k).connecteurs.push(c);
      }
    }
    for (const [k, v] of parPaire) {
      aretes.push({ id: `meme_connecteur:${k}`, type: "meme_connecteur", de: v.de, vers: v.vers, oriente: false, connecteurs: v.connecteurs.sort(), source: ".mcp.json" });
    }
  }

  return {
    version: VERSION_CARTOGRAPHIE,
    calcule_le: new Date().toISOString(),
    sources: {
      registre: registre.lastScan || null,
      clustering: clustering?.date || null,
      audits: audits.calcule_le || null,
      racine_projets_atelier: racineAtelier,
    },
    noeuds,
    aretes,
    groupes,
    limites: {
      absents_exclus: absentsExclus,
      relations_sans_cible: relationsSansCible,
      connecteurs_communs: [...communs].sort(),
    },
  };
}
