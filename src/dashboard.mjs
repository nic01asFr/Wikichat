/**
 * dashboard.mjs — WikiChat Cockpit — Live interactive dashboard.
 */

import { state, timeSince, getChannelCount } from "./state.mjs";
import { loadSpawnRegistry } from "./persistence.mjs";

const dashboardClients = new Set();

let _lastSnapshot = null;

let _dashboardTimer = null;
const DASHBOARD_DEBOUNCE_MS = 200;

export function pushDashboardUpdate() {
  if (dashboardClients.size === 0) return;
  if (_dashboardTimer) return; // Already scheduled
  _dashboardTimer = setTimeout(_flushDashboard, DASHBOARD_DEBOUNCE_MS);
}

function _flushDashboard() {
  _dashboardTimer = null;
  if (dashboardClients.size === 0) return;
  const payload = buildStateSnapshot();

  // Build delta if we have a previous snapshot
  let delta = null;
  if (_lastSnapshot) {
    delta = buildDelta(_lastSnapshot, payload);
  }
  _lastSnapshot = payload;

  // Send delta if small, full snapshot otherwise
  const toSend = delta && delta.changes > 0 && delta.changes < 10
    ? { type: "delta", ...delta }
    : { type: "snapshot", ...payload };

  const data = `data: ${JSON.stringify(toSend)}\n\n`;
  for (const res of dashboardClients) {
    try { res.write(data); } catch { dashboardClients.delete(res); }
  }
}

function buildDelta(prev, next) {
  const changes = { type: "delta", changes: 0 };

  // New messages since last snapshot
  const prevIds = new Set(prev.recentMessages.map(m => m.id));
  const newMsgs = next.recentMessages.filter(m => !prevIds.has(m.id));
  if (newMsgs.length > 0) {
    changes.newMessages = newMsgs;
    changes.changes += newMsgs.length;
  }

  // Session changes
  const prevNames = new Set(prev.sessions.map(s => s.name));
  const nextNames = new Set(next.sessions.map(s => s.name));
  const joined = next.sessions.filter(s => !prevNames.has(s.name));
  const left = prev.sessions.filter(s => !nextNames.has(s.name)).map(s => s.name);
  if (joined.length) { changes.sessionsJoined = joined; changes.changes += joined.length; }
  if (left.length) { changes.sessionsLeft = left; changes.changes += left.length; }

  // Stats always included
  changes.stats = next.stats;
  changes.channels = next.channels;

  return changes;
}

function buildStateSnapshot() {
  const sessions = [...state.sessions.values()];

  // Build spawn tree from registry
  let spawnTree = [];
  try {
    const reg = loadSpawnRegistry();
    spawnTree = reg.map(e => ({
      name: e.name, role: e.role, status: e.status,
      exit_code: e.exit_code, spawned_by: e.spawned_by,
      spawned_at: e.spawned_at, ended_at: e.ended_at,
      project: e.repo_path ? e.repo_path.replace(/\\\\/g, "/").split("/").pop() : null,
    }));
  } catch { /* non-blocking */ }

  return {
    ts: new Date().toISOString(),
    sessions: sessions.filter(s => !s.name.startsWith("session-")).map(s => ({
      name: s.name,
      registered: true,
      role: s.role, status: s.status,
      availability: s.availability,
      lastSeen: s.lastSeen,
      current_task: s.current_task,
      current_project: s.current_project,
      skills: s.skills || [],
      eta: s.eta, etaReason: s.etaReason,
      since: timeSince(s.connectedAt),
    })),
    channels: [...state.channels.entries()]
      .filter(([n]) => !n.startsWith("dm:"))
      .map(([name, ch]) => ({
        name, description: ch.description,
        count: getChannelCount(name),
        isSystem: !!ch.isSystem,
      })),
    recentMessages: state.messages
      .slice(-80)
      .map(m => ({
        id: m.id.slice(0, 8), from: m.fromName || m.from,
        channel: m.channel, content: (m.content || "").slice(0, 500),
        ts: new Date(m.timestamp).toLocaleTimeString("fr-FR"),
        isSystem: m.from === "system",
        isArtifact: m.content?.startsWith("📎"),
        isBroadcast: m.channel === "__broadcast__",
        isDM: m.channel?.startsWith("dm:") || m.type === "direct_message",
        type: m.type || "message",
      })),
    projects: [...state.projects.values()].map(p => {
      const active = [...p.tasks.values()].filter(t => t.status === "active");
      const done = [...p.tasks.values()].filter(t => t.status === "done").length;
      const agents = [...state.sessions.values()]
        .filter(s => s.current_project?.toLowerCase() === p.name.toLowerCase())
        .map(s => s.name);
      return {
        name: p.name, description: p.description,
        status: p.status, stack: p.stack || [],
        activeTasks: active.length, doneTasks: done,
        activeClaims: active.map(t => ({ id: t.id, who: t.claimedBy, desc: t.description.slice(0, 60) })),
        agents, blockers: (p.blockers || []).length,
      };
    }),
    spawnTree,
    stats: {
      totalMessages: state.messages.length,
      totalSessions: sessions.length,
      registered: sessions.filter(s => !s.name.startsWith("session-")).length,
      uptime: Math.floor(process.uptime()),
    },
  };
}

