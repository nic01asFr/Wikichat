#!/usr/bin/env node
/**
 * Sentinel Daemon #4
 * Continuous message polling, health monitoring, reactive behavior.
 *
 * Protocol:
 *   1. Declare startup on __all__ via REST
 *   2. Poll GET /api/messages with 30s timeout + cursor tracking
 *   3. React to @Sentinel mentions + broadcast urgency
 *   4. Log concisely (1-2 lines per message)
 */

import http from 'http';
import { URL } from 'url';

const baseUrl = 'http://localhost:3777';
const name = 'Sentinel';
const role = 'daemon-sentinel';

let isExiting = false;
let lastMessageId = null;
let pollCount = 0;

/**
 * Make an HTTP request to WikiChat REST API
 */
async function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      timeout: 10000
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
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout: ${method} ${path}`));
    });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Format log timestamp (HH:MM)
 */
function logTime() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Log with Sentinel prefix
 */
function log(type, message) {
  console.log(`Sentinel | ${logTime()} | [${type}] ${message}`);
}

/**
 * Extract @mentions from message content
 */
function extractMentions(content) {
  const matches = content.match(/@(\w+)/g) || [];
  return matches.map(m => m.slice(1)); // Remove @ prefix
}

/**
 * React to a message
 */
function reactToMessage(msg) {
  const mentions = extractMentions(msg.content);
  const isBroadcast = msg.channel === '__all__' || msg.channel === '__broadcast__';
  const isUrgent = /urgent|critical|ASAP|emergency/i.test(msg.content);
  const isMentioned = mentions.includes('Sentinel') || mentions.includes('sentinel');

  if (isMentioned) {
    log('mention', `@${msg.fromName} → ack`);
  } else if (isBroadcast && isUrgent) {
    log('urgent', `[${msg.channel}] ${msg.fromName}: ${msg.content.substring(0, 50)}`);
  }
}

/**
 * Poll messages with cursor tracking
 */
async function pollMessages() {
  try {
    let path = `/api/messages?channel=__all__&limit=50`;
    if (lastMessageId) {
      path += `&since_id=${lastMessageId}`;
    }

    const messages = await makeRequest('GET', path);
    pollCount++;

    if (!Array.isArray(messages)) {
      log('poll', `Poll #${pollCount}: error (invalid response)`);
      return;
    }

    if (messages.length === 0) {
      log('poll', `Poll #${pollCount}: timeout (no new messages)`);
      return;
    }

    log('poll', `Poll #${pollCount}: ${messages.length} message(s)`);

    for (const msg of messages) {
      // Track cursor
      if (msg.id) lastMessageId = msg.id;

      // React to message
      reactToMessage(msg);
    }
  } catch (e) {
    log('poll', `Poll #${pollCount}: error — ${e.message}`);
  }
}

/**
 * Main daemon loop
 */
async function main() {
  try {
    log('init', 'Sentinel daemon starting...');

    // Step 1: Send startup message on __all__
    log('startup', 'Broadcasting startup message...');
    try {
      await makeRequest('POST', '/api/chat', {
        from: name,
        channel: '__all__',
        content: `🚨 Sentinel #4 démarrage — watching all channels`
      });
      log('startup', '✓ Announced on __all__');
    } catch (e) {
      log('startup', `Failed: ${e.message}`);
    }

    // Step 2: Poll loop
    log('ready', 'Entering poll loop...');

    while (!isExiting) {
      await pollMessages();
      // Wait before next poll (avoid tight loop)
      await new Promise(r => setTimeout(r, 1000));
    }

  } catch (err) {
    log('fatal', err.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log();
  log('shutdown', 'Received SIGINT, stopping...');
  isExiting = true;
  setTimeout(() => {
    log('shutdown', 'Force quit (timeout)');
    process.exit(0);
  }, 5000);
});

process.on('SIGTERM', () => {
  log('shutdown', 'Received SIGTERM, stopping...');
  isExiting = true;
  setTimeout(() => process.exit(0), 5000);
});

main();
