/**
 * memoire.test.mjs — La capitalisation des conversations (W8) et la mémoire de la personne (A-7).
 *
 * Deux parties :
 *   1. dans le processus, HOME jetable posé AVANT tout import : extraction sur
 *      un transcript fixe (celui que rend l'Atelier), fiches et index, même
 *      recherche que la connaissance, faits d'office et oubli, routine de nuit
 *      plafonnée (compte, budget, une fois par jour, refus de l'Atelier),
 *      propositions vers « À valider », passage des faits ;
 *   2. contre un serveur isolé : routes /api/memoire/* (écriture avec la clé
 *      seulement), search_knowledge en profil code borné à son projet,
 *      triggers de la mémoire, export assaini qui inclut les fiches et bloque
 *      un secret.
 *
 * Usage : node --test --test-concurrency=1 src/memoire.test.mjs
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

const DEPOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), "wikichat-memoire-"));
const MAISON = path.join(RACINE, "maison");
const PROJETS = path.join(RACINE, "projects");
for (const d of [MAISON, PROJETS]) fs.mkdirSync(d, { recursive: true });
process.env.HOME = MAISON;
process.env.USERPROFILE = MAISON;
process.env.WIKICHAT_ATELIER_PROJETS = PROJETS;
process.env.WIKICHAT_NO_OVERLAY_INSTALL = "1";
const CLE = "cle-du-lanceur-de-test-0123456789";
const FICHIER_CLE = path.join(RACINE, "atelier_lanceur_key");
fs.writeFileSync(FICHIER_CLE, CLE + "\n");
process.env.WIKICHAT_ATELIER_LANCEUR_CLE_FICHIER = FICHIER_CLE;

const W = path.join(MAISON, ".wikichat");
const attendre = (ms) => new Promise(r => setTimeout(r, ms));

// ── Un transcript fixe, tel que le rend l'Atelier (déjà filtré) ──────────────

function transcriptFixe({ id = "11111111-aaaa-bbbb-cccc-000000000001", projet = "alpha", empreinte = "e1", personnes = 4, jour = "2026-09-25" } = {}) {
  const evs = [];
  const base = Date.parse(`${jour}T14:00:00Z`);
  const t = (m) => new Date(base + m * 60_000).toISOString().replace(".000Z", "Z");
  evs.push({ quand: t(0), surface: "sdk-cli", role: "personne", texte: "Crée le projet marchés publics avec data.gouv, et note la décision de passer par l'API tabulaire." });
  evs.push({ quand: t(1), role: "modele", texte: "Je crée le projet." });
  evs.push({ quand: t(1), role: "outil", outil: "mcp__atelier__atelier_projet_creer", outil_id: "t1", entree: { titre: "Marchés publics", slug: "marches-publics" } });
  evs.push({ quand: t(1), role: "resultat", outil_id: "t1" });
  evs.push({ quand: t(2), role: "outil", outil: "mcp__atelier__atelier_artefact_creer", outil_id: "t2", entree: { nom: "tableau-bord" } });
  evs.push({ quand: t(2), role: "resultat", outil_id: "t2", erreur: true, texte: "échec : nom pris" });
  evs.push({ quand: t(3), role: "outil", outil: "Write", outil_id: "t3", entree: { file_path: "docs/decisions/0001-api-tabulaire.md" } });
  evs.push({ quand: t(3), role: "resultat", outil_id: "t3" });
  evs.push({ quand: t(4), role: "outil", outil: "Edit", outil_id: "t4", entree: { file_path: "src/lecteur.py" } });
  evs.push({ quand: t(4), role: "resultat", outil_id: "t4" });
  evs.push({ quand: t(5), role: "outil", outil: "Bash", outil_id: "t5", entree: { command: "git add -A && git commit -m 'Ouvrir le projet marchés publics'" } });
  evs.push({ quand: t(5), role: "resultat", outil_id: "t5" });
  evs.push({ quand: t(6), role: "outil", outil: "Task", outil_id: "t6", entree: { subagent_type: "Explore", description: "lire l'API" } });
  evs.push({ quand: t(6), role: "resultat", outil_id: "t6" });
  evs.push({ quand: t(7), role: "outil", outil: "mcp__wikichat__add_project_note", outil_id: "t7", entree: { type: "decision", content: "Passer par l'API tabulaire de data.gouv" } });
  evs.push({ quand: t(7), role: "resultat", outil_id: "t7" });
  evs.push({ quand: t(8), role: "modele", texte: "Projet créé, décision notée." });
  evs.push({ quand: t(8), role: "fin", erreur: false, jetons: { entree: 25000, sortie: 400 } });
  for (let i = 1; i < personnes; i++) {
    evs.push({ quand: t(10 + i), role: "personne", texte: `Question de suivi numéro ${i} sur le widget de carte` });
    evs.push({ quand: t(10 + i), role: "modele", texte: `Réponse ${i}` });
  }
  return {
    conversation: { id, cli_id: id, projet, genre: "code", titre: "Marchés publics", etat: "idle", lance_par: "", empreinte, cree_le: t(0), modifie_le: t(20) },
    evenements: evs, nombre: evs.length, tronque: false,
  };
}

/** Un vecteur factice : les mots de la carte (cart…, leaflet, map) portent le même sens. */
function vecteurFactice(texte) {
  const v = new Array(8).fill(0);
  const mots = String(texte).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const mot of mots) {
    if (/cart|leaflet|map/.test(mot)) { v[0] += 10; continue; }
    let h = 0;
    for (const ch of mot) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[1 + (h % 7)] += 1;
  }
  return v;
}

