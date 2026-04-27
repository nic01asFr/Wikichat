/**
 * cockpit.mjs — Phase 6 cockpit, 5-panneaux + drill-downs.
 *
 * Routes:
 *   GET /cockpit            → main page
 *   GET /cockpit/data       → JSON snapshot of all panels
 *   GET /cockpit/events     → SSE stream of incremental updates
 *   GET /cockpit/agent/:name    → drill-down agent inspector
 *   GET /cockpit/routine/:id    → drill-down routine inspector
 *   GET /cockpit/decisions  → decisions log filtered view
 *
 * Designed to be lightweight : pure HTML+JS, no framework. SSE for live.
 */

import { state, getChannelCount } from "./state.mjs";
import { listRoutines, getRoutine } from "./routines.mjs";
import { listTriggers } from "./triggers.mjs";
import { readDispatchLog, getRecord as getDispatchRecord } from "./dispatch.mjs";
import { status as dormantStatus } from "./dormant.mjs";
import { currentLoad, quotaSnapshot } from "./sampler.mjs";
import { recall } from "./identity.mjs";
import { loadSnapshot, loadSpawnRegistry } from "./persistence.mjs";

const _sseClients = new Set();

function _snapshot(_sessionIdSelf) {
  const sessions = [...state.sessions.values()].map(s => ({
    name: s.name, role: s.role, agent_type: s.agent_type,
    availability: s.availability, current_task: s.current_task,
    current_project: s.current_project, lastSeen: s.lastSeen,
  }));
  const registered = sessions.filter(s => s.name && !s.name.startsWith("session-"));

  // Mentions for the principal (and unread approximations)
  const principal = process.env.WIKICHAT_PRINCIPAL_AGENT || "Claude-Code";
  const mentionRx = new RegExp(`@${principal}`, "i");
  const since30min = Date.now() - 30 * 60 * 1000;
  const mentions = state.messages
    .filter(m => mentionRx.test(m.content) && new Date(m.timestamp).getTime() > since30min)
    .slice(-10)
    .map(m => ({ id: m.id, time: m.timestamp, channel: m.channel, from: m.fromName, content: m.content.slice(0, 200) }));

  // Decisions log
  const decisions = state.messages
    .filter(m => m.channel === "decisions")
    .slice(-10)
    .map(m => ({ id: m.id, time: m.timestamp, from: m.fromName, content: m.content.slice(0, 300) }));

  // Timeline (last 30 messages, all channels visible)
  const timeline = state.messages.slice(-30).map(m => ({
    id: m.id, time: m.timestamp, channel: m.channel || "(dm)", from: m.fromName, content: m.content.slice(0, 200),
  }));

  // Routines + Triggers + Dispatch log
  const routines = listRoutines().map(r => ({
    id: r.id, description: r.description, steps: r.steps?.length, run_count: r.run_count,
    last_run_at: r.last_run_at, last_run_status: r.last_run_status, enabled: r.enabled,
  }));
  const triggers = listTriggers().map(t => ({
    id: t.id, type: t.type, description: t.description, enabled: t.enabled,
    last_fired: t.last_fired, fire_count: t.fire_count,
  }));
  const dispatchLog = readDispatchLog(10);

  // Health
  const max = parseInt(process.env.WIKICHAT_MAX_SESSIONS || "10");

  return {
    server: { time: new Date().toISOString(), uptime_s: Math.round(process.uptime()) },
    dormant: dormantStatus(),
    health: { sessions: state.sessions.size, registered: registered.length, channels: state.channels.size, messages: state.messages.length, budget: { current: currentLoad(), max } },
    quotas: quotaSnapshot(),
    sessions: registered,
    mentions,
    decisions,
    timeline,
    routines,
    triggers,
    dispatch: dispatchLog,
    projects: [...state.projects.values()].map(p => ({ name: p.name, slug: p.slug, tasks: p.tasks?.size ?? 0 })),
    channels: [...state.channels.entries()].filter(([n]) => !n.startsWith("dm:")).map(([n, c]) => ({ name: n, description: c.description, count: getChannelCount(n) })),
  };
}

