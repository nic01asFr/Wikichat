#!/usr/bin/env node

/**
 * daemon-librarian.mjs
 *
 * Librarian Daemon — Background Knowledge Compilation
 * Runs permanently: register → declare capabilities → infinite polling loop
 */

import http from 'http';

const NAME = 'Librarian';
const ROLE = 'daemon-librarian';
const PORT = 3777;
const HOSTNAME = 'localhost';

let state = {
  sessionId: null,
  pollCount: 0,
  messageCount: 0,
  registered: false,
  sseStream: null
};

// ── SSE Connection ─────────────────────────────────────────────────────
async function connectSSE() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: HOSTNAME,
      port: PORT,
      path: '/sse',
      method: 'GET'
    }, (res) => {
      state.sseStream = res;
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const match = buffer.match(/sessionId=([a-f0-9-]+)/);
        if (match && !state.sessionId) {
          state.sessionId = match[1];
          console.log(`[SSE] Connected. SessionId: ${state.sessionId.substring(0, 8)}`);
          resolve(state.sessionId);
        }
      });
      res.on('end', () => {
        console.warn('[SSE] Stream closed, will reconnect...');
        state.sseStream = null;
        reject(new Error('SSE stream closed'));
      });
      res.on('error', (err) => {
        console.warn('[SSE] Stream error:', err.message);
        state.sseStream = null;
        reject(err);
      });
    });
    req.on('error', (err) => {
      console.warn('[SSE] Request error:', err.message);
      reject(err);
    });
    req.end();
    setTimeout(() => { if (!state.sessionId) reject(new Error('SSE timeout')); }, 5000);
  });
}

// ── Tool Calling ───────────────────────────────────────────────────────
function callTool(toolName, args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    });

    const req = http.request({
      hostname: HOSTNAME,
      port: PORT,
      path: `/messages?sessionId=${state.sessionId}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve({ error: data });
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Bootstrap ───────────────────────────────────────────────────────────
async function bootstrap() {
  console.log('[BOOT] Librarian bootstrap starting...');

  // Reconnect loop: SSE may fail/close, restart gracefully
  let bootCount = 0;
  while (true) {
    bootCount++;

    try {
      await connectSSE();
    } catch (err) {
      console.error(`[ERROR] SSE connection failed (attempt ${bootCount}): ${err.message}`);
      await new Promise(r => setTimeout(r, 5000 + Math.random() * 5000)); // backoff
      continue;
    }

    if (!state.registered) {
      console.log('[BOOT] Registering as daemon-librarian...');
      let res = await callTool('register', {
        name: NAME,
        role: ROLE,
        agent_type: 'daemon'
      });
      if (res.error && !res.error.includes('Accepted')) {
        console.error('[ERROR] Registration failed:', res.error);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      console.log('[BOOT] ✓ Registration complete');
      state.registered = true;

      console.log('[BOOT] Declaring capabilities...');
      await callTool('declare_capabilities', {
        skills: ['knowledge-compilation', 'cross-project-synthesis', 'pattern-extraction', 'artifact-absorption'],
        current_task: 'library-monitoring',
        availability: 'available'
      });
      console.log('[BOOT] ✓ Capabilities declared');

      console.log('[BOOT] Announcing presence...');
      await callTool('send_message', {
        channel: 'coordination',
        content: 'Librarian en ligne, pret.',
        status: 'standby'
      });
      console.log('[BOOT] ✓ Announcement sent\n');
    }

    // ── Polling Loop ────────────────────────────────────────
    console.log('[LOOP] Entering infinite polling loop...');
    let iterCount = 0;

    try {
      while (true) {
        iterCount++;
        state.pollCount++;

        const pollRes = await callTool('poll_messages', {
          channel: '__all__',
          timeout_seconds: 30,
          types: ['message', 'direct_message', 'broadcast', 'artifact'],
          since_minutes: 5
        });

        if (pollRes.result && Array.isArray(pollRes.result) && pollRes.result.length > 0) {
          state.messageCount += pollRes.result.length;
          console.log(`[POLL #${state.pollCount}] ${pollRes.result.length} message(s) (total: ${state.messageCount})`);

          // Brief summary of first few messages
          pollRes.result.slice(0, 2).forEach(msg => {
            const preview = msg.content ? msg.content.substring(0, 60) : '(no content)';
            console.log(`  - [${msg.sender || 'system'}@${msg.channel}] ${preview}`);
          });
        } else {
          // Quiet on timeout (no banner)
          if (iterCount % 10 === 0) {
            console.log(`[LOOP] ...${state.pollCount} polls, ${state.messageCount} messages so far`);
          }
        }
      }
    } catch (err) {
      console.error(`[ERROR] Poll loop error: ${err.message}. Reconnecting...`);
      state.sseStream = null;
      await new Promise(r => setTimeout(r, 2000));
      // Loop back to reconnect
    }
  }
}

// Start
bootstrap().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
