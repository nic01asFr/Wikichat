#!/usr/bin/env node
/**
 * wikichat-mailbox-hook.mjs — Stop hook "mailbox check".
 *
 * Wired as a `Stop` hook in Claude Code settings. At the end of each assistant
 * turn it asks WikiChat "do I have unread messages?" for THIS agent. If yes, it
 * blocks the stop and feeds the messages back so the agent reads and replies —
 * no human, no explicit poll loop. This is how an active-but-not-polling agent
 * learns it is being contacted.
 *
 * Identity: the agent's name comes from $WIKICHAT_AGENT (the same value used to
 * bind identity in .mcp.json via ?agent=${WIKICHAT_AGENT}). If unset (anonymous
 * session), the hook does nothing.
 *
 * Loop safety: when WikiChat blocks the stop, the agent continues, handles the
 * mail, then tries to stop again — this time `stop_hook_active` is true, so we
 * exit immediately and let it stop. The per-agent cursor (last seen id) also
 * guarantees a given message is injected at most once.
 *
 * Contract (Claude Code Stop hook): print {"decision":"block","reason":"..."}
 * on stdout to keep the agent going; print nothing + exit 0 to let it stop.
 * Never print anything else to stdout.
 */
import fs from "fs";
import os from "os";
import path from "path";

function done() { process.exit(0); }

const HOOK_DIR = path.join(os.homedir(), ".wikichat", "hook-cursors");

/**
 * Determine THIS agent's WikiChat name without relying on a per-launch env var.
 * Order:
 *   1. $WIKICHAT_AGENT (explicit, e.g. when identity comes from ?agent=${WIKICHAT_AGENT}).
 *   2. The most recent mcp__wikichat__register(name=...) call in the conversation
 *      transcript (covers agents that register manually — incl. several agents in
 *      the SAME repo, where a hardcoded ?agent/env var can't tell them apart).
 *      Cached per Claude session id so we parse the transcript at most once.
 */
function detectAgentName(input) {
  const env = (process.env.WIKICHAT_AGENT || "").trim();
  if (env) return env;

  const sid = input.session_id;
  const cache = sid ? path.join(HOOK_DIR, `sid-${String(sid).replace(/[^\w.-]/g, "_")}.name`) : null;
  if (cache) { try { const n = fs.readFileSync(cache, "utf8").trim(); if (n) return n; } catch { /* miss */ } }

  const tp = input.transcript_path;
  if (!tp || !fs.existsSync(tp)) return null;
  let found = null;
  try {
    for (const ln of fs.readFileSync(tp, "utf8").split("\n")) {
      if (!ln.includes("register")) continue; // cheap prefilter before JSON.parse
      let o; try { o = JSON.parse(ln); } catch { continue; }
      const content = o?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const e of content) {
        if (e?.type === "tool_use" && /wikichat__register$/.test(e.name || "") && e.input?.name) {
          found = String(e.input.name).trim(); // keep scanning → last register wins (rename)
        }
      }
    }
  } catch { /* unreadable transcript */ }
  if (found && cache) { try { fs.mkdirSync(HOOK_DIR, { recursive: true }); fs.writeFileSync(cache, found); } catch { /* */ } }
  return found;
}

async function main() {
  let input = {};
  try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }

  // Already continuing because of a previous block → let it stop now.
  if (input.stop_hook_active) return done();

  const agent = detectAgentName(input);
  if (!agent) return done(); // identity unknown: nothing to relieve

  const base = (process.env.WIKICHAT_URL || "http://localhost:3777").replace(/\/$/, "");

  // Report our stable Claude session id (+ cwd) once per session, bound to our
  // name. The agent itself can't read $CLAUDE_SESSION_ID, but the hook gets it
  // from stdin — this is what lets contact_agent RESUME us when we're offline.
  const sid = input.session_id;
  if (sid) {
    const reported = path.join(HOOK_DIR, `sid-${String(sid).replace(/[^\w.-]/g, "_")}.reported`);
    if (!fs.existsSync(reported)) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2000);
        await fetch(`${base}/api/identity`, {
          method: "POST", signal: ctrl.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: agent, claude_session_id: sid, cwd: input.cwd || null }),
        });
        clearTimeout(t);
        try { fs.mkdirSync(HOOK_DIR, { recursive: true }); fs.writeFileSync(reported, "1"); } catch { /* */ }
      } catch { /* server down — retry next turn */ }
    }
  }

  // Cursor is now owned SERVER-SIDE, keyed on this agent's canonical name (same
  // cursor the `poll` MCP tool uses). The hook no longer tracks a local file
  // cursor — it just asks "anything new for me?" and the server dedupes via the
  // shared cursor. since_minutes=10 only matters on first activation (when the
  // server has no cursor yet) to catch already-waiting mail.
  // wait_ms : le serveur ne guette QUE si cet agent est déjà dans un échange
  // récent — sinon il répond immédiatement. Sans cette fenêtre, une session ne
  // reçoit qu'à la fin de ses propres tours : deux sessions interactives qui
  // s'organisent doivent alors être relancées à la main pour avancer d'un tour.
  // Avec elle, celle qui vient de parler attend la réponse et enchaîne seule.
  const WAIT_MS = parseInt(process.env.WIKICHAT_HOOK_WAIT_MS || "45000");
  const q = `agent=${encodeURIComponent(agent)}&since_minutes=10&wait_ms=${WAIT_MS}`;
  const url = `${base}/api/inbox?${q}`;

  let data;
  try {
    const ctrl = new AbortController();
    // Marge au-delà de l'attente serveur : on ne coupe jamais une écoute en cours,
    // mais on ne pend jamais non plus si le serveur est tombé.
    const t = setTimeout(() => ctrl.abort(), WAIT_MS + 5000);
    const resp = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!resp.ok) return done();
    data = await resp.json();
  } catch { return done(); } // server down / unreachable → stay silent

  if (!data.messages || data.messages.length === 0) return done();

  const lines = data.messages.map(m => {
    const where = m.isDM ? "DM" : (m.channel === "__broadcast__" ? "📢 diffusion" : `#${m.channel}`);
    const flags = [
      m.expects_reply ? "réponse attendue" : null,
      m.status ? m.status : null,
    ].filter(Boolean).join(", ");
    return `  • [${where}] ${m.from}: ${m.content}${flags ? ` (${flags})` : ""}`;
  }).join("\n");

  const reason =
    `📬 ${data.messages.length} message(s) WikiChat t'attend(ent) (${agent}) :\n${lines}\n\n` +
    `On cherche à te contacter. Lis-les, et si une réponse est attendue, réponds via ` +
    `mcp__wikichat__send_message(channel="@<expéditeur>", ...). Si rien ne requiert ta réponse, tu peux t'arrêter.`;

  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  done();
}

main().catch(() => process.exit(0));