const SORTIE_DU_MODELE = JSON.stringify({
  resume: ["On a créé le projet marchés publics.", "Décision : API tabulaire."],
  sujets: ["marchés publics", "data.gouv"], decisions: ["API tabulaire"], questions: ["Quel widget ?"],
  candidats: [{ type: "preference", texte: "Préfère les API aux exports CSV" }, { type: "profil", texte: "Travaille sur les données publiques" },
    { type: "interpretation", texte: "Aime les décisions écrites" }, { type: "preference", texte: "de trop" }, { type: "secret", texte: "ignoré" }],
});

/** Un transcript court, sur une phrase choisie (vecteurs, rappel). */
function ficheSimple(id, projet, titre, phrase) {
  const t = transcriptFixe({ id, projet, empreinte: `${id}-1`, personnes: 1 });
  t.conversation.titre = titre;
  t.evenements = [0, 1, 2].flatMap(i => [
    { quand: `2026-09-25T1${i}:00:00Z`, role: "personne", texte: `${phrase} (${i})` },
    { quand: `2026-09-25T1${i}:01:00Z`, role: "modele", texte: "Noté." },
    { quand: `2026-09-25T1${i}:02:00Z`, role: "outil", outil: "Bash", outil_id: `b${i}`, entree: { command: "ls" } },
    { quand: `2026-09-25T1${i}:02:00Z`, role: "resultat", outil_id: `b${i}`, erreur: true, texte: "échec : nom pris" },
  ]);
  return t;
}