export function handleDashboardEvents(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(buildStateSnapshot())}\n\n`);
  dashboardClients.add(res);
  const hb = setInterval(() => {
    try { res.write(": heartbeat\n\n"); } catch { clearInterval(hb); dashboardClients.delete(res); }
  }, 15000);
  if (hb.unref) hb.unref();
  req.on("close", () => { clearInterval(hb); dashboardClients.delete(res); });
}

export function handleDashboardPage(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(DASHBOARD_HTML);
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>WikiChat Cockpit</title>
<style>
:root {
  --bg:#0d1117;--surface:#161b22;--surface2:#1c2128;--border:#30363d;
  --text:#e6edf3;--muted:#8b949e;--accent:#58a6ff;
  --green:#3fb950;--yellow:#d29922;--red:#f85149;
  --purple:#bc8cff;--orange:#ffa657;--teal:#39d353;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;height:100vh;display:flex;flex-direction:column;overflow:hidden}

/* ── header ── */
header{background:var(--surface);border-bottom:1px solid var(--border);padding:8px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
header h1{font-size:15px;font-weight:700;color:var(--accent);letter-spacing:-.01em}
.pill{background:var(--border);border-radius:10px;padding:2px 9px;font-size:11px;font-weight:600;color:var(--muted)}
.pill.green{background:#1a3a1a;color:var(--green)}
.pill.blue{background:#1a2a3a;color:var(--accent)}
.sep{color:var(--border);margin:0 2px}
.uptime{margin-left:auto;color:var(--muted);font-size:11px}
#dot{width:7px;height:7px;border-radius:50%;background:var(--green);flex-shrink:0;transition:background .3s}
#dot.off{background:var(--red)}

/* ── 3-column layout ── */
.body{display:grid;grid-template-columns:240px 1fr 320px;flex:1;overflow:hidden}
@media(max-width:900px){.body{grid-template-columns:200px 1fr;}.activity{display:none}}

/* ── sidebar ── */
.sidebar{border-right:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.panel{padding:10px;overflow-y:auto;flex-shrink:0}
.panel+.panel{border-top:1px solid var(--border)}
.panel.grow{flex:1;overflow-y:auto}
h2{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:6px;display:flex;align-items:center;justify-content:space-between}
h2 span{font-size:11px;font-weight:600;color:var(--accent);letter-spacing:0;text-transform:none}

/* ── session cards ── */
.session{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:7px 9px;margin-bottom:5px;transition:border-color .2s;cursor:pointer}
.session:hover{border-color:var(--accent)}
.session.unregistered{border-color:#2a2a2a;opacity:.6}
.session.active-chat{border-color:var(--accent);background:var(--surface2)}
.s-head{display:flex;justify-content:space-between;align-items:center;gap:4px}
.s-name{font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s-role{color:var(--purple);font-size:10px;margin-top:1px}
.s-status{color:var(--muted);font-size:10px;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.s-actions{display:flex;gap:3px;margin-top:4px}
.s-btn{background:var(--border);border:none;border-radius:3px;color:var(--muted);font-size:10px;padding:2px 6px;cursor:pointer;transition:all .15s}
.s-btn:hover{background:var(--accent);color:var(--bg)}
.s-btn.chat{color:var(--accent)}
.badge{display:inline-flex;align-items:center;border-radius:4px;padding:1px 5px;font-size:10px;font-weight:700;white-space:nowrap;flex-shrink:0}
.badge.available{background:#1a3a1a;color:var(--green)}
.badge.busy{background:#3a2a1a;color:var(--orange)}
.badge.reviewing{background:#1a2a3a;color:var(--accent)}
.badge.idle,.badge.stale{background:#2a2a2a;color:var(--muted)}
.badge.unregistered{background:#222;color:#555;font-style:italic}
.badge.eta{background:#3a3010;color:var(--yellow)}

/* ── channels ── */
.ch{display:flex;justify-content:space-between;align-items:center;padding:3px 6px;border-radius:4px;margin-bottom:2px;cursor:pointer;transition:background .1s}
.ch:hover{background:var(--surface2)}
.ch.active{background:var(--surface2);border-left:2px solid var(--accent)}
.ch-name{color:var(--accent);font-weight:600;font-size:12px}
.ch-name.sys{color:var(--muted)}
.ch-count{background:var(--border);border-radius:8px;padding:0 6px;font-size:10px;font-weight:700;color:var(--muted)}
.ch-count.active{background:#1a2a3a;color:var(--accent)}

/* ── projects ── */
.project{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--orange);border-radius:6px;padding:7px 9px;margin-bottom:5px}
.p-name{font-weight:700;color:var(--orange);font-size:12px}
.p-desc{color:var(--muted);font-size:10px;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.p-meta{display:flex;gap:4px;margin-top:4px;flex-wrap:wrap}
.p-tag{background:var(--border);border-radius:3px;padding:1px 5px;font-size:9px;color:var(--muted)}
.p-tag.tasks{background:#1a3a1a;color:var(--green)}
.p-tag.blockers{background:#3a1a1a;color:var(--red)}
.p-tag.agents{background:#1a2a3a;color:var(--accent)}
.p-spawn-btn{background:var(--border);border:none;border-radius:3px;color:var(--orange);font-size:10px;padding:2px 6px;cursor:pointer;margin-top:4px}
.p-spawn-btn:hover{background:var(--orange);color:var(--bg)}

/* ── chat panel (center) ── */
.chat-panel{display:flex;flex-direction:column;overflow:hidden}
.chat-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);flex-shrink:0;overflow-x:auto;background:var(--surface)}
.chat-tab{padding:7px 14px;font-size:11px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;display:flex;align-items:center;gap:4px;transition:all .1s}
.chat-tab:hover{color:var(--text);background:var(--surface2)}
.chat-tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.chat-tab .close{font-size:12px;opacity:.4;cursor:pointer;margin-left:2px}
.chat-tab .close:hover{opacity:1;color:var(--red)}
.chat-messages{flex:1;overflow-y:auto;padding:10px 14px}
.chat-input-wrap{border-top:1px solid var(--border);padding:8px 14px;display:flex;gap:8px;flex-shrink:0;background:var(--surface)}
.chat-input{flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:inherit;font-size:12px;padding:8px 10px;resize:none;min-height:36px;max-height:100px}
.chat-input:focus{outline:none;border-color:var(--accent)}
.chat-send{background:var(--accent);color:var(--bg);border:none;border-radius:6px;padding:0 16px;font-weight:700;font-size:12px;cursor:pointer;flex-shrink:0}
.chat-send:hover{filter:brightness(1.15)}
.chat-send:disabled{opacity:.4;cursor:default}

/* ── chat messages ── */
.cm{padding:5px 0;border-bottom:1px solid #1a1f26}
.cm:last-child{border-bottom:none}
.cm-head{display:flex;align-items:baseline;gap:6px;margin-bottom:1px}
.cm-time{color:var(--muted);font-size:10px;font-variant-numeric:tabular-nums;flex-shrink:0}
.cm-from{font-weight:700;font-size:12px}
.cm-from.pilot{color:var(--teal)}
.cm-from.system{color:#555}
.cm-from.agent{color:var(--accent)}
.cm-body{color:#c9d1d9;font-size:12px;line-height:1.45;word-break:break-word;white-space:pre-wrap}
.cm-body.system{color:#444;font-style:italic}
.cm-body.artifact{color:var(--purple)}
.empty-chat{color:var(--muted);font-style:italic;padding:40px;text-align:center;font-size:12px}

/* ── activity feed (right) ── */
.activity{border-left:1px solid var(--border);display:flex;flex-direction:column;overflow:hidden}
.activity-header{padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--surface)}
.activity-filters{display:flex;gap:4px;margin-top:5px}
.af-btn{background:var(--border);border:none;border-radius:3px;color:var(--muted);font-size:10px;padding:2px 7px;cursor:pointer}
.af-btn:hover,.af-btn.active{background:var(--accent);color:var(--bg)}
.activity-body{flex:1;overflow-y:auto;padding:8px 10px}
.act{padding:4px 0;border-bottom:1px solid #1a1f26;font-size:11px}
.act-time{color:var(--muted);font-size:10px;font-variant-numeric:tabular-nums}
.act-ch{color:var(--accent);font-weight:600;font-size:10px}
.act-from{font-weight:600}
.act-body{color:#aaa;margin-top:1px;white-space:pre-wrap;word-break:break-word}
.act.spawn{border-left:2px solid var(--orange);padding-left:6px}
.act.artifact{border-left:2px solid var(--purple);padding-left:6px}
.act.error{border-left:2px solid var(--red);padding-left:6px}
.act.system{opacity:.5}

/* ── spawn bar ── */
.spawn-bar{background:var(--surface);border-top:1px solid var(--border);flex-shrink:0}
.spawn-toggle{padding:6px 16px;font-size:11px;font-weight:600;color:var(--orange);cursor:pointer;display:flex;align-items:center;gap:6px}
.spawn-toggle:hover{background:var(--surface2)}
.spawn-form{display:none;padding:8px 16px;gap:8px;align-items:flex-end;flex-wrap:wrap}
.spawn-form.open{display:flex}
.spawn-field{display:flex;flex-direction:column;gap:2px}
.spawn-field label{font-size:9px;text-transform:uppercase;color:var(--muted);font-weight:700}
.spawn-field input,.spawn-field select,.spawn-field textarea{background:var(--surface2);border:1px solid var(--border);border-radius:4px;color:var(--text);font-family:inherit;font-size:11px;padding:4px 8px}
.spawn-field textarea{min-height:32px;resize:vertical}
.spawn-field input:focus,.spawn-field select:focus,.spawn-field textarea:focus{outline:none;border-color:var(--accent)}
.spawn-go{background:var(--orange);color:var(--bg);border:none;border-radius:4px;padding:6px 14px;font-weight:700;font-size:11px;cursor:pointer;align-self:flex-end}
.spawn-go:hover{filter:brightness(1.15)}

/* scrollbars */
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<header>
  <span id="dot"></span>
  <h1>WikiChat Cockpit</h1>
  <span class="pill green" id="s-count">0 sessions</span>
  <span class="pill blue" id="m-count">0 messages</span>
  <span class="sep">&middot;</span>
  <span class="pill" id="reg-count">0 enregistr&eacute;s</span>
  <span class="uptime" id="uptime"></span>
</header>
<div class="body">
  <!-- SIDEBAR -->
  <div class="sidebar">
    <div class="panel grow" id="pane-sessions">
      <h2>Agents <span id="s-num">0</span></h2>
      <div id="sessions-list"></div>
    </div>
    <div class="panel" style="max-height:150px">
      <h2>Canaux</h2>
      <div id="channels-list"></div>
    </div>
    <div class="panel" style="max-height:200px;overflow-y:auto">
      <h2>Projets <span id="p-num">0</span></h2>
      <div id="projects-list"></div>
    </div>
  </div>

  <!-- CHAT PANEL -->
  <div class="chat-panel">
    <div class="chat-tabs" id="chat-tabs">
      <div class="chat-tab active" data-channel="general">#general</div>
      <div class="chat-tab" data-channel="coordination">#coordination</div>
    </div>
    <div class="chat-messages" id="chat-messages">
      <div class="empty-chat">S&eacute;lectionnez un canal et commencez &agrave; discuter...</div>
    </div>
    <div class="chat-input-wrap">
      <textarea class="chat-input" id="chat-input" rows="1" placeholder="Envoyer un message..."></textarea>
      <button class="chat-send" id="chat-send">Envoyer</button>
    </div>
  </div>

  <!-- ACTIVITY FEED -->
  <div class="activity">
    <div class="activity-header">
      <h2 style="margin:0">Activit&eacute;</h2>
      <div class="activity-filters">
        <button class="af-btn active" data-filter="all">Tout</button>
        <button class="af-btn" data-filter="spawn">Spawns</button>
        <button class="af-btn" data-filter="artifact">Artifacts</button>
        <button class="af-btn" data-filter="error">Erreurs</button>
      </div>
    </div>
    <div class="activity-body" id="activity-body"></div>
  </div>
</div>

<!-- SPAWN BAR -->
<div class="spawn-bar">
  <div class="spawn-toggle" id="spawn-toggle">&#x1f680; Spawn Agent</div>
  <div class="spawn-form" id="spawn-form">
    <div class="spawn-field">
      <label>Projet</label>
      <select id="sp-project" style="width:220px">
        <option value="">Chargement...</option>
      </select>
    </div>
    <div class="spawn-field">
      <label>Nom</label>
      <input id="sp-name" placeholder="Agent-Audit" style="width:120px">
    </div>
    <div class="spawn-field">
      <label>R&ocirc;le</label>
      <input id="sp-role" placeholder="auditeur" style="width:100px">
    </div>
    <div class="spawn-field">
      <label>Mode</label>
      <select id="sp-mode">
        <option value="daemon">&#x1f7e2; Daemon (persistant)</option>
        <option value="headless">&#x26a1; Headless (one-shot)</option>
      </select>
    </div>
    <div class="spawn-field">
      <label>Mod&egrave;le</label>
      <select id="sp-model">
        <option value="haiku">Haiku (rapide)</option>
        <option value="sonnet">Sonnet (&#x00e9;quilibr&#x00e9;)</option>
        <option value="opus">Opus (puissant)</option>
      </select>
    </div>
    <div class="spawn-field" style="flex:1">
      <label>T&acirc;che</label>
      <textarea id="sp-task" placeholder="D&eacute;cris la mission de l'agent..." style="width:100%"></textarea>
    </div>
    <button class="spawn-go" id="spawn-go">&#x1f680; Lancer</button>
  </div>
</div>

<script>
// ── State ──
let DATA = null;
let activeChannel = 'general';
let openTabs = ['general', 'coordination'];
let pilotName = 'Pilot';
let activityFilter = 'all';

const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

// ── Chat tab management ──
function openTab(channel) {
  if (!openTabs.includes(channel)) openTabs.push(channel);
  activeChannel = channel;
  renderTabs();
  renderChat();
}

function closeTab(channel) {
  openTabs = openTabs.filter(c => c !== channel);
  if (activeChannel === channel) {
    activeChannel = openTabs[0] || 'general';
    if (!openTabs.includes(activeChannel)) openTabs.unshift(activeChannel);
  }
  renderTabs();
  renderChat();
}

function renderTabs() {
  const el = document.getElementById('chat-tabs');
  el.innerHTML = openTabs.map(ch => {
    const isActive = ch === activeChannel;
    const label = ch.startsWith('dm:') ? '\\u{1f4e9} ' + ch.replace('dm:','').replace(/-/g,' \\u2194 ') : '#' + esc(ch);
    const closable = ch !== 'general';
    return '<div class="chat-tab' + (isActive ? ' active' : '') + '" data-channel="' + esc(ch) + '">'
      + label
      + (closable ? ' <span class="close" data-close="' + esc(ch) + '">&times;</span>' : '')
      + '</div>';
  }).join('');
}

// ── Chat rendering ──
function renderChat() {
  if (!DATA) return;
  const el = document.getElementById('chat-messages');
  const msgs = DATA.recentMessages.filter(m => m.channel === activeChannel);
  if (msgs.length === 0) {
    el.innerHTML = '<div class="empty-chat">Aucun message sur #' + esc(activeChannel) + '</div>';
    return;
  }
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = msgs.map(m => {
    const fromClass = m.from === 'Pilot' || m.from === pilotName ? 'pilot' : m.isSystem ? 'system' : 'agent';
    const bodyClass = m.isSystem ? 'system' : m.isArtifact ? 'artifact' : '';
    return '<div class="cm">'
      + '<div class="cm-head">'
      + '<span class="cm-time">' + esc(m.ts) + '</span>'
      + '<span class="cm-from ' + fromClass + '">' + esc(m.from) + '</span>'
      + '</div>'
      + '<div class="cm-body ' + bodyClass + '">' + esc(m.content) + '</div>'
      + '</div>';
  }).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ── Send message ──
async function sendChat() {
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  input.style.height = 'auto';

  // If chatting with a specific agent, try /api/sample for direct response
  const dmAgent = activeChannel.startsWith('dm:')
    ? activeChannel.replace('dm:','').split('-').find(n => n !== pilotName && n !== 'Pilot')
    : null;

  // Always post to chat (so it appears in the feed)
  const channel = dmAgent ? '@' + dmAgent : activeChannel;
  try {
    await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: pilotName, channel, content }),
    });
  } catch (e) { console.error('Chat send failed:', e); }

  // Additionally, try sampling the agent directly for faster response
  if (dmAgent) {
    try {
      const res = await fetch('/api/sample', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionName: dmAgent,
          prompt: content,
          context: { from: pilotName, channel: activeChannel },
        }),
      });
      const data = await res.json();
      if (data.mode === 'sampling' && data.result?.content) {
        // Post the agent's response back to chat
        const reply = typeof data.result.content === 'string'
          ? data.result.content
          : data.result.content?.text || JSON.stringify(data.result.content);
        await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: dmAgent, channel, content: reply }),
        });
      }
    } catch { /* fallback: agent will respond via poll_messages */ }
  }
}

// ── Sidebar rendering ──
function avail(s) {
  if (!s.registered) return '<span class="badge unregistered">?</span>';
  return '<span class="badge ' + (s.availability || 'idle') + '">' + (s.availability || 'idle') + '</span>';
}

function renderSessions() {
  if (!DATA) return;
  const el = document.getElementById('sessions-list');
  document.getElementById('s-num').textContent = DATA.sessions.length;
  const sorted = [...DATA.sessions].sort((a,b) => (b.registered?1:0)-(a.registered?1:0));
  if (!sorted.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;font-style:italic">Aucun agent</div>'; return; }
  el.innerHTML = sorted.map(s => {
    return '<div class="session' + (s.registered ? '' : ' unregistered') + '" data-agent="' + esc(s.name) + '">'
      + '<div class="s-head">'
      + '<span class="s-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>'
      + avail(s)
      + '</div>'
      + (s.role ? '<div class="s-role">' + esc(s.role) + '</div>' : '')
      + (s.status ? '<div class="s-status">' + esc(s.status) + '</div>' : '')
      + '<div class="s-actions">'
      + '<button class="s-btn chat" data-dm="' + esc(s.name) + '">\\u{1f4ac} Chat</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

function renderChannels() {
  if (!DATA) return;
  const el = document.getElementById('channels-list');
  el.innerHTML = DATA.channels.map(c =>
    '<div class="ch' + (c.name === activeChannel ? ' active' : '') + '" data-channel="' + esc(c.name) + '">'
    + '<span class="ch-name' + (c.isSystem ? ' sys' : '') + '">#' + esc(c.name) + '</span>'
    + '<span class="ch-count' + (c.count ? ' active' : '') + '">' + c.count + '</span>'
    + '</div>'
  ).join('');
}

function renderProjects() {
  if (!DATA) return;
  const el = document.getElementById('projects-list');
  document.getElementById('p-num').textContent = DATA.projects.length;
  if (!DATA.projects.length) { el.innerHTML = '<div style="color:var(--muted);font-size:11px;font-style:italic">Aucun projet</div>'; return; }
  el.innerHTML = DATA.projects.map(p => {
    const tags = [];
    if (p.activeTasks) tags.push('<span class="p-tag tasks">' + p.activeTasks + ' actif</span>');
    if (p.agents?.length) tags.push('<span class="p-tag agents">\\u{1f464} ' + esc(p.agents.join(', ')) + '</span>');
    if (p.blockers) tags.push('<span class="p-tag blockers">\\u{1f534} ' + p.blockers + '</span>');
    return '<div class="project">'
      + '<div style="display:flex;justify-content:space-between;align-items:center">'
      + '<div class="p-name">' + esc(p.name) + '</div>'
      + '<button class="p-spawn-btn" data-project="' + esc(p.name) + '">\\u{1f680}</button>'
      + '</div>'
      + (p.description ? '<div class="p-desc">' + esc(p.description) + '</div>' : '')
      + (tags.length ? '<div class="p-meta">' + tags.join('') + '</div>' : '')
      + '</div>';
  }).join('');
}

// ── Activity feed ──
function classifyActivity(m) {
  if (m.content?.includes('\\u{1f680}') || m.content?.includes('lancé') || m.content?.includes('spawn')) return 'spawn';
  if (m.isArtifact || m.content?.includes('\\u{1f4ce}') || m.content?.includes('artifact')) return 'artifact';
  if (m.content?.includes('\\u274c') || m.content?.includes('échec') || m.content?.includes('failed') || m.content?.includes('error')) return 'error';
  if (m.isSystem) return 'system';
  return 'message';
}

function renderActivity() {
  if (!DATA) return;
  const el = document.getElementById('activity-body');
  let msgs = [...DATA.recentMessages].reverse();
  if (activityFilter !== 'all') {
    msgs = msgs.filter(m => classifyActivity(m) === activityFilter);
  }
  if (!msgs.length) { el.innerHTML = '<div style="color:var(--muted);font-style:italic;padding:20px;text-align:center">Aucune activit&eacute;</div>'; return; }
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = msgs.slice(0, 50).map(m => {
    const cls = classifyActivity(m);
    return '<div class="act ' + cls + '">'
      + '<span class="act-time">' + esc(m.ts) + '</span> '
      + '<span class="act-ch">#' + esc(m.channel) + '</span> '
      + '<span class="act-from">' + esc(m.from) + '</span>'
      + '<div class="act-body">' + esc(m.content?.slice(0, 200)) + '</div>'
      + '</div>';
  }).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

// ── Spawn ──
async function spawnAgent() {
  const project = document.getElementById('sp-project').value.trim();
  const name = document.getElementById('sp-name').value.trim();
  const role = document.getElementById('sp-role').value.trim();
  const task = document.getElementById('sp-task').value.trim();
  const mode = document.getElementById('sp-mode').value;
  if (!project || !name) { alert('Projet et nom requis'); return; }

  const model = document.getElementById('sp-model').value;
  const endpoint = mode === 'daemon' ? '/api/spawn/daemon' : '/api/spawn/headless';
  const body = mode === 'daemon'
    ? { projectPath: project, name, role, task: task || undefined, model }
    : { projectPath: project, name, role, prompt: task || undefined };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) alert('Erreur: ' + data.error);
    else {
      document.getElementById('sp-name').value = '';
      document.getElementById('sp-task').value = '';
    }
  } catch (e) { alert('Spawn failed: ' + e.message); }
}

// ── Main render ──
function render(d) {
  DATA = d;

  // Header
  document.getElementById('s-count').textContent = d.stats.totalSessions + ' session' + (d.stats.totalSessions !== 1 ? 's' : '');
  document.getElementById('m-count').textContent = d.stats.totalMessages + ' message' + (d.stats.totalMessages !== 1 ? 's' : '');
  document.getElementById('reg-count').textContent = d.stats.registered + ' enregistr\\u00e9' + (d.stats.registered !== 1 ? 's' : '');
  const h = Math.floor(d.stats.uptime / 3600), m = Math.floor((d.stats.uptime % 3600) / 60);
  document.getElementById('uptime').textContent = 'uptime: ' + h + 'h' + String(m).padStart(2, '0') + 'min';

  renderSessions();
  renderChannels();
  renderProjects();
  renderChat();
  renderActivity();
}

// ── Event handlers ──

// Tab clicks
document.getElementById('chat-tabs').addEventListener('click', e => {
  const close = e.target.closest('[data-close]');
  if (close) { closeTab(close.dataset.close); return; }
  const tab = e.target.closest('[data-channel]');
  if (tab) { activeChannel = tab.dataset.channel; renderTabs(); renderChat(); renderChannels(); }
});

// Channel clicks in sidebar
document.getElementById('channels-list').addEventListener('click', e => {
  const ch = e.target.closest('[data-channel]');
  if (ch) openTab(ch.dataset.channel);
});

// Session DM click
document.getElementById('pane-sessions').addEventListener('click', e => {
  const btn = e.target.closest('[data-dm]');
  if (btn) {
    const name = btn.dataset.dm;
    const dmChannel = 'dm:' + [pilotName, name].sort().join('-');
    openTab(dmChannel);
  }
});

// Chat input
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
});
document.getElementById('chat-send').addEventListener('click', sendChat);

// Auto-resize textarea
document.getElementById('chat-input').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 100) + 'px';
});

// Spawn bar
document.getElementById('spawn-toggle').addEventListener('click', () => {
  document.getElementById('spawn-form').classList.toggle('open');
});
document.getElementById('spawn-go').addEventListener('click', spawnAgent);

// Quick spawn from project card
document.getElementById('projects-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-project]');
  if (!btn) return;
  const projectName = btn.dataset.project;
  // Open spawn bar and pre-select the project
  document.getElementById('spawn-form').classList.add('open');
  const sel = document.getElementById('sp-project');
  for (const opt of sel.options) {
    if (opt.text === projectName) { sel.value = opt.value; break; }
  }
  document.getElementById('sp-name').focus();
});

// Activity filters
document.querySelector('.activity-filters').addEventListener('click', e => {
  const btn = e.target.closest('[data-filter]');
  if (!btn) return;
  document.querySelectorAll('.af-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activityFilter = btn.dataset.filter;
  renderActivity();
});

// ── Load projects for spawn selector ──
(async function loadProjects() {
  try {
    const res = await fetch('/api/projects');
    const data = await res.json();
    const sel = document.getElementById('sp-project');
    const projects = (data.projects || [])
      .filter(p => p.path && p.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = '<option value="">-- S\\u00e9lectionner --</option>'
      + projects.map(p =>
        '<option value="' + esc(p.path.replace(/\\\\/g, '/')) + '">' + esc(p.name) + '</option>'
      ).join('');
  } catch (e) { console.error('Failed to load projects:', e); }
})();

// ── SSE with delta support ──
const dot = document.getElementById('dot');
const es = new EventSource('/dashboard/events');
es.onmessage = e => {
  dot.className = '';
  const d = JSON.parse(e.data);
  if (d.type === 'delta' && DATA) {
    // Apply delta to existing data
    if (d.newMessages) {
      const existingIds = new Set(DATA.recentMessages.map(m => m.id));
      for (const m of d.newMessages) {
        if (!existingIds.has(m.id)) DATA.recentMessages.push(m);
      }
      // Keep last 80
      if (DATA.recentMessages.length > 80) DATA.recentMessages = DATA.recentMessages.slice(-80);
    }
    if (d.sessionsJoined) {
      for (const s of d.sessionsJoined) {
        if (!DATA.sessions.find(x => x.name === s.name)) DATA.sessions.push(s);
      }
    }
    if (d.sessionsLeft) {
      DATA.sessions = DATA.sessions.filter(s => !d.sessionsLeft.includes(s.name));
    }
    if (d.stats) DATA.stats = d.stats;
    if (d.channels) DATA.channels = d.channels;
    renderSessions(); renderChannels(); renderChat(); renderActivity();
    // Update header stats
    document.getElementById('s-count').textContent = DATA.stats.totalSessions + ' session' + (DATA.stats.totalSessions !== 1 ? 's' : '');
    document.getElementById('m-count').textContent = DATA.stats.totalMessages + ' message' + (DATA.stats.totalMessages !== 1 ? 's' : '');
  } else {
    render(d);
  }
};
es.onerror = () => {
  dot.className = 'off';
  // Show reconnecting banner
  const header = document.querySelector('header');
  if (!document.getElementById('reconnect-banner')) {
    const banner = document.createElement('div');
    banner.id = 'reconnect-banner';
    banner.style.cssText = 'background:var(--red);color:white;text-align:center;padding:4px;font-size:11px;font-weight:600';
    banner.textContent = 'Connexion perdue \\u2014 reconnexion auto...';
    header.after(banner);
  }
};

// Auto-reconnect: EventSource reconnects automatically,
// clear banner when connection restores
setInterval(() => {
  if (es.readyState === 1) { // OPEN
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.remove();
  }
}, 2000);
</script>
</body>
</html>`;
