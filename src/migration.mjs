/**
 * migration.mjs — Reprise des données laissées sous le dossier de lancement
 * (lot W2).
 *
 * Avant W2, une partie des données vivait sous `process.cwd()` :
 *
 *   <cwd>/.wikichat/memories.json   mémoire des agents (remember/recall)
 *   <cwd>/.wikichat/messages.json   derniers messages
 *   <cwd>/.wikichat/channels.json   canaux
 *   <cwd>/.wikichat/fils.json       fils de discussion
 *   <cwd>/.wikichat/roles/          surcharges de rôles
 *   <cwd>/sessions/                 instantanés de session
 *   <cwd>/projects/                 projets déclarés sans dépôt
 *   <cwd>/agents/                   dossiers d'agents
 *   <cwd>/spawn_registry.json       registre des lancements
 *   <cwd>/crons.json                crons déclarés
 *
 * Elles vont toutes sous `~/.wikichat/` (chemins.mjs). La migration :
 *
 *   - **copie**, ne déplace pas : la source reste intacte, ce qui rend le
 *     retour arrière immédiat (ancienne version du code, mêmes fichiers) ;
 *   - **fusionne** quand la destination existe déjà : mémoires clé par clé
 *     (la plus récente gagne), messages, canaux, fils et lancements par
 *     identifiant ; fichiers d'un dossier : le plus récent reste en place,
 *     l'autre est rangé sous `~/.wikichat/migration-w2/conflits/` ;
 *   - est **idempotente** : un témoin (`~/.wikichat/migration-w2.json`) note
 *     chaque source reprise ; une source déjà reprise ne l'est plus, sinon une
 *     clé oubliée (`forget`) depuis reviendrait au redémarrage suivant ;
 *   - ne fait rien quand la source et la destination sont le même fichier
 *     (service lancé depuis le dossier personnel).
 *
 * `retourArriere()` fait le chemin inverse pour une version antérieure à W2.
 */

import fs from "fs";
import path from "path";
import { CHEMINS, WIKICHAT_HOME } from "./chemins.mjs";

export const TEMOIN = path.join(WIKICHAT_HOME, "migration-w2.json");
const CONFLITS = path.join(WIKICHAT_HOME, "migration-w2", "conflits");
const MAX_MESSAGES = 2000;

/** Éléments repris : chemin relatif à la source → destination, et façon de fusionner. */
export function elementsMigres(source) {
  return [
    { nom: "memories.json", de: path.join(source, ".wikichat", "memories.json"), vers: CHEMINS.memoires, fusion: fusionnerMemoires },
    { nom: "messages.json", de: path.join(source, ".wikichat", "messages.json"), vers: CHEMINS.messages, fusion: fusionnerMessages },
    { nom: "channels.json", de: path.join(source, ".wikichat", "channels.json"), vers: CHEMINS.canaux, fusion: fusionnerParCle("name") },
    { nom: "fils.json", de: path.join(source, ".wikichat", "fils.json"), vers: CHEMINS.fils, fusion: fusionnerFils },
    { nom: "spawn_registry.json", de: path.join(source, "spawn_registry.json"), vers: CHEMINS.registreLancements, fusion: fusionnerLancements(source) },
    { nom: "crons.json", de: path.join(source, "crons.json"), vers: CHEMINS.crons, fusion: fusionnerParCle("id") },
    { nom: "roles/", de: path.join(source, ".wikichat", "roles"), vers: CHEMINS.roles, dossier: true },
    { nom: "sessions/", de: path.join(source, "sessions"), vers: CHEMINS.sessions, dossier: true },
    { nom: "projects/", de: path.join(source, "projects"), vers: CHEMINS.projets, dossier: true },
    { nom: "agents/", de: path.join(source, "agents"), vers: CHEMINS.agents, dossier: true },
  ];
}

// ── Outils ───────────────────────────────────────────────────────────────────

function reel(p) { try { return fs.realpathSync(p); } catch { return path.resolve(p); } }
function memeChemin(a, b) { return reel(a).toLowerCase() === reel(b).toLowerCase(); }
function lireJson(p, defaut) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return defaut; } }
function ecrireJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}
function copierAvecDate(de, vers) {
  fs.mkdirSync(path.dirname(vers), { recursive: true });
  fs.copyFileSync(de, vers);
  try { const st = fs.statSync(de); fs.utimesSync(vers, st.atime, st.mtime); } catch { /* */ }
}
function ts(x) { const t = new Date(x || 0).getTime(); return Number.isFinite(t) ? t : 0; }