/** Un faux Atelier, en mémoire, au contrat de `memoire/atelier.mjs`. */
function fauxAtelier(conversations) {
  const appels = { lister: 0, transcript: [], proposer: [], resumer: [], vecteurs: [] };
  const connue = (id) => conversations.find(x => x.conversation?.id === id || x.conversation?.cli_id === id);
  const faux = {
    appels,
    vecteursEchouent: false,
    reponseResume: () => ({
      statut: 200,
      json: { statut: "fait", texte: SORTIE_DU_MODELE, modele: "qwen3-8-27b", jetons: { entree: 5000, sortie: 300, estimes: false }, arret: "end_turn", secondes: 12 },
    }),
    lister: async () => { appels.lister++; return { statut: 200, json: { conversations: conversations.map(c => c.conversation ? { ...c.conversation, au_repos: c.au_repos ?? true } : c) } }; },
    transcript: async (id) => {
      appels.transcript.push(id);
      const c = connue(id);
      return c ? { statut: 200, json: c } : { statut: 404, json: null };
    },
    proposer: async (p) => { appels.proposer.push(p); return { statut: 200, json: { statut: "fait" } }; },
    resumer: async (id) => {
      appels.resumer.push(id);
      return connue(id) ? faux.reponseResume(id) : { statut: 404, json: { detail: "conversation inconnue" } };
    },
    vecteurs: async (textes, usage = "fiche") => {
      appels.vecteurs.push({ textes, usage });
      if (faux.vecteursEchouent) return { statut: 502, json: { statut: "echec", erreur: "modèle indisponible" } };
      return { statut: 200, json: { statut: "fait", modele: "qwen3-embedding-8b", dimension: 8, vecteurs: textes.map(vecteurFactice), jetons: 10 } };
    },
  };
  return faux;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. Dans le processus
// ═════════════════════════════════════════════════════════════════════════════

test("extraction par le code sur un transcript fixe : faits datés, objets, citations", async () => {
  const { extraireFaits, faitsDOffice, objetsDe } = await import("./memoire/extraction.mjs");
  const f = extraireFaits(transcriptFixe());
  assert.equal(f.projet, "alpha");
  assert.equal(f.messages, 4);
  assert.equal(f.debut, "2026-09-25T14:00:00Z");
  assert.deepEqual(f.surfaces, ["sdk-cli"]);
  const textes = f.faits.map(x => x.texte);
  assert.ok(textes.includes("projet créé : Marchés publics"), textes.join(" | "));
  assert.ok(!textes.some(x => x.includes("tableau-bord")), "une création en échec n'est pas un fait");
  assert.ok(textes.includes("décision écrite : docs/decisions/0001-api-tabulaire.md"));
  assert.ok(textes.some(x => x.startsWith("décision : Passer par l'API tabulaire")));
  assert.ok(textes.some(x => x.startsWith("agent lancé : Explore")));
  assert.deepEqual(f.fichiers, ["docs/decisions/0001-api-tabulaire.md", "src/lecteur.py"]);
  assert.deepEqual(f.commits, ["Ouvrir le projet marchés publics"]);
  assert.equal(f.erreurs, 1);
  assert.deepEqual(f.erreurs_par_outil, { atelier_artefact_creer: 1 });
  assert.deepEqual(f.jetons, { entree: 25000, sortie: 400 });
  assert.equal(f.citations.length, 3);
  assert.ok(f.citations[0].startsWith("Crée le projet marchés publics"));
  assert.ok(objetsDe(f).includes("Marchés publics"));
  const office = faitsDOffice(f).map(x => x.texte);
  assert.ok(office.includes("25/09 : projet créé : Marchés publics (projet alpha)"), office.join(" | "));
  assert.ok(!office.some(x => x.includes("src/lecteur.py")), "ni fichiers ni commits dans la mémoire de la personne");
});

test("rangement : fiche, index, même recherche que la connaissance, profil code borné à son projet", async () => {
  const { extraireFaits } = await import("./memoire/extraction.mjs");
  const { rangerFaits, entreeDeLIndex } = await import("./memoire/fiches.mjs");
  const k = await import("./connaissance.mjs");
  rangerFaits(extraireFaits(transcriptFixe()));
  rangerFaits(extraireFaits(transcriptFixe({ id: "22222222-aaaa-bbbb-cccc-000000000002", projet: "beta", empreinte: "b1" })));
  const chemin = path.join(W, "knowledge", "conversations", "alpha", "11111111-aaaa-bbbb-cccc-000000000001.md");
  assert.ok(fs.existsSync(chemin));
  const texte = fs.readFileSync(chemin, "utf8");
  assert.match(texte, /^# Marchés publics$/m);
  assert.match(texte, /Résumé : à venir/);
  assert.match(texte, /projet créé : Marchés publics/);
  assert.equal(entreeDeLIndex("11111111-aaaa-bbbb-cccc-000000000001").statut, "faits");
  // search_knowledge (chercher) trouve la fiche ; en profil code, seulement celles de son projet.
  const tout = k.chercher("marchés publics tabulaire", { portee: "all" });
  assert.ok(tout.resultats.some(r => r.sujet === "conversation:11111111-aaaa-bbbb-cccc-000000000001"));
  assert.ok(tout.resultats.some(r => r.sujet === "conversation:22222222-aaaa-bbbb-cccc-000000000002"));
  const code = k.chercher("marchés publics tabulaire", { portee: "all", projet: "alpha" });
  assert.ok(code.resultats.length >= 1);
  assert.ok(code.resultats.every(r => !r.sujet.includes("22222222")), "une fiche d'un autre projet ne sort pas");
  assert.ok(k.chercher("marchés", { portee: "central" }).resultats.every(r => !r.sujet.startsWith("conversation:")), "les fiches ne sont pas centrales");
  // Rappel : sans accents, borné, identifiant court.
  const r = k.chercherConversations("MARCHES decision tabulaire", { projet: "alpha" });
  assert.equal(r.resultats.length, 1);
  assert.equal(r.resultats[0].projet, "alpha");
  assert.equal(k.lireFicheConversation("11111111")?.id, "11111111-aaaa-bbbb-cccc-000000000001");
  assert.equal(k.lireFicheConversation("22222222", { projet: "alpha" }), null);
  assert.equal(k.lireFiche("conversation:22222222-aaaa-bbbb-cccc-000000000002", { projet: "beta" })?.projet, "beta");
});

test("faits d'office dans la mémoire de la personne ; un fait oublié n'est plus réenregistré", async () => {
  const p = await import("./memoire/personne.mjs");
  const { capitaliserFaits } = await import("./memoire/capitalisation.mjs");
  const conv = transcriptFixe({ id: "33333333-aaaa-bbbb-cccc-000000000003", projet: "gamma", empreinte: "g1" });
  const atelier = fauxAtelier([conv]);
  const b = await capitaliserFaits({ atelier });
  assert.equal(b.fichees, 1);
  assert.ok(b.faits_d_office >= 3, JSON.stringify(b));
  let faits = p.lirePersonne().elements.filter(e => e.type === "fait" && e.source.projet === "gamma");
  const cree = faits.find(e => e.texte.includes("projet créé : Marchés publics"));
  assert.ok(cree && cree.par === "code");
  p.oublier(cree.id);
  // La conversation grandit : nouvelle empreinte, nouvelle extraction ; le fait oublié ne revient pas.
  conv.conversation.empreinte = "g2";
  const b2 = await capitaliserFaits({ atelier });
  assert.equal(b2.fichees, 1);
  faits = p.lirePersonne().elements.filter(e => e.type === "fait" && e.source.projet === "gamma");
  assert.ok(!faits.some(e => e.texte.includes("projet créé : Marchés publics")));
  // Inchangée : pas relue.
  const avant = atelier.appels.transcript.length;
  const b3 = await capitaliserFaits({ atelier });
  assert.equal(b3.inchangees, 1);
  assert.equal(atelier.appels.transcript.length, avant);
});

test("passage des faits : seulement les conversations au repos, borné, et la fin signalée passe outre le repos", async () => {
  const { capitaliserFaits } = await import("./memoire/capitalisation.mjs");
  const convs = [];
  for (let i = 0; i < 5; i++) convs.push({ ...transcriptFixe({ id: `4444444${i}-aaaa-bbbb-cccc-00000000000${i}`, projet: "delta", empreinte: `d${i}` }), au_repos: i !== 0 });
  const atelier = fauxAtelier(convs);
  const b = await capitaliserFaits({ atelier, limite: 2 });
  assert.equal(b.en_cours, 1, "une conversation active n'est pas fichée");
  assert.equal(b.fichees, 2);
  assert.equal(b.reste, 2, "le reste attend le passage suivant");
  const fin = await capitaliserFaits({ atelier, ids: ["44444440-aaaa-bbbb-cccc-000000000000"] });
  assert.equal(fin.fichees, 1, "la fin signalée (SessionEnd) fiche sans attendre le repos");
  const absent = await capitaliserFaits({ atelier: { lister: async () => ({ absent: true, raison: "clé" }) } });
  assert.equal(absent.atelier, "absent");
});

test("mémoire de la personne : doublons, plafonds, correction gardée en historique", async () => {
  const p = await import("./memoire/personne.mjs");
  const a = p.retenir({ type: "preference", texte: "Pas de notification la nuit" });
  const b = p.retenir({ type: "preference", texte: "  pas de   notification la nuit " });
  assert.equal(b.cree, false);
  assert.equal(b.element.id, a.element.id);
  const c = p.corriger(a.element.id, "Pas de notification entre 22 h et 7 h");
  assert.equal(c.avant, "Pas de notification la nuit");
  assert.equal(p.lirePersonne().elements.find(e => e.id === a.element.id).historique.length, 1);
  assert.throws(() => { for (let i = 0; i < 10; i++) p.retenir({ type: "preference", texte: `${"x".repeat(250)} ${i}` }); }, /plafond atteint/);
  assert.throws(() => p.retenir({ type: "inconnu", texte: "abc" }), /type/);
  const s = p.retenir({ type: "profil", texte: "Son jeton ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ne doit pas rester" });
  assert.ok(!s.element.texte.includes("ghp_"), "un motif de jeton est masqué");
  assert.match(p.rendrePartie("preference"), /Pas de notification entre 22 h et 7 h/);
});

test("routine de nuit plafonnée : 20 résumés directs par l'Atelier, par identifiant, jetons réels, une nuit par jour", async () => {
  const { extraireFaits } = await import("./memoire/extraction.mjs");
  const { rangerFaits, entreeDeLIndex } = await import("./memoire/fiches.mjs");
  const nuit = await import("./memoire/nuit.mjs");
  const convs = [];
  for (let i = 0; i < 25; i++) {
    const id = `55555555-aaaa-bbbb-cccc-${String(i).padStart(12, "0")}`;
    const c = transcriptFixe({ id, projet: "epsilon", empreinte: `n${i}`, personnes: 5, jour: "2026-09-26" });
    convs.push(c);
    rangerFaits(extraireFaits(c));
  }
  // Une conversation trop courte n'est pas candidate.
  rangerFaits(extraireFaits(transcriptFixe({ id: "56565656-aaaa-bbbb-cccc-000000000000", projet: "epsilon", empreinte: "court", personnes: 1 })));
  const atelier = fauxAtelier(convs);
  const b = await nuit.capitaliserNuit({ atelier, maintenant: () => new Date("2026-09-26T03:30:00Z") });
  assert.equal(b.candidats, 20, "les candidats sont plafonnés");
  assert.equal(atelier.appels.resumer.length, 20, "20 résumés au plus");
  assert.ok(atelier.appels.resumer.every(x => typeof x === "string" && /^55555555-/.test(x)), "un identifiant, jamais un texte");
  assert.equal(b.traitees, 20);
  assert.equal(b.reussies, 20);
  assert.equal(b.voie, "atelier:resumer");
  assert.equal(b.jetons_entree, 20 * 5000, "les jetons réels rendus par l'Atelier");
  assert.equal(b.jetons_sortie, 20 * 300);
  assert.equal(b.plus_grande_entree, 5000);
  assert.equal(b.surcout_harnais_estime, undefined, "plus de harnais");
  assert.equal(b.propositions, 60, "3 candidats par conversation au plus, vers « À valider »");
  assert.ok(atelier.appels.proposer.every(p => ["preference", "profil", "interpretation"].includes(p.type)));
  assert.equal(b.vecteurs.calcules, 20, "les fiches résumées ont leurs vecteurs");
  const { lireIndexConversations } = await import("./connaissance.mjs");
  const faites = lireIndexConversations().filter(e => e.projet === "epsilon" && e.statut === "sens");
  assert.equal(faites.length, 20, "le sens est rangé dans l'index");
  const sens = entreeDeLIndex(faites[0].id).sens;
  assert.equal(sens.modele, "qwen3-8-27b");
  assert.deepEqual(sens.jetons, { entree: 5000, sortie: 300 });
  const fiche = fs.readFileSync(path.join(W, "knowledge", "conversations", "epsilon", `${faites[0].id}.md`), "utf8");
  assert.match(fiche, /Résumé : On a créé le projet marchés publics\./);
  assert.match(fiche, /Questions ouvertes :\n- Quel widget \?/);
  assert.ok(!fiche.includes("Préfère les API"), "un candidat n'est pas écrit dans la fiche : il attend la personne");
  assert.equal(nuit.lireNuits().at(-1).traitees, 20);
  // Une seule nuit par jour ; les 5 restantes passent la nuit suivante.
  const encore = await nuit.capitaliserNuit({ atelier, maintenant: () => new Date("2026-09-26T05:00:00Z") });
  assert.equal(encore.deja, true);
  const suivante = await nuit.capitaliserNuit({ atelier, maintenant: () => new Date("2026-09-27T03:30:00Z") });
  assert.equal(suivante.traitees, 5);
});

test("routine de nuit : un refus ou un modèle indisponible arrête la nuit ; une conversation inconnue ou illisible est notée, pas retentée sans fin", async () => {
  const { extraireFaits } = await import("./memoire/extraction.mjs");
  const { rangerFaits, entreeDeLIndex } = await import("./memoire/fiches.mjs");
  const nuit = await import("./memoire/nuit.mjs");
  const convs = [0, 1, 2].map(i => transcriptFixe({ id: `66666666-aaaa-bbbb-cccc-00000000000${i}`, projet: "zeta", empreinte: `z${i}` }));
  for (const c of convs) rangerFaits(extraireFaits(c));
  const atelier = fauxAtelier(convs);
  // Les fiches des tests précédents, inconnues de ce faux Atelier, répondent 404.
  const zeta = () => atelier.appels.resumer.filter(x => x.startsWith("66666666")).length;
  for (const statut of [401, 409, 429]) {
    atelier.reponseResume = () => ({ statut, json: { statut: "refus", erreur: "plafond atteint : 20 résumés aujourd'hui" } });
    const r = await nuit.capitaliserNuit({ atelier, force: true });
    assert.match(r.arret, new RegExp(`refus de l'Atelier \\(HTTP ${statut}\\)`));
    assert.equal(r.traitees, 0, "un refus ne compte pas comme un résumé");
  }
  atelier.reponseResume = () => ({ statut: 502, json: { statut: "echec", erreur: "modèle indisponible" } });
  const indispo = await nuit.capitaliserNuit({ atelier, force: true });
  assert.match(indispo.arret, /modèle indisponible/);
  assert.equal(zeta(), 4, "la nuit s'arrête au premier refus ou échec du modèle");
  atelier.reponseResume = (id) => (id.endsWith("0") ? { statut: 404, json: { detail: "conversation inconnue" } } : { statut: 200, json: { statut: "fait", texte: "je ne sais pas", jetons: { entree: 10, sortie: 5 } } });
  const n0 = zeta();
  const r = await nuit.capitaliserNuit({ atelier, force: true });
  assert.equal(r.arret, null, "une conversation inconnue n'arrête pas la nuit");
  assert.equal(zeta() - n0, 3);
  assert.ok(r.echecs >= 3);
  await nuit.capitaliserNuit({ atelier, force: true });
  const avant = zeta();
  await nuit.capitaliserNuit({ atelier, force: true });
  assert.equal(zeta(), avant, "deux échecs : la fiche n'est plus retentée seule");
  assert.equal(entreeDeLIndex(convs[0].conversation.id).tentatives_nuit, 2);
});

test("essai de la nuit à la main : N conversations ou celles choisies, sans prendre la place de la nuit", async () => {
  const { extraireFaits } = await import("./memoire/extraction.mjs");
  const { rangerFaits } = await import("./memoire/fiches.mjs");
  const nuit = await import("./memoire/nuit.mjs");
  const convs = [0, 1, 2, 3, 4].map(i => transcriptFixe({ id: `67676767-aaaa-bbbb-cccc-00000000000${i}`, projet: "theta", empreinte: `t${i}`, jour: "2026-09-28" }));
  for (const c of convs) rangerFaits(extraireFaits(c));
  const atelier = fauxAtelier(convs);
  const jour = () => new Date("2026-09-28T10:00:00Z");
  const essai = await nuit.capitaliserNuit({ atelier, essai: true, limite: 3, maintenant: jour });
  assert.equal(essai.essai, true);
  assert.equal(essai.traitees, 3);
  assert.equal(essai.plafonds.limite, 3);
  const choisies = await nuit.capitaliserNuit({ atelier, essai: true, limite: 20, ids: [convs[4].conversation.id], maintenant: jour });
  assert.deepEqual(atelier.appels.resumer.slice(-1), [convs[4].conversation.id]);
  assert.equal(choisies.traitees, 1);
  assert.equal(nuit.candidatsDeNuit(undefined, undefined, { limite: 99 }).length <= 20, true, "une limite n'augmente jamais le plafond");
  const laNuit = await nuit.capitaliserNuit({ atelier, maintenant: () => new Date("2026-09-28T23:00:00Z") });
  assert.notEqual(laNuit.deja, true, "un essai ne compte pas pour la nuit du jour");
});

test("lecture de la sortie : JSON seul, bornes, motifs masqués", async () => {
  const { lireSortie } = await import("./memoire/nuit.mjs");
  assert.equal(lireSortie("pas de JSON"), null);
  assert.equal(lireSortie('{"resume": []}'), null);
  const s = lireSortie('Voici : {"resume": "ligne 1\\nligne 2\\nl3\\nl4\\nl5\\nl6", "sujets": ["a","b","c","d","e","f","g"], "candidats": [{"type":"profil","texte":"clé sk-abcdefghijklmnopqrstuvwx"}]} fin');
  assert.equal(s.resume.length, 5);
  assert.equal(s.sujets.length, 6);
  assert.ok(!s.candidats[0].texte.includes("sk-abcdef"));
});

test("vecteurs : calculés à l'écriture depuis le texte filtré de la fiche, recalculés quand elle change", async () => {
  const { extraireFaits } = await import("./memoire/extraction.mjs");
  const { rangerFaits } = await import("./memoire/fiches.mjs");
  const v = await import("./memoire/vecteurs.mjs");
  const a = ficheSimple("77777777-aaaa-bbbb-cccc-000000000001", "iota", "Réglages du serveur", "cartographie des quartiers avec leaflet");
  const b = ficheSimple("77777777-aaaa-bbbb-cccc-000000000002", "kappa", "Tableau des dépenses", "cartographie des dépenses publiques");
  for (const c of [a, b]) rangerFaits(extraireFaits(c));
  const atelier = fauxAtelier([a, b]);
  const r = await v.indexerVecteurs({ atelier, ids: [a.conversation.id, b.conversation.id] });
  assert.equal(r.calcules, 2);
  assert.equal(r.erreur, null);
  const envoyes = atelier.appels.vecteurs.flatMap(x => x.textes);
  assert.ok(envoyes.every(t => !t.includes("échec : nom pris")), "jamais un résultat d'outil : le texte de la fiche, pas le transcript");
  assert.ok(envoyes.every(t => !t.startsWith("---")), "sans l'en-tête de la fiche");
  assert.ok(atelier.appels.vecteurs.every(x => x.usage === "fiche"));
  const lus = v.lireVecteurs();
  assert.equal(lus.get(a.conversation.id).projet, "iota");
  assert.ok(Math.abs(lus.get(a.conversation.id).v.reduce((s, x) => s + x * x, 0) - 1) < 1e-4, "normalisé");
  assert.ok(fs.existsSync(path.join(W, "knowledge", "conversations", "vecteurs.jsonl")), "à côté de l'index");
  const encore = await v.indexerVecteurs({ atelier, ids: [a.conversation.id, b.conversation.id] });
  assert.equal(encore.calcules, 0);
  assert.equal(encore.a_jour, 2);
  a.evenements.push({ quand: "2026-09-25T15:00:00Z", role: "personne", texte: "encore une chose" });
  a.conversation.empreinte = "change";
  rangerFaits(extraireFaits(a));
  assert.equal((await v.indexerVecteurs({ atelier, ids: [a.conversation.id] })).calcules, 1, "une fiche qui change est recalculée");
  // Point d'accès absent : rien ne casse, la fiche reste sans vecteur à jour.
  atelier.vecteursEchouent = true;
  a.conversation.empreinte = "change-2";
  a.evenements.push({ quand: "2026-09-25T16:00:00Z", role: "personne", texte: "et une autre" });
  rangerFaits(extraireFaits(a));
  const echec = await v.indexerVecteurs({ atelier, ids: [a.conversation.id] });
  assert.equal(echec.calcules, 0);
  assert.match(echec.erreur, /502/);
});

test("rappel fusionné : le sens trouve sans mot commun, dans la portée ; lexical seul si le point d'accès manque", async () => {
  const k = await import("./connaissance.mjs");
  const v = await import("./memoire/vecteurs.mjs");
  const atelier = fauxAtelier([]);
  // « map » n'est dans aucune fiche : seul le sens rapproche.
  assert.equal(k.chercherConversations("map interactive", { projet: "iota" }).resultats.length, 0);
  const r = await v.rappelFusionne("map interactive", { projet: "iota", atelier, lexical: k.chercherConversations });
  assert.equal(r.sens, "fait");
  assert.deepEqual(r.resultats.map(x => x.id), ["77777777-aaaa-bbbb-cccc-000000000001"]);
  assert.ok(r.resultats[0].similarite > 0.35);
  assert.deepEqual(atelier.appels.vecteurs.at(-1), { textes: ["map interactive"], usage: "requete" });
  const tout = await v.rappelFusionne("map interactive", { atelier, lexical: k.chercherConversations, limite: 10 });
  assert.ok(tout.resultats.some(x => x.projet === "kappa"), "sans projet (l'Assistant), toutes les fiches");
  const code = await v.rappelFusionne("map interactive", { projet: "kappa", atelier, lexical: k.chercherConversations });
  assert.ok(code.resultats.every(x => x.projet === "kappa"), "profil code : son projet seulement");
  // Le point d'accès ne répond pas : lexical, sans erreur.
  atelier.vecteursEchouent = true;
  const repli = await v.rappelFusionne("cartographie quartiers", { projet: "iota", atelier, lexical: k.chercherConversations });
  assert.equal(repli.sens, "indisponible");
  assert.equal(repli.resultats[0]?.id, "77777777-aaaa-bbbb-cccc-000000000001", "la recherche lexicale répond seule");
  const absent = await v.rappelFusionne("cartographie", { projet: "iota", atelier: { vecteurs: async () => ({ absent: true, raison: "injoignable" }) }, lexical: k.chercherConversations });
  assert.equal(absent.sens, "indisponible");
  // search_knowledge : même fusion, même portée.
  atelier.vecteursEchouent = false;
  const lex = k.chercher("map interactive", { portee: "all", projet: "iota", limite: 20 });
  const sk = await v.completerParLeSens("map interactive", lex, { projet: "iota", atelier });
  assert.deepEqual(sk.resultats.map(x => x.sujet), ["conversation:77777777-aaaa-bbbb-cccc-000000000001"]);
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Serveur isolé
// ═════════════════════════════════════════════════════════════════════════════

const MAISON_S = path.join(RACINE, "maison-serveur");
const WS = path.join(MAISON_S, ".wikichat");
const PORT = 3700 + Math.floor(Math.random() * 90);
const URL_BASE = `http://127.0.0.1:${PORT}`;
let serveur = null;
const transports = [];

// Un faux Atelier pour le serveur isolé : seulement `POST /v1/memoire/vecteurs`
// (clé exigée) ; toute autre route coupe la connexion, comme un Atelier absent.
const fauxAtelierHttp = { echoue: false, appels: [] };
const atelierHttp = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/memoire/vecteurs") { req.socket.destroy(); return; }
  let brut = "";
  req.on("data", d => { brut += d; });
  req.on("end", () => {
    const corps = JSON.parse(brut || "{}");
    fauxAtelierHttp.appels.push({ ...corps, cle: req.headers["x-atelier-lanceur"] });
    const repondre = (statut, o) => { res.writeHead(statut, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.headers["x-atelier-lanceur"] !== CLE) return repondre(401, { detail: "clé du lanceur requise" });
    if (fauxAtelierHttp.echoue) return repondre(502, { statut: "echec", erreur: "modèle indisponible" });
    repondre(200, { statut: "fait", modele: "qwen3-embedding-8b", dimension: 8, vecteurs: corps.textes.map(vecteurFactice), jetons: 10 });
  });
});

function ecrire(p, contenu) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, contenu); }

function ficheBrute(id, projet, titre, corps) {
  return `---\nid: ${id}\ncli_id: ${id}\nprojet: ${projet}\ngenre: code\ndebut: 2026-09-20T10:00:00Z\nfin: 2026-09-20T11:00:00Z\nempreinte_source: x\nsens: a_venir\n---\n# ${titre}\n\nRésumé : ${corps}\n`;
}

before(async () => {
  await new Promise(r => atelierHttp.listen(0, "127.0.0.1", r));
  const conv = path.join(WS, "knowledge", "conversations");
  ecrire(path.join(conv, "alpha", "aaaaaaaa-0001.md"), ficheBrute("aaaaaaaa-0001", "alpha", "Widget de carte Leaflet", "choix de Leaflet pour la carte"));
  ecrire(path.join(conv, "beta", "bbbbbbbb-0002.md"), ficheBrute("bbbbbbbb-0002", "beta", "Widget de carte beta", "carte confidentielle de beta"));
  ecrire(path.join(conv, "index.jsonl"), [
    { id: "aaaaaaaa-0001", projet: "alpha", genre: "code", titre: "Widget de carte Leaflet", fin: "2026-09-20T11:00:00Z", resume: "choix de Leaflet pour la carte", statut: "faits" },
    { id: "bbbbbbbb-0002", projet: "beta", genre: "code", titre: "Widget de carte beta", fin: "2026-09-20T11:00:00Z", resume: "carte confidentielle de beta", statut: "faits" },
  ].map(x => JSON.stringify(x)).join("\n") + "\n");
  serveur = spawn(process.execPath, [path.join(DEPOT, "server.mjs")], {
    cwd: RACINE,
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", HOME: MAISON_S, USERPROFILE: MAISON_S,
      WIKICHAT_NO_OVERLAY_INSTALL: "1", WIKICHAT_ATELIER_PROJETS: PROJETS, WIKICHAT_AUTONOMOUS_TEAM: "",
      WIKICHAT_ATELIER_LANCEUR_CLE_FICHIER: FICHIER_CLE, WIKICHAT_ATELIER_URL: `http://127.0.0.1:${atelierHttp.address().port}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serveur.journal = "";
  serveur.stdout.on("data", d => { serveur.journal += d; });
  serveur.stderr.on("data", d => { serveur.journal += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${URL_BASE}/api/health`); if (r.ok) return; } catch { /* */ }
    await attendre(150);
  }
  throw new Error(`serveur isolé injoignable\n${serveur.journal}`);
});

