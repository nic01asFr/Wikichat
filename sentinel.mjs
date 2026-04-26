#!/usr/bin/env node
/**
 * Sentinel Daemon v1
 *
 * Persistent poll loop for daemon-sentinel role.
 * Connects via SSE, registers, and polls for messages.
 */

import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const SERVER_URL = process.env.WIKICHAT_URL || "http://localhost:3777";
const POLL_TIMEOUT = 30;
const AGENT_NAME = "Sentinel";
const AGENT_ROLE = "daemon-sentinel";

async function runSentinel() {
  console.log(`[${AGENT_NAME}] Starting daemon loop...`);

  const transport = new SSEClientTransport(new URL(`${SERVER_URL}/sse`));
  const client = new Client({ name: AGENT_NAME, version: "1.0.0" });

  await client.connect(transport);
  console.log(`[${AGENT_NAME}] Connected to WikiChat`);

  // Register or update status
  try {
    const regResult = await client.callTool({
      name: "register",
      arguments: { name: AGENT_NAME, role: AGENT_ROLE, agent_type: "daemon" },
    });
    const text = regResult.content?.map(c => c.text).join("\n") || "(no output)";
    console.log(`[${AGENT_NAME}] ✓ Registered: ${text.split("\n")[0]}`);
  } catch (err) {
    if (err.message.includes("déjà pris")) {
      console.log(`[${AGENT_NAME}] ✓ Already registered, resuming...`);
    } else {
      console.error(`[${AGENT_NAME}] Register failed:`, err.message);
      process.exit(1);
    }
  }

  // Main poll loop
  let iteration = 0;
  while (true) {
    iteration++;
    try {
      console.log(`[${AGENT_NAME}] Poll #${iteration}: waiting (timeout=${POLL_TIMEOUT}s)...`);
      console.flush?.();

      const result = await client.callTool({
        name: "poll_messages",
        arguments: { timeout_seconds: POLL_TIMEOUT },
      });

      const text = result.content?.map(c => c.text).join("\n") || "";
      if (text && text.length > 0) {
        console.log(`[${AGENT_NAME}] Poll #${iteration} → messages:\n${text}`);
      } else {
        console.log(`[${AGENT_NAME}] Poll #${iteration} → idle`);
      }
    } catch (err) {
      console.error(`[${AGENT_NAME}] Poll #${iteration} ERROR: ${err.code} - ${err.message}`);
      // Backoff and retry
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

runSentinel().catch((err) => {
  console.error("[Sentinel] Fatal:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[Sentinel] SIGINT received, exiting...");
  process.exit(0);
});
