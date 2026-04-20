#!/usr/bin/env node
/**
 * Test script: simulates two Claude Code sessions communicating via InterChat
 * 
 * Usage: 
 *   1. Start the server: npm start
 *   2. In another terminal: node test-e2e.mjs
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3777";

async function createSession(name) {
  const transport = new SSEClientTransport(new URL(`${SERVER_URL}/sse`));
  const client = new Client({ name: `test-${name}`, version: "1.0.0" });
  await client.connect(transport);
  console.log(`✅ ${name} connected`);
  return { client, transport, name };
}

async function callTool(session, toolName, args = {}) {
  const result = await session.client.callTool({ name: toolName, arguments: args });
  const text = result.content?.map(c => c.text).join("\n") || "(no output)";
  console.log(`\n[${session.name}] → ${toolName}(${JSON.stringify(args)}):`);
  console.log(text.split("\n").map(l => `  ${l}`).join("\n"));
  return text;
}

async function main() {
  console.log("🧪 MCP InterChat E2E Test\n");
  console.log(`Connecting to ${SERVER_URL}...\n`);

  // Create two sessions
  const alice = await createSession("Alice");
  const bob = await createSession("Bob");

  try {
    // Register
    await callTool(alice, "register", { name: "Alice", role: "architecte" });
    await callTool(bob, "register", { name: "Bob", role: "développeur" });

    // List sessions
    await callTool(alice, "list_sessions");

    // Get context
    await callTool(bob, "get_context");

    // Create a channel
    await callTool(alice, "create_channel", { 
      name: "design", 
      description: "Discussion d'architecture" 
    });

    // Send messages
    await callTool(alice, "send_message", {
      content: "Salut Bob ! On part sur quelle stack pour le nouveau service ?",
      channel: "design",
    });

    // Bob reads messages
    await callTool(bob, "read_messages", { channel: "design" });

    // Bob replies
    await callTool(bob, "send_message", {
      content: "Je propose Node.js + Express + PostgreSQL. Simple et éprouvé.",
      channel: "design",
    });

    // Alice reads the reply
    await callTool(alice, "read_messages", { channel: "design" });

    // Direct message
    await callTool(alice, "send_message", {
      content: "Petit message privé : tu peux merger la PR #42 ?",
      channel: "@Bob",
    });

    // Bob reads DMs
    await callTool(bob, "read_messages", { channel: "__all__", since_minutes: 5 });

    // Broadcast
    await callTool(alice, "broadcast", {
      content: "Réunion dans 5 minutes sur #design !",
      priority: "warning",
    });

    // Final read
    await callTool(bob, "read_messages", { channel: "__all__", since_minutes: 5 });

    console.log("\n\n🎉 All tests passed!");

  } finally {
    await alice.client.close();
    await bob.client.close();
    console.log("\n🔌 Sessions disconnected.");
  }
}

main().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});