after(async () => {
  for (const t of transports) await t.close().catch(() => {});
  if (serveur) { serveur.kill(); await attendre(300); }
  atelierHttp.close();
  try { fs.rmSync(RACINE, { recursive: true, force: true }); } catch { /* Windows : fichiers encore ouverts */ }
});

const json = async (chemin, init) => { const r = await fetch(`${URL_BASE}${chemin}`, init); return { statut: r.status, corps: await r.json().catch(() => null) }; };
const avecCle = (methode, corps) => ({ method: methode, headers: { "Content-Type": "application/json", "X-Atelier-Lanceur": CLE }, body: corps ? JSON.stringify(corps) : undefined });

test("serveur : rappel et fiche, bornés au projet demandé", async () => {
  const r = await json("/api/memoire/rappel?q=widget%20carte&limite=5");
  assert.equal(r.statut, 200);
  assert.equal(r.corps.resultats.length, 2);
  const a = await json("/api/memoire/rappel?q=widget%20carte&projet=alpha");
  assert.deepEqual(a.corps.resultats.map(x => x.projet), ["alpha"]);
  assert.equal((await json("/api/memoire/fiches/bbbbbbbb?projet=alpha")).statut, 404);
  const f = await json("/api/memoire/fiches/aaaaaaaa?projet=alpha");
  assert.equal(f.statut, 200);
  assert.equal(f.corps.projet, "alpha");
  assert.match(f.corps.texte, /Widget de carte Leaflet/);
});

