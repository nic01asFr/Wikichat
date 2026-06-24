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

try {
  fs.mkdirSync(TOK_DIR, { recursive: true });
  const tokenFile = path.join(TOK_DIR, `${ppid}.token`);
  let token = null;
  try { token = fs.readFileSync(tokenFile, "utf8").trim() || null; } catch { /* first run for this PPID */ }
  if (!token) {
    token = crypto.randomBytes(16).toString("hex");
    try { fs.writeFileSync(tokenFile, token); } catch { /* */ }
  }
  process.stdout.write(JSON.stringify({ "x-wikichat-token": token }));
} catch {
  // Silent failure → no header → connection stays anonymous as before. Never
  // block the MCP transport because of a token-helper hiccup.
  process.stdout.write("{}");
}
