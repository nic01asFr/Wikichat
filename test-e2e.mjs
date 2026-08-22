#!/usr/bin/env node
/**
 * test-e2e.mjs — Vérifie que les mécanismes critiques fonctionnent réellement.
 *
 * Chaque cas correspond à un bug qui a existé en production. Le motif récurrent
 * de ce projet est le mécanisme écrit mais pas branché : la syntaxe est valide,
 * le serveur démarre, et rien ne se passe. `node --check` ne l'attrape pas ;
 * ces assertions, si.
 *
 * Usage :
 *   npm start &    (le serveur doit tourner)
 *   npm test
 *
 * Sortie : code 1 si un cas échoue, pour être utilisable en CI.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3777";
// Espace de noms FIXE, et non horodaté. Un suffixe par exécution isolait bien les
// runs, mais laissait derrière lui un canal et une poignée d'identités à chaque
// fois : 15 canaux et 40 identités fantômes s'étaient accumulés dans l'état de la
// machine. Un nom stable rend la suite réentrante — elle réécrit ses propres
// traces au lieu d'en semer de nouvelles.
const SUFFIX = "suite";
/** Identités créées par la suite, purgées à la fin. */
const _aPurger = [];

let passed = 0, failed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; failures.push(label); console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ""}`); }
}

function section(title) { console.log(`\n── ${title}`); }

async function connect(name) {
  const transport = new SSEClientTransport(new URL(`${SERVER_URL}/sse`));
  const client = new Client({ name: `e2e-${name}`, version: "1.0.0" });
  await client.connect(transport);
  return {
    name, transport,
    async call(tool, args = {}) {
      const r = await client.callTool({ name: tool, arguments: args });
      return r.content?.map(c => c.text).join("\n") || "";
    },
    close: () => transport.close().catch(() => {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

section("Fonctions pures (sans serveur)");

// Bug réel : l'affichage préfixe les canaux d'un '#', un agent le recopiait, et
// "#insights" devenait un canal distinct de "insights" — invisible aux triggers.
const { normalizeChannel } = await import("./src/state.mjs");
check("normalizeChannel retire les dièses de tête", normalizeChannel("##insights") === "insights");
check("normalizeChannel préserve les DM", normalizeChannel("dm:a__b") === "dm:a__b");
check("normalizeChannel préserve les cibles @", normalizeChannel("@Bob") === "@Bob");
check("normalizeChannel préserve les canaux internes", normalizeChannel("__broadcast__") === "__broadcast__");

// Bug réel : --resume était passé sans vérifier que le transcript existe, ce qui
// faisait échouer le CLI au démarrage (49 identifiants sur 67 pointaient à vide).
const { resolveResumeSession } = await import("./src/sampler.mjs");
check("resolveResumeSession refuse un identifiant inconnu",
  resolveResumeSession("AgentQuiNExistePas", process.cwd()) === null);
check("resolveResumeSession refuse un identifiant sans transcript",
  resolveResumeSession(null, process.cwd(), "00000000-0000-0000-0000-000000000000") === null);

// Bug réel, invisible sur une machine rodée : la porte dormante exigeait à la
// fois un agent nommé ET au moins un projet au registre. Sur une installation
// neuve le registre est vide par construction — la porte ne s'ouvrait donc
// jamais, aucun trigger ne tirait, et le service se déclarait « healthy ».
const dormant = await import("./src/dormant.mjs");
const etatSessions = new Map([["s1", { sessionId: "s1", name: "UnAgentNomme" }]]);
const { state: etat } = await import("./src/state.mjs");
const sessionsAvant = etat.sessions, projetsAvant = etat.projects;
etat.sessions = etatSessions; etat.projects = new Map();
check("un agent nommé suffit à réveiller un registre vide", dormant.isActive() === true,
  "installation neuve condamnée : triggers inertes sans que rien ne le dise");
etat.sessions = new Map(); etat.projects = new Map();
check("sans agent nommé ni projet, le service reste dormant", dormant.isActive() === false,
  "la porte ne se referme plus — 0 % CPU au repos n'est plus tenu");
etat.sessions = sessionsAvant; etat.projects = projetsAvant;

// ─────────────────────────────────────────────────────────────────────────────

section("Serveur HTTP");

const health = await fetch(`${SERVER_URL}/api/health`).then(r => r.json()).catch(() => null);
check("le serveur répond sur /api/health", health?.status === "healthy",
  health ? JSON.stringify(health).slice(0, 60) : "injoignable — lancer `npm start`");
if (!health) { console.log("\n⛔ Serveur injoignable, arrêt."); process.exit(1); }

// Bug réel : le hook prenait un instantané et rendait la main, donc deux sessions
// interactives ne pouvaient pas s'enchaîner sans relance humaine.
const t0 = Date.now();
const FROID = `__e2e_froid_${SUFFIX}`; _aPurger.push(FROID);
const froid = await fetch(`${SERVER_URL}/api/inbox?agent=${FROID}&wait_ms=4000`).then(r => r.json());
const dtFroid = Date.now() - t0;
check("hors conversation, /api/inbox répond immédiatement", dtFroid < 2000 && froid.waited === false,
  `${dtFroid} ms, waited=${froid.waited}`);

// ─────────────────────────────────────────────────────────────────────────────

section("Messagerie entre deux sessions");

const alice = await connect("alice");
const bob = await connect("bob");
const ALICE = `__e2e_alice_${SUFFIX}`, BOB = `__e2e_bob_${SUFFIX}`;
_aPurger.push(ALICE, BOB);

const regA = await alice.call("register", { name: ALICE, role: "e2e", agent_type: "headless" });
check("register retourne une confirmation", /Enregistré/i.test(regA), regA.slice(0, 60));
await bob.call("register", { name: BOB, role: "e2e", agent_type: "headless" });

// Le canal est volontairement écrit avec un dièse : un agent qui recopie
// l'affichage ne doit pas créer un salon parallèle.
const CANAL = `#e2e-${SUFFIX}`;
await alice.call("send_message", { channel: CANAL, content: `@${BOB} ping e2e`, expects_reply: true });