test("serveur : la mémoire de la personne ne s'écrit qu'avec la clé", async () => {
  const sans = await json("/api/memoire/personne", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "preference", texte: "injectée" }) });
  assert.equal(sans.statut, 401);
  const mauvaise = await json("/api/memoire/personne", { method: "POST", headers: { "Content-Type": "application/json", "X-Atelier-Lanceur": "autre" }, body: JSON.stringify({ type: "preference", texte: "injectée" }) });
  assert.equal(mauvaise.statut, 401);
  const ok = await json("/api/memoire/personne", avecCle("POST", { type: "preference", texte: "Réponses courtes", source: { conversation: "c-1" } }));
  assert.equal(ok.statut, 201);
  const id = ok.corps.element.id;
  assert.equal((await json(`/api/memoire/personne/${id}`, { method: "DELETE" })).statut, 401);
  const corr = await json(`/api/memoire/personne/${id}`, avecCle("PATCH", { texte: "Réponses très courtes" }));
  assert.equal(corr.statut, 200);
  assert.equal(corr.corps.avant, "Réponses courtes");
  const lu = await json("/api/memoire/personne");
  assert.ok(lu.corps.elements.some(e => e.texte === "Réponses très courtes"));
  assert.equal(lu.corps.fiches, 2);
  assert.equal((await json(`/api/memoire/personne/${id}`, avecCle("DELETE"))).statut, 200);
  const md = await (await fetch(`${URL_BASE}/api/memoire/personne.md?partie=preference`)).text();
  assert.ok(!md.includes("Réponses très courtes"));
});

