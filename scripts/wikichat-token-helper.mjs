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
 * Token is keyed by the helper's parent process id (= the Claude Code process).
 * Stored in ~/.wikichat/process-tokens/<PPID>.token so reconnects of the same
 * Claude window re-emit the same token; a brand-new Claude window gets a fresh
 * token (and thus needs its first register to bind it).
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
