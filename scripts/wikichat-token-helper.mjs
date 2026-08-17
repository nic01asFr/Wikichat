#!/usr/bin/env node
/**
 * wikichat-token-helper.mjs — headersHelper for WikiChat MCP SSE.
 *
 * Emits a stable per-Claude-window identity token as the `x-wikichat-token`
 * header on every (re)connection. The server's /sse handler already understands
 * this header (src/persistence.mjs identity bindings + server.mjs /sse) and
 * auto-restores the bound name on subsequent reconnects — so an agent only has
 * to register() ONCE per Claude conversation, and every SSE reconnect after
 * that re-attaches the same identity automatically. No env var, no behavioural
 * cooperation, multi-agent-per-repo safe (each window has a distinct PPID).
 *
 * Deux clés possibles, par ordre de préférence :
 *
 *   1. CLAUDE_CODE_SESSION_ID — l'identifiant de la CONVERSATION. C'est la
 *      bonne granularité : un agent EST une conversation. Le jeton en dérive
 *      par hachage, donc il est reproductible sans rien stocker, et il survit à
 *      tout — fermeture de la fenêtre, reprise via --resume, redémarrage du
 *      service, redémarrage de la machine. Une identité déclarée une fois reste
 *      acquise pour toute la vie de la conversation.
 *
 *   2. Le PID du processus parent, quand la variable est absente (versions
 *      anciennes, lancement inhabituel). Le jeton est alors tiré au sort et
 *      stocké dans ~/.wikichat/process-tokens/<PPID>.token — il ne survit qu'à
 *      la fenêtre, et périme au bout de 7 jours pour qu'une réattribution de PID
 *      ne fasse hériter l'identité de personne.
 *
 * Le hachage est salé par un secret local, écrit une fois : sans lui, l'identifiant
 * de conversation apparaît en clair dans les chemins de transcrits, et connaître
 * un chemin suffirait à se faire passer pour son auteur.
 *
 * Claude Code contract: stdout MUST be a JSON object of header name → value.
 * Anything else, or any non-zero exit, drops the headers.
 */
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const TOK_DIR = path.join(os.homedir(), ".wikichat", "process-tokens");
const ppid = process.ppid || process.pid; // fall back to self if PPID unavailable
const SEL_FILE = path.join(os.homedir(), ".wikichat", "identity-salt");

/** Secret local, créé au premier passage, pour que le jeton ne soit pas devinable. */
function sel() {
  try {
    return fs.readFileSync(SEL_FILE, "utf8").trim() || null;
  } catch {
    const s = crypto.randomBytes(24).toString("hex");
    try {
      fs.mkdirSync(path.dirname(SEL_FILE), { recursive: true });
      fs.writeFileSync(SEL_FILE, s, { mode: 0o600 });
    } catch { /* non bloquant */ }
    return s;
  }
}

/** Identifiant de conversation, s'il est exposé. */
const conversation = (process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || "").trim();

/**
 * Péremption des jetons abandonnés.
 *
 * Le jeton est indexé sur le PID parent, et les systèmes réutilisent les PID.
 * Sans péremption, une fenêtre Claude ouverte aujourd'hui peut hériter du jeton
 * d'une fenêtre morte il y a des mois — donc de SON identité, et parler sous le
 * nom de quelqu'un d'autre. Anonyme est gênant ; usurpé est pire.
 *
 * Un fichier est retouché à chaque appel : une fenêtre vivante, qui repasse ici
 * à chaque reconnexion, garde son jeton indéfiniment. Un PID abandonné voit le
 * sien expirer, et sa réattribution repart d'une identité neuve.
 */
const PEREMPTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Retire les jetons périmés — sinon le répertoire enfle sans fin (160 entrées observées). */
function purgerJetonsPerimes() {
  try {
    const limite = Date.now() - PEREMPTION_MS;
    for (const f of fs.readdirSync(TOK_DIR)) {
      if (!f.endsWith(".token")) continue;
      const p = path.join(TOK_DIR, f);
      try { if (fs.statSync(p).mtimeMs < limite) fs.unlinkSync(p); } catch { /* course : ignorer */ }
    }
  } catch { /* non bloquant */ }
}

try {
  // Chemin nominal : la conversation est connue, le jeton en dérive. Rien à
  // stocker, rien à périmer, rien à perdre.
  if (conversation) {
    const jeton = crypto.createHash("sha256")
      .update(`wikichat-identite:${sel()}:${conversation}`)
      .digest("hex").slice(0, 32);
    // L'identifiant de conversation voyage aussi, en clair : c'est le second
    // filet côté serveur, qui retrouve un agent déjà déclaré même si la liaison
    // de jeton manque. Le jeton reste la voie normale ; ceci n'est qu'un
    // recours, et il ne divulgue rien que le disque local n'expose déjà.
    process.stdout.write(JSON.stringify({
      "x-wikichat-token": jeton,
      "x-wikichat-claude-session": conversation,
    }));
    process.exit(0);
  }

  fs.mkdirSync(TOK_DIR, { recursive: true });
  const tokenFile = path.join(TOK_DIR, `${ppid}.token`);
  let token = null;
  try {
    const st = fs.statSync(tokenFile);
    if (Date.now() - st.mtimeMs < PEREMPTION_MS) {
      token = fs.readFileSync(tokenFile, "utf8").trim() || null;
    }
  } catch { /* premier passage pour ce PPID */ }
  if (!token) {
    token = crypto.randomBytes(16).toString("hex");
    purgerJetonsPerimes(); // nouveau jeton = bon moment pour faire le ménage
  }
  // Réécrit systématiquement : cela rafraîchit la date et prolonge le jeton
  // tant que la fenêtre vit.
  try { fs.writeFileSync(tokenFile, token); } catch { /* */ }
  process.stdout.write(JSON.stringify({ "x-wikichat-token": token }));
} catch {
  // Silent failure → no header → connection stays anonymous as before. Never
  // block the MCP transport because of a token-helper hiccup.
  process.stdout.write("{}");
}