test("serveur : search_knowledge en profil code ne rend que les fiches de son projet", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
  const connecter = async (params) => {
    const t = new SSEClientTransport(new URL(`${URL_BASE}/sse?${params}`));
    const c = new Client({ name: "memoire-test", version: "1.0.0" });
    await c.connect(t);
    transports.push(t);
    return async (q) => (await c.callTool({ name: "search_knowledge", arguments: { query: q } })).content.map(x => x.text).join("\n");
  };
  const code = await connecter("agent=Agent-Alpha&profil=code&projet=alpha");
  const texteCode = await code("widget carte");
  assert.match(texteCode, /Widget de carte Leaflet/);
  assert.doesNotMatch(texteCode, /confidentielle/);
  const assistant = await connecter("agent=Assistant-Test&profil=assistant");
  const texteAssistant = await assistant("widget carte");
  assert.match(texteAssistant, /Widget de carte beta/);
});

test("serveur : les deux tâches de la mémoire existent, celle de nuit désactivée", async () => {
  let triggers = null;
  for (let i = 0; i < 30 && !triggers; i++) {
    try { triggers = JSON.parse(fs.readFileSync(path.join(WS, "triggers.json"), "utf8")); } catch { await attendre(200); }
  }
  const liste = Array.isArray(triggers) ? triggers : Object.values(triggers?.triggers || triggers || {});
  const faits = liste.find(t => t.id === "memoire-faits");
  const nuit = liste.find(t => t.id === "memoire-nuit");
  assert.ok(faits && faits.enabled === true && faits.action.params.job === "capitaliser_faits");
  assert.ok(nuit && nuit.enabled === false && nuit.action.params.job === "capitaliser_nuit", "la nuit consomme du modèle : la personne l'active");
  // Un passage des faits sans Atelier joignable ne casse rien.
  const r = await json("/api/memoire/capitaliser", avecCle("POST", {}));
  assert.equal(r.statut, 200);
  assert.equal(r.corps.atelier, "absent");
});