// ── Fusions ──────────────────────────────────────────────────────────────────

/** { agent: { clé: { value, updatedAt } } } — clé par clé, la plus récente gagne. */
export function fusionnerMemoires(dest, src) {
  const out = { ...(dest || {}) };
  for (const [agent, cles] of Object.entries(src || {})) {
    const d = { ...(out[agent] || {}) };
    for (const [k, v] of Object.entries(cles || {})) {
      if (!(k in d) || ts(v?.updatedAt) > ts(d[k]?.updatedAt)) d[k] = v;
    }
    out[agent] = d;
  }
  return out;
}

/** Tableau de messages : union par id, ordre chronologique, 2000 au plus. */
export function fusionnerMessages(dest, src) {
  const parId = new Map();
  for (const m of [...(Array.isArray(dest) ? dest : []), ...(Array.isArray(src) ? src : [])]) {
    if (m && m.id && !parId.has(m.id)) parId.set(m.id, m);
  }
  return [...parId.values()].sort((a, b) => ts(a.timestamp) - ts(b.timestamp)).slice(-MAX_MESSAGES);
}

/** Tableau d'objets : union par clé, la destination l'emporte. */
export function fusionnerParCle(cle) {
  return (dest, src) => {
    const vus = new Set();
    const out = [];
    for (const x of [...(Array.isArray(dest) ? dest : []), ...(Array.isArray(src) ? src : [])]) {
      const k = x && typeof x === "object" ? x[cle] : undefined;
      if (k === undefined) { out.push(x); continue; }
      if (vus.has(k)) continue;
      vus.add(k);
      out.push(x);
    }
    return out;
  };
}

/** { fils: [...] } : union par id, le fil qui a le plus de messages gagne. */
export function fusionnerFils(dest, src) {
  const parId = new Map();
  for (const f of [...(dest?.fils || []), ...(src?.fils || [])]) {
    if (!f?.id) continue;
    const deja = parId.get(f.id);
    if (!deja || (f.messages?.length || 0) > (deja.messages?.length || 0)) parId.set(f.id, f);
  }
  return { fils: [...parId.values()] };
}

/**
 * Registre des lancements : union par nom, l'entrée la plus récente gagne ;
 * les `storage_path` qui pointaient dans `<source>/agents/` suivent le dossier.
 */
export function fusionnerLancements(source) {
  const ancien = path.join(source, "agents");
  const recaler = (e) => {
    if (!e?.storage_path) return e;
    const rel = path.relative(ancien, e.storage_path);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return e;
    return { ...e, storage_path: path.join(CHEMINS.agents, rel) };
  };
  const date = (e) => Math.max(ts(e?.spawned_at), ts(e?.registered_at), ts(e?.ended_at));
  return (dest, src) => {
    const parNom = new Map();
    for (const e of [...(Array.isArray(dest) ? dest : []), ...(Array.isArray(src) ? src : []).map(recaler)]) {
      if (!e?.name) continue;
      const deja = parNom.get(e.name);
      if (!deja || date(e) > date(deja)) parNom.set(e.name, e);
    }
    return [...parNom.values()];
  };
}

/** Copie un dossier fichier par fichier ; en cas d'écart, le plus récent reste en place. */
function copierDossier(de, vers, rapport, relBase = "") {
  let n = 0;
  for (const e of fs.readdirSync(de, { withFileTypes: true })) {
    const s = path.join(de, e.name);
    const d = path.join(vers, e.name);
    const rel = path.join(relBase, e.name);
    if (e.isDirectory()) { n += copierDossier(s, d, rapport, rel); continue; }
    if (!e.isFile()) continue;
    if (!fs.existsSync(d)) { copierAvecDate(s, d); n++; continue; }
    const a = fs.readFileSync(s), b = fs.readFileSync(d);
    if (a.equals(b)) continue;
    const sourcePlusRecente = fs.statSync(s).mtimeMs > fs.statSync(d).mtimeMs;
    const mise = path.join(CONFLITS, rel);
    if (sourcePlusRecente) { copierAvecDate(d, mise); copierAvecDate(s, d); }
    else copierAvecDate(s, mise);
    rapport.conflits.push(rel);
    n++;
  }
  return n;
}

