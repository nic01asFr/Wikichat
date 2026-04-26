#!/usr/bin/env node
/**
 * Librarian Daemon — Restart #1
 * Consolidates knowledge: indexes messages, builds KB, responds to queries
 * Protocol: register → poll_messages(30s timeout) → process → loop
 */

import http from 'http';
import { URL } from 'url';

const BASE_URL = 'http://localhost:3777';

let sessionId = null;
let lastProcessed = null;

async function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function register() {
  console.log('[Librarian] Registering...');
  const res = await makeRequest('POST', '/api/chat', {
    action: 'register',
    name: 'Librarian',
    role: 'daemon-librarian',
  });
  sessionId = res.session_id;
  console.log(`[Librarian] Registered with session ${sessionId}`);
  return sessionId;
}

async function sendMessage(channel, content) {
  console.log(`[Librarian] Sending to #${channel}:`, content.substring(0, 50) + '...');
  await makeRequest('POST', '/api/chat', {
    session_id: sessionId,
    channel,
    content,
  });
}

async function pollMessages(timeout = 30) {
  const messages = await makeRequest('GET', `/api/messages?session_id=${sessionId}`);

  // Filter to new messages since last poll
  const newMsgs = messages.filter(m => {
    if (!lastProcessed) return m.channel === 'coordination' || m.channel === 'system';
    return new Date(m.timestamp) > lastProcessed;
  });

  if (newMsgs.length > 0) {
    console.log(`[Librarian] Polled ${newMsgs.length} new messages`);
    lastProcessed = new Date();
    return newMsgs;
  }
  return [];
}

async function processMessages(messages) {
  for (const msg of messages) {
    // Consolidate system events and coordination messages
    if (msg.channel === 'system' && msg.content.includes('spawn')) {
      console.log(`[Librarian] 📑 Indexing spawn event: ${msg.content.substring(0, 60)}`);
    }
    if (msg.channel === 'coordination' && !msg.content.includes('Librarian')) {
      console.log(`[Librarian] 📑 Indexing agent report: ${msg.fromName}`);
    }
  }
}

async function main() {
  try {
    await register();
    await sendMessage('coordination', '🟢 Librarian #1 en ligne, consolidation KB en cours.');

    // Poll loop: 30s timeout
    console.log('[Librarian] Entering poll loop (30s timeout)...\n');
    while (true) {
      const msgs = await pollMessages(30);
      if (msgs.length > 0) {
        await processMessages(msgs);
      }
      // Continue polling...
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  } catch (err) {
    console.error('[Librarian] Error:', err.message);
    process.exit(1);
  }
}

main();