test("serveur : l'essai de la nuit à la main exige la clé ; sans Atelier, il s'arrête sans rien casser", async () => {
  const sans = await json("/api/memoire/nuit?limite=3", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(sans.statut, 401);
  const r = await json("/api/memoire/nuit?limite=3", avecCle("POST", {}));
  assert.equal(r.statut, 200);
  assert.equal(r.corps.essai, true);
  assert.equal(r.corps.plafonds.limite, 3);
  assert.equal((await json("/api/memoire/vecteurs", { method: "POST" })).statut, 401);
});

test("serveur : le sens complète search_knowledge et le rappel, dans la portée du profil ; lexical seul sans point d'accès", async () => {
  const v = await json("/api/memoire/vecteurs", avecCle("POST", {}));
  assert.equal(v.statut, 200);
  assert.equal(v.corps.calcules, 2, JSON.stringify(v.corps));
  assert.ok(fauxAtelierHttp.appels.every(x => x.cle === CLE && x.usage === "fiche"));
  assert.ok(fs.existsSync(path.join(WS, "knowledge", "conversations", "vecteurs.jsonl")));
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
  const connecter = async (params) => {
    const t = new SSEClientTransport(new URL(`${URL_BASE}/sse?${params}`));
    const c = new Client({ name: "memoire-sens", version: "1.0.0" });
    await c.connect(t);
    transports.push(t);
    return async (q) => (await c.callTool({ name: "search_knowledge", arguments: { query: q } })).content.map(x => x.text).join("\n");
  };
  // « mapping » n'est dans aucune fiche : seul le sens les rapproche.
  const code = await connecter("agent=Agent-Sens&profil=code&projet=alpha");
  const texteCode = await code("mapping interactif");
  assert.match(texteCode, /Widget de carte Leaflet/);
  assert.match(texteCode, /sens=/);
  assert.doesNotMatch(texteCode, /Widget de carte beta/, "profil code : jamais une fiche d'un autre projet, même par le sens");
  const assistant = await connecter("agent=Assistant-Sens&profil=assistant");
  const texteAssistant = await assistant("mapping interactif");
  assert.match(texteAssistant, /Widget de carte beta/);
  const rappel = await json("/api/memoire/rappel?q=mapping%20interactif&projet=alpha");
  assert.equal(rappel.corps.sens, "fait");
  assert.deepEqual(rappel.corps.resultats.map(x => x.projet), ["alpha"]);
  assert.ok(fauxAtelierHttp.appels.some(x => x.usage === "requete"));
  // Le point d'accès ne répond plus : la recherche reste lexicale, sans erreur.
  fauxAtelierHttp.echoue = true;
  const repli = await json("/api/memoire/rappel?q=widget%20carte&projet=alpha");
  assert.equal(repli.statut, 200);
  assert.equal(repli.corps.sens, "indisponible");
  assert.deepEqual(repli.corps.resultats.map(x => x.projet), ["alpha"]);
  assert.match(await code("widget carte"), /Widget de carte Leaflet/);
  assert.match(await code("mapping interactif"), /Aucun match/, "sans le sens, pas de rapprochement inventé");
  fauxAtelierHttp.echoue = false;
});

test("export assaini (S6) : les fiches sont publiées, un secret dans une fiche bloque l'export", async () => {
  const sortie = path.join(RACINE, "export");
  const env = { ...process.env, HOME: MAISON_S, USERPROFILE: MAISON_S };
  let r = spawnSync(process.execPath, [path.join(DEPOT, "scripts", "export-memory.mjs"), "--out", sortie], { env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(sortie, "conversations", "alpha", "aaaaaaaa-0001.md")));
  const index = JSON.parse(fs.readFileSync(path.join(sortie, "conversations-index.json"), "utf8"));
  assert.equal(index.conversations.length, 2);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sortie, "manifest.json"), "utf8")).counts.conversations, 2);
  assert.ok(!fs.existsSync(path.join(sortie, "memoire")), "la mémoire de la personne n'est pas publiée");
  ecrire(path.join(WS, "knowledge", "conversations", "alpha", "cccccccc-0003.md"), ficheBrute("cccccccc-0003", "alpha", "Fuite", "jeton ghp_" + "B".repeat(36)));
  r = spawnSync(process.execPath, [path.join(DEPOT, "scripts", "export-memory.mjs"), "--dry-run"], { env, encoding: "utf8" });
  assert.equal(r.status, 2, "un secret dans une fiche bloque l'export");
  assert.match(r.stderr, /fiche alpha\/cccccccc-0003\.md/);
  assert.doesNotMatch(r.stderr + r.stdout, /BBBBBBBBBBBB/, "le rapport ne recopie pas le secret");
});