// ── Migration ────────────────────────────────────────────────────────────────

/**
 * Reprend les données d'un (ou plusieurs) dossiers de lancement.
 * @param {{ sources?: string[], log?: Function }} o
 * @returns {{ reprises: object[], ignorees: string[] }}
 */
export function migrerDonnees({ sources = [process.cwd()], log = console.log } = {}) {
  const temoin = lireJson(TEMOIN, { sources: {} });
  temoin.sources = temoin.sources || {};
  const reprises = [];
  const ignorees = [];
  const vues = new Set();
  for (const brute of sources) {
    if (!brute) continue;
    const source = reel(brute);
    if (vues.has(source.toLowerCase())) continue;
    vues.add(source.toLowerCase());
    if (temoin.sources[source]) { ignorees.push(source); continue; }
    const rapport = { source, elements: [], conflits: [] };
    for (const el of elementsMigres(source)) {
      try {
        if (!fs.existsSync(el.de) || memeChemin(el.de, el.vers)) continue;
        if (el.dossier) {
          if (!fs.statSync(el.de).isDirectory()) continue;
          const n = copierDossier(el.de, el.vers, rapport, el.nom.replace(/\/$/, ""));
          if (n) rapport.elements.push(`${el.nom} (${n})`);
          continue;
        }
        const src = lireJson(el.de, undefined);
        if (src === undefined) { rapport.elements.push(`${el.nom} (illisible, laissé en place)`); continue; }
        const dest = lireJson(el.vers, undefined);
        const fusion = dest === undefined ? el.fusion(Array.isArray(src) ? [] : (el.nom === "fils.json" ? { fils: [] } : {}), src) : el.fusion(dest, src);
        ecrireJson(el.vers, fusion);
        rapport.elements.push(el.nom);
      } catch (err) {
        rapport.elements.push(`${el.nom} (erreur : ${err.message})`);
      }
    }
    temoin.sources[source] = { le: new Date().toISOString(), elements: rapport.elements, conflits: rapport.conflits.length };
    reprises.push(rapport);
    if (rapport.elements.length) {
      log(`[migration W2] données reprises de ${source} vers ${WIKICHAT_HOME} : ${rapport.elements.join(", ")}` +
        (rapport.conflits.length ? ` — ${rapport.conflits.length} écart(s) gardé(s) sous ${CONFLITS}` : ""));
    }
  }
  if (reprises.length) {
    try { ecrireJson(TEMOIN, temoin); } catch { /* le témoin manque : la fusion, idempotente sur les données, sera refaite */ }
  }
  return { reprises, ignorees };
}

/**
 * Retour arrière : recopie les données de `~/.wikichat/` vers `<source>`, pour
 * une version de wikichat antérieure à W2. Ce qui est remplacé dans la source
 * est d'abord gardé dans `<source>/.avant-retour-w2/`.
 */
export function retourArriere({ source, log = console.log } = {}) {
  if (!source) throw new Error("source requise");
  const garde = path.join(source, ".avant-retour-w2");
  const faits = [];
  for (const el of elementsMigres(source)) {
    if (!fs.existsSync(el.vers) || memeChemin(el.de, el.vers)) continue;
    if (el.dossier) {
      const copier = (de, vers, rel) => {
        for (const e of fs.readdirSync(de, { withFileTypes: true })) {
          const s = path.join(de, e.name), d = path.join(vers, e.name), r = path.join(rel, e.name);
          if (e.isDirectory()) { copier(s, d, r); continue; }
          if (!e.isFile()) continue;
          if (fs.existsSync(d)) copierAvecDate(d, path.join(garde, r));
          copierAvecDate(s, d);
        }
      };
      copier(el.vers, el.de, el.nom.replace(/\/$/, ""));
    } else {
      if (fs.existsSync(el.de)) copierAvecDate(el.de, path.join(garde, el.nom));
      copierAvecDate(el.vers, el.de);
    }
    faits.push(el.nom);
  }
  log(`[migration W2] retour arrière vers ${source} : ${faits.join(", ") || "rien"}`);
  return faits;
}