const vuParBob = await bob.call("read_messages", { channel: CANAL.replace(/^#+/, ""), since_minutes: 2 });
check("un message envoyé sur '#canal' est lisible sur 'canal'", /ping e2e/.test(vuParBob),
  "la normalisation de canal ne s'applique pas");

// Bug réel : le curseur devait être partagé entre le hook et poll, sans doublon.
const poll1 = await bob.call("poll", {});
const poll2 = await bob.call("poll", {});
check("poll livre le message adressé", /ping e2e/.test(poll1));
check("poll ne re-livre pas le même message", !/ping e2e/.test(poll2), "curseur non avancé");

// Bug réel : read_messages réaffectait une `const` dès qu'on visait un DM, donc
// tout `@Nom` et tout `@me` plantaient sur « Assignment to constant variable ».
// Un agent qui cherchait ses messages directs recevait une erreur brute.
const dmSelf = await bob.call("read_messages", { channel: "@me", since_minutes: 5 });
check("read_messages accepte @me sans planter", !/Assignment to constant/.test(dmSelf), dmSelf.slice(0, 60));
const dmNamed = await bob.call("read_messages", { channel: `@${ALICE}`, since_minutes: 5 });
check("read_messages accepte @Nom sans planter", !/Assignment to constant/.test(dmNamed), dmNamed.slice(0, 60));

// ─────────────────────────────────────────────────────────────────────────────

section("Triggers");

const TRIG = `__e2e_trig_${SUFFIX}`;
// Bug réel : register_trigger stockait la config en chaîne JSON sans la parser,
// donc config.pattern valait undefined et un channel_match matchait TOUT.
await alice.call("register_trigger", {
  id: TRIG, type: "channel_match",
  config: { channel: `e2e-${SUFFIX}`, pattern: "MOTIF_UNIQUE_E2E", flags: "i" },
  action_type: "broadcast",
  action_params: { channel: `e2e-${SUFFIX}`, content: "trigger e2e déclenché" },
  cooldown_s: 0, max_per_day: 10,
});
const listeTrig = await alice.call("list_triggers", {});
check("le trigger est enregistré et actif", new RegExp(`🟢 ${TRIG}`).test(listeTrig));

await alice.call("send_message", { channel: `e2e-${SUFFIX}`, content: "ceci contient MOTIF_UNIQUE_E2E" });
await new Promise(r => setTimeout(r, 1500));
const apresMatch = await alice.call("list_triggers", {});
const ligne = apresMatch.split("\n\n").find(b => b.includes(TRIG)) || "";
check("un channel_match fire sur son motif", /[1-9]\d* tir\(s\)/.test(ligne), ligne.split("\n").pop());

// Le pendant : un motif absent ne doit rien déclencher.
const avant = (ligne.match(/(\d+) tir\(s\)/) || [])[1];
await alice.call("send_message", { channel: `e2e-${SUFFIX}`, content: "message sans le motif" });
await new Promise(r => setTimeout(r, 1200));
const apresNonMatch = await alice.call("list_triggers", {});
const ligne2 = apresNonMatch.split("\n\n").find(b => b.includes(TRIG)) || "";
const apres = (ligne2.match(/(\d+) tir\(s\)/) || [])[1];
check("un channel_match ne fire pas hors motif", avant === apres, `${avant} → ${apres}`);

// ─────────────────────────────────────────────────────────────────────────────

section("Guetteur de boîte");

// Le guetteur n'est pas posé par défaut : il ne sert que si l'agent vient de
// créer une attente ET qu'il reste en vie pour la voir aboutir. La suggestion
// est donc conditionnée, pas systématique.
const sansAttente = await bob.call("send_message", {
  channel: `e2e-${SUFFIX}`, content: "rien à attendre ici", expects_reply: false,
});
check("aucun guetteur suggéré quand rien n'est attendu", !/guetteur/i.test(sansAttente));

// alice est enregistrée en headless : elle sortira avant qu'un guetteur ne serve.
const headlessAttend = await alice.call("send_message", {
  channel: `e2e-${SUFFIX}`, content: "j'attends une réponse", expects_reply: true,
});
check("aucun guetteur suggéré à un agent headless", !/guetteur/i.test(headlessAttend),
  "un one-shot poserait un processus pour rien");

const inter = await connect("interactif");
const INTER = `__e2e_inter_${SUFFIX}`; _aPurger.push(INTER);
await inter.call("register", { name: INTER, role: "e2e", agent_type: "interactive" });
const premier = await inter.call("send_message", {
  channel: `e2e-${SUFFIX}`, content: "je t'attends", expects_reply: true,
});
check("guetteur suggéré à une session qui attend une réponse", /run_in_background/.test(premier),
  premier.slice(-80));
const second = await inter.call("send_message", {
  channel: `e2e-${SUFFIX}`, content: "toujours là ?", expects_reply: true,
});
check("la suggestion ne se répète pas dans la même session", !/run_in_background/.test(second),
  "répétée à chaque message = bruit");
await inter.close();

// ─────────────────────────────────────────────────────────────────────────────

section("Réveil générique");

// Un seul trigger (evt-wake-any) réveille n'importe quel agent nommé hors ligne
// qu'un message mentionne en attendant une réponse. Auparavant il fallait un
// trigger par agent — donc aucun pour les agents nés après le dernier boot.
//
// On vérifie le chemin de décision sans lancer de vrai processus : la cible
// déclarée ici a un repo inexistant, donc le trigger fire, résout la cible, et
// refuse au dernier moment (repo_inconnu). C'est tout le câblage sauf le spawn.
const DORMEUR = `__e2e_dormeur_${SUFFIX}`; _aPurger.push(DORMEUR);
const dormeur = await connect("dormeur");
await dormeur.call("register", { name: DORMEUR, role: "e2e", agent_type: "headless" });
await dormeur.call("remember", { key: "__cwd", value: "/chemin/qui/n/existe/pas" });
await dormeur.close(); // il est désormais connu mais hors ligne

function fireCount(liste) {
  const bloc = liste.split("\n\n").find(b => b.includes("evt-wake-any")) || "";
  return parseInt((bloc.match(/(\d+) tir\(s\)/) || [])[1] ?? "-1", 10);
}
const wake0 = fireCount(await alice.call("list_triggers", {}));
check("le trigger de réveil générique existe", wake0 >= 0, "evt-wake-any absent");

await alice.call("send_message", {
  channel: `e2e-${SUFFIX}`, content: `@${DORMEUR} tu peux relire ça ?`, expects_reply: true,
});
await new Promise(r => setTimeout(r, 1500));
const wake1 = fireCount(await alice.call("list_triggers", {}));
check("une mention avec réponse attendue déclenche le réveil", wake1 > wake0, `${wake0} → ${wake1}`);

// Le pendant : sans réponse attendue, on ne réveille personne. Sinon toute
// mention en passant relancerait un agent.
await alice.call("send_message", {
  channel: `e2e-${SUFFIX}`, content: `@${DORMEUR} pour info, rien à faire`, expects_reply: false,
});
await new Promise(r => setTimeout(r, 1200));
const wake2 = fireCount(await alice.call("list_triggers", {}));
check("une mention sans réponse attendue ne réveille pas", wake2 === wake1, `${wake1} → ${wake2}`);

// Et rien n'a réellement été lancé : le repo déclaré n'existe pas.
const sessionsApres = await alice.call("list_sessions", {});
check("aucun agent n'est lancé quand son repo est introuvable",
  !sessionsApres.includes(DORMEUR), "un processus a été lancé malgré un repo absent");

// ─────────────────────────────────────────────────────────────────────────────

section("Identité et audience");

// Bug réel : le .mcp.json injecté ne portait aucune identité, donc toute session
// spawnée restait anonyme jusqu'à son register — et le redevenait en se
// reconnectant. 15 sessions connectées, 0 nommée.
const IDENT = `__e2e_ident_${SUFFIX}`; _aPurger.push(IDENT);
const identifie = await connect("ident-url");
await identifie.close();
const viaUrl = new SSEClientTransport(new URL(`${SERVER_URL}/sse?agent=${encodeURIComponent(IDENT)}`));
const clientUrl = new Client({ name: "e2e-ident", version: "1.0.0" });
await clientUrl.connect(viaUrl);
await new Promise(r => setTimeout(r, 600));
const vues = await clientUrl.callTool({ name: "list_sessions", arguments: {} })
  .then(r => r.content?.map(c => c.text).join("\n") || "");
check("une connexion ?agent=<nom> est identifiée sans register()", vues.includes(IDENT),
  "l'identité ne voyage pas avec la connexion");

// Bug réel : un message posté alors qu'aucun agent nommé n'écoute partait dans le
// vide, et la réponse laissait croire qu'il avait atteint quelqu'un.
const envoi = await clientUrl.callTool({
  name: "send_message",
  arguments: { channel: `e2e-${SUFFIX}`, content: "sonde audience" },
}).then(r => r.content?.map(c => c.text).join("\n") || "");
const nommesAilleurs = /Aucun agent nommé n'est connecté|Personne d'autre n'est connecté/.test(envoi);
check("send_message signale quand personne de nommé n'écoute",
  nommesAilleurs || /📤 Envoyé/.test(envoi),
  "ni avertissement ni confirmation");
await viaUrl.close().catch(() => {});

section("Connaissance et projets");

const kb = await alice.call("search_knowledge", { query: "axis", limit: 3 });
check("search_knowledge répond sans erreur", !/❌|Error/i.test(kb), kb.slice(0, 60));

const projets = await alice.call("list_projects", {});
check("list_projects retourne le registre", /projet/i.test(projets), projets.slice(0, 60));

// ─────────────────────────────────────────────────────────────────────────────

// Purge : une suite de tests ne doit pas laisser d'identités fantômes dans la
// mémoire de la machine. `forget` est scopé au nom de l'appelant, donc on se
// reconnecte sous chaque nom utilisé pour effacer ce qu'il a écrit.
section("Purge");
await alice.call("delete_trigger", { id: TRIG }).catch(() => {});
await alice.close(); await bob.close();

async function purgerIdentite(nom) {
  const c = await connect("purge");
  try {
    await c.call("register", { name: nom, role: "e2e", agent_type: "headless" });
    for (const cle of ["__cwd", "__inbox_cursor", "__claude_session_id", "__home_channel"]) {
      await c.call("forget", { key: cle }).catch(() => {});
    }
  } finally { await c.close(); }
}
for (const nom of _aPurger) await purgerIdentite(nom).catch(() => {});

// Contrôle : sous l'un des noms utilisés, il ne doit plus rien rester.
const temoin = await connect("temoin");
await temoin.call("register", { name: DORMEUR, role: "e2e", agent_type: "headless" });
const reste = await temoin.call("recall", {});
await temoin.close();
check("la suite ne laisse pas de mémoire derrière elle",
  /aucune|vide|rien|0 /i.test(reste) || !/__cwd/.test(reste), reste.slice(0, 80));

console.log(`\n${"─".repeat(52)}`);
console.log(`${passed} réussis, ${failed} échoués`);
if (failed) { console.log(`\nÉchecs :\n${failures.map(f => `  • ${f}`).join("\n")}`); }
process.exit(failed ? 1 : 0);