export function handleCockpitPage(_req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(_html());
}

export function handleCockpitData(_req, res) {
  res.json(_snapshot());
}

export function handleCockpitEvents(req, res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  const send = () => {
    try { res.write(`data: ${JSON.stringify(_snapshot())}\n\n`); } catch { /* */ }
  };
  send();
  const hb = setInterval(send, 5000);
  _sseClients.add(res);
  req.on("close", () => { clearInterval(hb); _sseClients.delete(res); });
}

/** Push update to all SSE clients (debounced upstream). */
export function pushCockpitUpdate() {
  const payload = `data: ${JSON.stringify(_snapshot())}\n\n`;
  for (const r of _sseClients) {
    try { r.write(payload); } catch { _sseClients.delete(r); }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down handlers
// ─────────────────────────────────────────────────────────────────────────────

export function handleAgentInspector(req, res) {
  const name = req.params.name;
  const live = [...state.sessions.values()].find(s => s.name === name);
  const snapshot = loadSnapshot(name);
  const memories = recall(name) || {};
  const spawned = loadSpawnRegistry().filter(e => e.name === name);
  const trackRecord = getDispatchRecord()[name] || {};
  const messages = state.messages.filter(m => m.fromName === name).slice(-30);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(_drillHtml(`Agent: ${name}`, [
    _section("Live status", live ? [
      `<div><strong>Status:</strong> ${live.availability || "—"}</div>`,
      `<div><strong>Role:</strong> ${live.role || "—"}</div>`,
      `<div><strong>Type:</strong> ${live.agent_type || "—"}</div>`,
      `<div><strong>Project:</strong> ${live.current_project || "—"}</div>`,
      `<div><strong>Task:</strong> ${live.current_task || "—"}</div>`,
      `<div><strong>Last seen:</strong> ${live.lastSeen || "—"}</div>`,
    ] : ['<div class="muted">⚫ Agent not currently connected.</div>']),
    snapshot ? _section("Last snapshot", [
      `<div class="muted">Saved: ${snapshot.savedAt}</div>`,
      `<div><strong>Skills:</strong> ${(snapshot.skills || []).join(", ") || "—"}</div>`,
      `<div><strong>Last interlocutors:</strong> ${(snapshot.last_interlocutors || []).join(", ") || "—"}</div>`,
    ]) : "",
    _section(`Memories (${Object.keys(memories).length})`,
      Object.keys(memories).length === 0 ? ['<div class="muted">(empty)</div>'] :
      Object.entries(memories).map(([k, v]) => `<div class="row"><strong>${_esc(k)}</strong>: ${_esc(String(v).slice(0, 200))}</div>`)
    ),
    _section("Track record (dispatch)",
      Object.keys(trackRecord).length === 0 ? ['<div class="muted">(no record yet)</div>'] :
      Object.entries(trackRecord).map(([cap, st]) => `<div class="row"><span>${_esc(cap)}</span><span>✓ ${st.ok || 0} / ✗ ${st.fail || 0}</span></div>`)
    ),
    _section(`Spawn registry entries (${spawned.length})`,
      spawned.length === 0 ? ['<div class="muted">(no spawns)</div>'] :
      spawned.map(e => `<div class="row tiny"><span>${e.mode || "?"} • ${e.spawned_by || "?"}</span><span class="muted">${e.status || "?"} • ${e.spawned_at?.slice(0, 19) || "?"}</span></div>`)
    ),
    _section(`Recent messages (${messages.length})`,
      messages.length === 0 ? ['<div class="muted">(none)</div>'] :
      messages.slice().reverse().map(m => `<div class="item"><span class="tag">${m.channel || "dm"}</span>${_esc(m.content.slice(0, 200))}<div class="tiny muted">${m.timestamp}</div></div>`)
    ),
  ]));
}

export function handleRoutineInspector(req, res) {
  const id = req.params.id;
  const r = getRoutine(id);
  if (!r) { res.status(404).send(_drillHtml(id, [`<div class="panel">Routine not found.</div>`])); return; }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(_drillHtml(`Routine: ${id}`, [
    _section("Definition", [
      `<div><strong>Description:</strong> ${_esc(r.description || "—")}</div>`,
      `<div><strong>Steps:</strong> ${r.steps?.length || 0}</div>`,
      `<div><strong>Cache:</strong> ${r.cache_seconds || 0}s</div>`,
      `<div><strong>Created:</strong> ${r.created_at}</div>`,
      `<div><strong>Updated:</strong> ${r.updated_at}</div>`,
    ]),
    _section("Stats", [
      `<div><strong>Run count:</strong> ${r.run_count || 0}</div>`,
      `<div><strong>Last run:</strong> ${r.last_run_at || "never"}</div>`,
      `<div><strong>Last status:</strong> ${r.last_run_status || "—"}</div>`,
      `<div><strong>Enabled:</strong> ${r.enabled ? "yes" : "no"}</div>`,
    ]),
    _section("Steps", (r.steps || []).map((s, i) =>
      `<div class="item"><strong>step ${i}: ${_esc(s.action)}</strong><pre style="margin:4px 0 0;font-size:11px">${_esc(JSON.stringify(s.params, null, 2))}</pre></div>`
    )),
    _section("Run", [
      `<div class="dispatch-form">`,
      `<input id="routine-params" placeholder='Params JSON (ex: {"project":"panoramax3d"})' />`,
      `<button onclick="runRoutine('${_esc(id)}')">Run</button>`,
      `</div><div id="routine-result" class="tiny muted" style="margin-top:8px"></div>`,
      `<script>
async function runRoutine(routineId) {
  const params = document.getElementById('routine-params').value.trim();
  let parsed = {};
  if (params) { try { parsed = JSON.parse(params); } catch (e) { document.getElementById('routine-result').textContent = '❌ JSON invalide'; return; } }
  document.getElementById('routine-result').textContent = '...';
  try {
    const r = await fetch('/api/routines/run', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id:routineId, params:parsed}) });
    const j = await r.json();
    document.getElementById('routine-result').textContent = JSON.stringify(j).slice(0, 500);
  } catch(e) { document.getElementById('routine-result').textContent = '❌ ' + e.message; }
}
</script>`,
    ]),
  ]));
}

export function handleProjectView(req, res) {
  const slug = req.params.slug;
  const project = state.projects.get(slug) || [...state.projects.values()].find(p => p.slug === slug);
  if (!project) { res.status(404).send(_drillHtml(slug, [`<div class="panel">Project not found.</div>`])); return; }

  const activeAgents = [...state.sessions.values()].filter(s => s.current_project?.toLowerCase() === project.name.toLowerCase());
  const tasks = [...(project.tasks?.values() || [])];
  const projectMessages = state.messages.filter(m =>
    String(m.content).toLowerCase().includes(project.name.toLowerCase()) ||
    String(m.content).toLowerCase().includes(project.slug || "")
  ).slice(-20);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(_drillHtml(`Project: ${project.name}`, [
    _section("Info", [
      `<div><strong>Slug:</strong> ${project.slug || "—"}</div>`,
      `<div><strong>Path:</strong> <code>${_esc(project.path || "—")}</code></div>`,
      `<div><strong>Status:</strong> ${project.status || "—"}</div>`,
      project.tags?.length ? `<div><strong>Tags:</strong> ${project.tags.join(", ")}</div>` : "",
    ]),
    _section(`Active agents (${activeAgents.length})`,
      activeAgents.length === 0 ? ['<div class="muted">(none working on this project)</div>'] :
      activeAgents.map(a => `<div class="row"><a href="/cockpit/agent/${_esc(a.name)}">${_esc(a.name)}</a><span class="muted">${a.role || ""} ${a.current_task ? "• " + _esc(a.current_task) : ""}</span></div>`)
    ),
    _section(`Tasks (${tasks.length})`,
      tasks.length === 0 ? ['<div class="muted">(none)</div>'] :
      tasks.map(t => `<div class="row"><span>${_esc(t.id || "?")} <span class="muted">— ${_esc(t.description || "")}</span></span><span class="muted">${t.status || "?"}${t.claimedBy ? " • " + _esc(t.claimedBy) : ""}</span></div>`)
    ),
    _section(`Mentions in messages (${projectMessages.length})`,
      projectMessages.length === 0 ? ['<div class="muted">(none)</div>'] :
      projectMessages.slice().reverse().map(m => `<div class="item"><span class="tag">${m.channel || "dm"}</span><strong>${m.fromName}</strong>: ${_esc(m.content.slice(0, 200))}<div class="tiny muted">${m.timestamp}</div></div>`)
    ),
  ]));
}

export function handleDecisionsLog(_req, res) {
  const decisions = state.messages.filter(m => m.channel === "decisions").slice(-100);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(_drillHtml("Decisions log", [
    _section(`${decisions.length} decisions`,
      decisions.length === 0 ? ['<div class="muted">(none)</div>'] :
      decisions.slice().reverse().map(m => `<div class="item"><strong>${m.fromName}</strong> <span class="tiny muted">${m.timestamp}</span><div style="margin-top:4px">${_esc(m.content)}</div></div>`)
    ),
  ]));
}

// HTML helpers
function _esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function _section(title, contentArr) {
  return `<div class="panel"><h2>${_esc(title)}</h2>${(contentArr || []).join("")}</div>`;
}
function _drillHtml(title, panels) {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>${_esc(title)} — WikiChat</title>
<style>
:root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#c9d1d9; --muted:#8b949e; --accent:#58a6ff; }
* { box-sizing: border-box; }
body { margin:0; padding:14px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { display:flex; justify-content:space-between; align-items:baseline; padding-bottom:12px; border-bottom:1px solid var(--border); margin-bottom:14px; }
header h1 { font-size:18px; margin:0; font-weight:600; }
.panel { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:12px; margin-bottom:12px; }
.panel h2 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0 0 8px; }
.row { display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px dashed var(--border); }
.row:last-child { border-bottom:none; }
.muted { color: var(--muted); }
.tiny { font-size:11px; }
.item { padding:6px 0; border-bottom:1px dashed var(--border); }
.tag { display:inline-block; padding:1px 6px; border-radius:3px; background:var(--bg); border:1px solid var(--border); font-size:10px; color:var(--muted); margin-right:6px; }
button { background:var(--accent); color:#fff; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:12px; }
input { background:var(--bg); border:1px solid var(--border); color:var(--text); padding:5px 8px; border-radius:4px; font-size:12px; flex:1; }
.dispatch-form { display:flex; gap:6px; }
a { color: var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); padding:2px 4px; border-radius:3px; font-size:12px; }
pre { padding: 8px; overflow-x: auto; }
</style>
</head>
<body>
<header>
  <h1>${_esc(title)}</h1>
  <a href="/cockpit">← Cockpit</a>
</header>
${panels.join("\n")}
</body>
</html>`;
}

function _html() {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>WikiChat — Cockpit</title>
<style>
:root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --text:#c9d1d9; --muted:#8b949e; --accent:#58a6ff; --green:#3fb950; --orange:#d29922; --red:#f85149; }
* { box-sizing: border-box; }
body { margin:0; padding:14px; font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); }
header { display:flex; justify-content:space-between; align-items:baseline; padding-bottom:12px; border-bottom:1px solid var(--border); margin-bottom:14px; }
header h1 { font-size:18px; margin:0; font-weight:600; }
.status { font-size:12px; color:var(--muted); }
.status .pill { padding:2px 8px; border-radius:10px; background:var(--panel); border:1px solid var(--border); margin-left:6px; }
.pill.green { color: var(--green); border-color: var(--green); }
.pill.orange { color: var(--orange); border-color: var(--orange); }
.pill.red { color: var(--red); border-color: var(--red); }
.grid { display:grid; grid-template-columns: 1fr 2fr; gap:12px; }
.col { display:grid; gap:12px; }
.panel { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:12px; }
.panel h2 { font-size:12px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0 0 8px; }
.row { display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px dashed var(--border); }
.row:last-child { border-bottom:none; }
.muted { color: var(--muted); }
.tiny { font-size:11px; }
.list { max-height:280px; overflow-y:auto; font-size:12px; }
.list .item { padding:6px 0; border-bottom:1px dashed var(--border); }
.tag { display:inline-block; padding:1px 6px; border-radius:3px; background:var(--bg); border:1px solid var(--border); font-size:10px; color:var(--muted); margin-right:6px; }
button { background:var(--accent); color:#fff; border:none; padding:5px 12px; border-radius:4px; cursor:pointer; font-size:12px; }
button:hover { opacity:.85; }
input, textarea { background:var(--bg); border:1px solid var(--border); color:var(--text); padding:5px 8px; border-radius:4px; font-size:12px; }
input { width:100%; }
a { color: var(--accent); text-decoration:none; }
a:hover { text-decoration:underline; }
.dispatch-form { display:flex; gap:6px; margin-top:6px; }
.dispatch-form input { flex:1; }
</style>
</head>
<body>
<header>
  <h1>WikiChat — Cockpit</h1>
  <div class="status" id="header-status">connecting…</div>
</header>

<div class="grid">
  <!-- LEFT COLUMN -->
  <div class="col">
    <div class="panel">
      <h2>Inbox</h2>
      <div id="mentions" class="list"></div>
    </div>
    <div class="panel">
      <h2>État machine</h2>
      <div id="machine"></div>
    </div>
    <div class="panel">
      <h2>Dispatch</h2>
      <div class="dispatch-form">
        <input id="dispatch-intent" placeholder="Intent (ex: review ce diff)" />
        <button onclick="sendDispatch()">Send</button>
      </div>
      <div id="dispatch-last" class="tiny muted" style="margin-top:8px"></div>
      <div id="dispatch-log" class="list" style="margin-top:8px"></div>
    </div>
  </div>

  <!-- RIGHT COLUMN -->
  <div class="col">
    <div class="panel">
      <h2>Timeline live</h2>
      <div id="timeline" class="list" style="max-height:320px"></div>
    </div>
    <div class="panel">
      <h2>Routines</h2>
      <div id="routines" class="list"></div>
    </div>
    <div class="panel">
      <h2>Triggers</h2>
      <div id="triggers" class="list"></div>
    </div>
  </div>
</div>

<script>
const fmtTime = ts => new Date(ts).toLocaleTimeString("fr-FR");

function render(d) {
  const dor = d.dormant;
  const dorClass = dor.active ? "green" : (dor.inGracePeriod ? "orange" : "red");
  const dorLabel = dor.active ? "🟢 ACTIVE" : (dor.inGracePeriod ? "🟠 grâce" : "💤 dormant");
  const budget = d.health.budget;
  const budClass = budget.current >= budget.max ? "red" : (budget.current > budget.max * 0.7 ? "orange" : "green");
  document.getElementById("header-status").innerHTML =
    \`Maire: <strong>\${dor.principalName}</strong>\` +
    \`<span class="pill \${dorClass}">\${dorLabel}</span>\` +
    \`<span class="pill \${budClass}">budget \${budget.current}/\${budget.max}</span>\` +
    \`<span class="pill">uptime \${d.server.uptime_s}s</span>\`;

  const mentions = d.mentions.map(m =>
    \`<div class="item"><span class="tag">\${m.channel}</span><strong>\${m.from}</strong>: \${escapeHtml(m.content)}<div class="tiny muted">\${fmtTime(m.time)}</div></div>\`
  ).join("");
  document.getElementById("mentions").innerHTML = mentions || '<div class="muted tiny">(aucune mention récente)</div>';

  const machine = [
    \`<div class="row"><span>Sessions</span><strong>\${d.health.registered}/\${d.health.sessions}</strong></div>\`,
    \`<div class="row"><span>Channels</span><strong>\${d.health.channels}</strong></div>\`,
    \`<div class="row"><span>Messages</span><strong>\${d.health.messages}</strong></div>\`,
    \`<div class="row"><span>Projets</span><strong>\${d.projects.length}</strong></div>\`,
    \`<hr style="border:none;border-top:1px dashed var(--border);margin:8px 0">\`,
    ...d.sessions.slice(0, 8).map(s => \`<div class="row tiny"><span>\${s.name} <span class="muted">(\${s.role || "—"})</span></span><span class="muted">\${s.availability || "—"}</span></div>\`),
  ].join("");
  document.getElementById("machine").innerHTML = machine;

  const timeline = d.timeline.slice().reverse().map(m =>
    \`<div class="item"><span class="tag">\${m.channel}</span><strong>\${m.from}</strong>: \${escapeHtml(m.content)}<div class="tiny muted">\${fmtTime(m.time)}</div></div>\`
  ).join("");
  document.getElementById("timeline").innerHTML = timeline || '<div class="muted tiny">(aucun message)</div>';

  const routines = d.routines.map(r =>
    \`<div class="item"><span class="tag">\${r.steps} steps</span><a href="/cockpit/routine/\${r.id}"><strong>\${r.id}</strong></a><div class="tiny muted">\${r.description || ""} • run \${r.run_count}× \${r.last_run_at ? "• last " + fmtTime(r.last_run_at) : ""} • \${r.last_run_status || "-"}</div></div>\`
  ).join("");
  document.getElementById("routines").innerHTML = routines || '<div class="muted tiny">(aucune routine)</div>';

  const triggers = d.triggers.map(t =>
    \`<div class="item">\${t.enabled ? "🟢" : "⚫"} <span class="tag">\${t.type}</span><strong>\${t.id}</strong><div class="tiny muted">\${t.description || ""} • \${t.fire_count || 0}× • last \${t.last_fired ? fmtTime(t.last_fired) : "never"}</div></div>\`
  ).join("");
  document.getElementById("triggers").innerHTML = triggers || '<div class="muted tiny">(aucun trigger)</div>';

  const dlog = (d.dispatch || []).slice().reverse().map(x =>
    \`<div class="item tiny"><span class="tag">\${x.strategy}</span><strong>\${x.dispatch_id}</strong> → \${x.dispatched_to || "—"}<div class="muted">\${escapeHtml(String(x.intent || "").slice(0, 100))}</div></div>\`
  ).join("");
  document.getElementById("dispatch-log").innerHTML = dlog || '<div class="muted tiny">(aucun dispatch)</div>';
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function sendDispatch() {
  const input = document.getElementById("dispatch-intent");
  const intent = input.value.trim();
  if (!intent) return;
  document.getElementById("dispatch-last").textContent = "envoi…";
  try {
    const r = await fetch("/api/dispatch", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({intent}) });
    const j = await r.json();
    document.getElementById("dispatch-last").textContent = \`→ \${j.strategy}: \${j.dispatched_to || "—"} (id=\${j.dispatch_id})\`;
    input.value = "";
  } catch (err) {
    document.getElementById("dispatch-last").textContent = "❌ " + err.message;
  }
}

// SSE live
const es = new EventSource("/cockpit/events");
es.onmessage = (e) => {
  try { render(JSON.parse(e.data)); } catch {}
};
es.onerror = () => { document.getElementById("header-status").textContent = "⚠️ disconnected"; };
</script>
</body>
</html>`;
}
