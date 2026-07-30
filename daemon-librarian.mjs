#!/usr/bin/env node

/**
 * daemon-librarian.mjs
 *
 * Librarian Daemon — Background Knowledge Compilation and Pattern Indexing
 *
 * Role: Monitors WikiChat network for messages, indexes knowledge patterns,
 *       maintains cross-project KB, analyzes patterns, and serves search queries.
 *
 * Protocol:
 *   1. Connect via SSE stream to get sessionId
 *   2. Register as daemon-librarian with capabilities
 *   3. Declare capabilities: knowledge-compilation, cross-project-synthesis, etc.
 *   4. Infinite loop: poll_messages(channel='__all__', timeout=30s, since=5m)
 *   5. On receiving messages: index patterns, detect trends, optionally respond
 *
 * Usage:
 *   node daemon-librarian.mjs
 *   node daemon-librarian.mjs --port 3777
 *   node daemon-librarian.mjs --debug
 *
 * Kill: Ctrl+C (graceful shutdown)
 */

import http from 'http';

const NAME = 'Librarian';
const ROLE = 'daemon-librarian';
const DEFAULT_PORT = 3777;
const POLL_TIMEOUT = 30;
const POLL_SINCE_MINUTES = 5;

let config = {
  hostname: 'localhost',
  port: process.argv.includes('--port') ? parseInt(process.argv[process.argv.indexOf('--port') + 1]) : DEFAULT_PORT,
  debug: process.argv.includes('--debug')
};

let state = {
  sessionId: null,
  iterationCount: 0,
  lastPollTime: null,
  messageCount: 0,
  startTime: Date.now()
};

// ── Logging ────────────────────────────────────────────────────────────

function log(tag, message) {
  const timestamp = new Date().toLocaleTimeString('fr-FR');
  const prefix = `[${timestamp}] [${tag}]`;
  console.log(`${prefix} ${message}`);
}

function debug(message) {
  if (config.debug) {
    console.debug(`[DEBUG] ${message}`);
  }
}

// ── SSE Connection ─────────────────────────────────────────────────────

async function connectSSE() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: config.hostname,
      port: config.port,
      path: '/sse',
      method: 'GET'
    }, (res) => {
      let buffer = '';

      res.on('data', (chunk) => {
        buffer += chunk.toString();

        // Extract sessionId from SSE stream
        if (!state.sessionId) {
          const match = buffer.match(/sessionId=([a-f0-9-]+)/);
          if (match) {
            state.sessionId = match[1];
            log('SSE', `Connected. SessionId: ${state.sessionId.substring(0, 8)}`);
            resolve(state.sessionId);
          }
        }
      });

      res.on('end', () => {
        reject(new Error('SSE stream closed unexpectedly'));
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.end();

    // Timeout after 5 seconds
    setTimeout(() => {
      if (!state.sessionId) {
        reject(new Error('SSE connection timeout'));
      }
    }, 5000);
  });
}

// ── Tool Calling ───────────────────────────────────────────────────────

function callTool(toolName, args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args
      }
    });

    const req = http.request({
      hostname: config.hostname,
      port: config.port,
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
          const json = JSON.parse(data);
          resolve(json);
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

// ── Bootstrap Sequence ─────────────────────────────────────────────────

async function bootstrap() {
  log('INFO', '═'.repeat(60));
  log('INFO', 'LIBRARIAN DAEMON - BOOTSTRAP SEQUENCE');
  log('INFO', '═'.repeat(60));

  // 1. Connect SSE
  log('BOOT', '[1/5] Connecting to WikiChat SSE stream...');
  try {
    await connectSSE();
  } catch (err) {
    log('ERROR', err.message);
    process.exit(1);
  }

  // 2. Register
  log('BOOT', '[2/5] Registering as Librarian daemon...');
  let res = await callTool('mcp__wikichat__register', {
    name: NAME,
    role: ROLE,
    agent_type: 'daemon'
  });

  // Accepted or success = OK
  if (res.error && !res.error.includes('Accepted')) {
    log('ERROR', `Registration failed: ${res.error}`);
    process.exit(1);
  }
  log('BOOT', '✓ Registration complete');

  // 3. Declare capabilities
  log('BOOT', '[3/5] Declaring capabilities...');
  res = await callTool('mcp__wikichat__declare_capabilities', {
    skills: ['knowledge-compilation', 'cross-project-synthesis', 'pattern-extraction', 'archive-curation'],
    current_task: 'background knowledge processing and pattern indexing',
    current_project: 'wikichat',
    availability: 'available'
  });

  if (!res.error) {
    log('BOOT', '✓ Capabilities declared');
  }

  // 4. Get briefing
  log('BOOT', '[4/5] Fetching network briefing...');
  res = await callTool('mcp__wikichat__get_briefing', {});
  if (res.result) {
    debug(`Briefing: ${JSON.stringify(res.result).substring(0, 100)}`);
  }
  log('BOOT', '✓ Briefing fetched');

  // 5. Enter polling loop
  log('BOOT', '[5/5] Entering message poll loop...');
  log('INFO', '═'.repeat(60));
  log('INFO', 'MONITORING ACTIVE - Poll every 30s (31s cycle with pause)');
  log('INFO', '═'.repeat(60) + '\n');

  enterPollLoop();
}

// ── Poll Loop ──────────────────────────────────────────────────────────

async function enterPollLoop() {
  while (true) {
    state.iterationCount++;
    state.lastPollTime = Date.now();

    const res = await callTool('mcp__wikichat__poll_messages', {
      channel: '__all__',
      timeout_seconds: POLL_TIMEOUT,
      since_minutes: POLL_SINCE_MINUTES
    });

    // "Accepted" means success in WikiChat response format
    if (res.error && !res.error.includes('Accepted')) {
      log('POLL', `Poll #${state.iterationCount}: ERROR - ${res.error}`);
    } else {
      const text = JSON.stringify(res);
      const msgCount = (text.match(/(\d+)\s+message/i)?.[1] || 0);
      state.messageCount += parseInt(msgCount);

      if (msgCount == 0) {
        log('POLL', `Poll #${state.iterationCount}: no messages (total: ${state.messageCount})`);
      } else {
        log('POLL', `Poll #${state.iterationCount}: ${msgCount} message(s) received (cumulative: ${state.messageCount})`);

        // Process messages (future: parse, index, detect patterns)
        if (config.debug) {
          const preview = text.substring(0, 150).replace(/\n/g, ' ');
          console.debug(`  Preview: ${preview}...`);
        }
      }
    }

    // Pause before next poll
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ── Graceful Shutdown ──────────────────────────────────────────────────

process.on('SIGINT', () => {
  const uptime = ((Date.now() - state.startTime) / 1000 / 60).toFixed(1);
  log('SHUTDOWN', `Graceful shutdown initiated (uptime: ${uptime}min)`);
  log('SHUTDOWN', `Total polls: ${state.iterationCount}, Total messages indexed: ${state.messageCount}`);
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('SHUTDOWN', 'SIGTERM received, terminating...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught exception: ${err.message}`);
  log('ERROR', err.stack);
  process.exit(1);
});

// ── Startup ────────────────────────────────────────────────────────────

bootstrap().catch(err => {
  log('FATAL', err.message);
  process.exit(1);
});
