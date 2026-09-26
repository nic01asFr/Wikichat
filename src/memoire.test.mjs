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

/** Un faux Atelier, en mémoire, au contrat de `memoire/atelier.mjs`. */
function fauxAtelier(conversations) {
  const appels = { lister: 0, transcript: [], proposer: [] };
  return {
    appels,
    lister: async () => { appels.lister++; return { statut: 200, json: { conversations: conversations.map(c => c.conversation ? { ...c.conversation, au_repos: c.au_repos ?? true } : c) } }; },
    transcript: async (id) => {
      appels.transcript.push(id);
      const c = conversations.find(x => x.conversation?.id === id || x.conversation?.cli_id === id);
      return c ? { statut: 200, json: c } : { statut: 404, json: null };
    },
    proposer: async (p) => { appels.proposer.push(p); return { statut: 200, json: { statut: "fait" } }; },
  };
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

test("l'entrée de la nuit : paroles et réponses finales, jamais un résultat d'outil, sous plafond", async () => {
  const { preparerEntree } = await import("./memoire/extraction.mjs");
  const t = transcriptFixe({ personnes: 200 });
  const petite = preparerEntree(t.evenements, { maxCar: 100_000 });
  assert.equal(petite.omis, 0);
  assert.ok(!petite.texte.includes("échec : nom pris"), "un résultat d'outil n'entre pas");
  assert.match(petite.texte, /\[Réponse\] Projet créé, décision notée\./, "la réponse finale du tour, pas la première");
  const bornee = preparerEntree(t.evenements, { maxCar: 3000 });
  assert.ok(bornee.texte.length <= 3000);
  assert.ok(bornee.omis > 0);
  assert.match(bornee.texte, /Crée le projet marchés publics/, "le début reste");
  assert.match(bornee.texte, /numéro 199/, "la fin reste");
  assert.match(bornee.texte, /échange\(s\) omis au milieu/);
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

test("routine de nuit plafonnée : 20 conversations au plus, entrée sous 30 000 jetons, une nuit par jour", async () => {
  const { extraireFaits } = await import("./memoire/extraction.mjs");
  const { rangerFaits, entreeDeLIndex } = await import("./memoire/fiches.mjs");
  const nuit = await import("./memoire/nuit.mjs");
  const convs = [];
  for (let i = 0; i < 25; i++) {
    const id = `55555555-aaaa-bbbb-cccc-${String(i).padStart(12, "0")}`;
    const c = transcriptFixe({ id, projet: "epsilon", empreinte: `n${i}`, personnes: 400, jour: "2026-09-26" });
    // Des messages longs : sans plafond, l'entrée dépasserait largement 30 000 jetons.
    for (const e of c.evenements) if (e.role === "personne") e.texte += " " + "détail ".repeat(300);
    convs.push(c);
    rangerFaits(extraireFaits(c));
  }
  // Une conversation trop courte n'est pas candidate.
  rangerFaits(extraireFaits(transcriptFixe({ id: "56565656-aaaa-bbbb-cccc-000000000000", projet: "epsilon", empreinte: "court", personnes: 1 })));
  const atelier = fauxAtelier(convs);
  const lancements = [];
  const lancer = async (p) => {
    lancements.push(p);
    return {
      success: true, lancementId: `lc-${lancements.length}`,
      stdout: JSON.stringify({
        resume: ["On a créé le projet marchés publics.", "Décision : API tabulaire."],
        sujets: ["marchés publics", "data.gouv"], decisions: ["API tabulaire"], questions: ["Quel widget ?"],
        candidats: [{ type: "preference", texte: "Préfère les API aux exports CSV" }, { type: "profil", texte: "Travaille sur les données publiques" },
          { type: "interpretation", texte: "Aime les décisions écrites" }, { type: "preference", texte: "de trop" }, { type: "secret", texte: "ignoré" }],
      }),
    };
  };
  const b = await nuit.capitaliserNuit({ atelier, lancer, maintenant: () => new Date("2026-09-26T03:30:00Z") });
  assert.equal(b.candidats, 20, "les candidats sont plafonnés");
  assert.equal(lancements.length, 20, "20 lancements au plus");
  assert.equal(b.traitees, 20);
  assert.equal(b.reussies, 20);
  for (const l of lancements) {
    assert.ok(l.prompt.length <= nuit.MESSAGE_MAX, "le message tient dans ce que le lot D accepte");
    assert.ok(Math.ceil(l.prompt.length / 3.4) <= 30_000, "30 000 jetons au plus par conversation");
    assert.equal(l.model, "qwen3-8-27b");
    assert.equal(l.mode, "dontAsk");
    assert.deepEqual(l.allowedTools, [], "aucune autorisation d'outil demandée");
    assert.equal(l.spawnedBy, "memoire:nuit");
    assert.ok(!l.prompt.includes("échec : nom pris"), "jamais un résultat d'outil");
  }
  assert.ok(b.jetons_entree_estimes <= 20 * 30_000);
  assert.ok(b.plus_grande_entree <= 30_000);
  assert.equal(b.surcout_harnais_estime, 20 * nuit.HARNAIS_JETONS);
  assert.equal(b.propositions, 60, "3 candidats par conversation au plus, vers « À valider »");
  assert.ok(atelier.appels.proposer.every(p => ["preference", "profil", "interpretation"].includes(p.type)));
  const { lireIndexConversations } = await import("./connaissance.mjs");
  const faites = lireIndexConversations().filter(e => e.projet === "epsilon" && e.statut === "sens");
  assert.equal(faites.length, 20, "le sens est rangé dans l'index");
  assert.equal(entreeDeLIndex(faites[0].id).sens.modele, "qwen3-8-27b");
  const fiche = fs.readFileSync(path.join(W, "knowledge", "conversations", "epsilon", `${faites[0].id}.md`), "utf8");
  assert.match(fiche, /Résumé : On a créé le projet marchés publics\./);
  assert.match(fiche, /Questions ouvertes :\n- Quel widget \?/);
  assert.ok(!fiche.includes("Préfère les API"), "un candidat n'est pas écrit dans la fiche : il attend la personne");
  // Le budget est noté.
  const nuits = nuit.lireNuits();
  assert.equal(nuits.at(-1).traitees, 20);
  // Une seule nuit par jour ; les 5 restantes passent la nuit suivante.
  const encore = await nuit.capitaliserNuit({ atelier, lancer, maintenant: () => new Date("2026-09-26T05:00:00Z") });
  assert.equal(encore.deja, true);
  const suivante = await nuit.capitaliserNuit({ atelier, lancer, maintenant: () => new Date("2026-09-27T03:30:00Z") });
  assert.equal(suivante.traitees, 5);
});

test("routine de nuit : un refus de l'Atelier arrête la nuit ; une réponse illisible est notée, pas retentée sans fin", async () => {
  const { extraireFaits } = await import("./memoire/extraction.mjs");
  const { rangerFaits, entreeDeLIndex } = await import("./memoire/fiches.mjs");
  const nuit = await import("./memoire/nuit.mjs");
  const convs = [0, 1, 2].map(i => transcriptFixe({ id: `66666666-aaaa-bbbb-cccc-00000000000${i}`, projet: "zeta", empreinte: `z${i}` }));
  for (const c of convs) rangerFaits(extraireFaits(c));
  const atelier = fauxAtelier(convs);
  let n = 0;
  const refus = async () => ({ success: false, refus: true, stderr: "plafond atteint : 24 lancements aujourd'hui" });
  const r = await nuit.capitaliserNuit({ atelier, lancer: refus, force: true });
  assert.match(r.arret, /refus de l'Atelier/);
  assert.equal(r.traitees, 1);
  const illisible = async () => { n++; return { success: true, stdout: "je ne sais pas" }; };
  await nuit.capitaliserNuit({ atelier, lancer: illisible, force: true });
  await nuit.capitaliserNuit({ atelier, lancer: illisible, force: true });
  const avant = n;
  await nuit.capitaliserNuit({ atelier, lancer: illisible, force: true });
  assert.equal(n, avant, "deux échecs : la fiche n'est plus retentée seule");
  assert.equal(entreeDeLIndex(convs[0].conversation.id).tentatives_nuit, 2);
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

// ═════════════════════════════════════════════════════════════════════════════
// 2. Serveur isolé
// ═════════════════════════════════════════════════════════════════════════════

const MAISON_S = path.join(RACINE, "maison-serveur");
const WS = path.join(MAISON_S, ".wikichat");
const PORT = 3700 + Math.floor(Math.random() * 90);
const URL_BASE = `http://127.0.0.1:${PORT}`;
let serveur = null;
const transports = [];

function ecrire(p, contenu) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, contenu); }

function ficheBrute(id, projet, titre, corps) {
  return `---\nid: ${id}\ncli_id: ${id}\nprojet: ${projet}\ngenre: code\ndebut: 2026-09-20T10:00:00Z\nfin: 2026-09-20T11:00:00Z\nempreinte_source: x\nsens: a_venir\n---\n# ${titre}\n\nRésumé : ${corps}\n`;
}

before(async () => {
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
      WIKICHAT_ATELIER_LANCEUR_CLE_FICHIER: FICHIER_CLE, WIKICHAT_ATELIER_URL: "http://127.0.0.1:9" },
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
