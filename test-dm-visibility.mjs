#!/usr/bin/env node
/**
 * Regression test for DM visibility bug.
 *
 * Bug : DM channels stockaient `participants` par nom lowercase, mais les
 * filtres de poll_messages / read_messages cherchaient la sessionId (UUID)
 * → aucun DM jamais visible via les outils MCP.
 *
 * Ce test couvre le scénario observé en prod (Claude-Vision-VALID ↔ VALID-Coder) :
 *   1. Alice envoie un DM à Bob
 *   2. Bob (toujours connecté) read_messages : doit voir le DM
 *   3. Bob se déconnecte puis se reconnecte sous le même nom
 *   4. Bob poll_messages : doit voir un DM envoyé entre temps
 *
 * Usage : npm start dans un terminal puis `node test-dm-visibility.mjs`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import assert from "node:assert/strict";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3777";
const ALICE = "DM-Test-Alice-" + Date.now().toString(36);
const BOB = "DM-Test-Bob-" + Date.now().toString(36);

async function connect(name) {
  const transport = new SSEClientTransport(new URL(`${SERVER_URL}/sse`));
  const client = new Client({ name: `test-${name}`, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, name };
}

async function call(session, tool, args = {}) {
  const r = await session.client.callTool({ name: tool, arguments: args });
  return r.content?.map(c => c.text).join("\n") || "";
}

async function close(session) {
  try { await session.client.close(); } catch {}
}

async function main() {
  console.log(`🧪 DM visibility regression — ${ALICE} ↔ ${BOB}\n`);

  // 1. Both register
  let alice = await connect(ALICE);
  let bob = await connect(BOB);
  await call(alice, "register", { name: ALICE, role: "tester" });
  await call(bob, "register", { name: BOB, role: "tester" });
  console.log("✓ Both registered");

  // 2. Alice DMs Bob — Bob is online
  await call(alice, "send_message", {
    content: "🟢 first DM while Bob is online",
    channel: "@" + BOB,
  });
  console.log("✓ Alice sent DM #1");

  // Wait for delivery
  await new Promise(r => setTimeout(r, 100));

  // 3. Bob reads — must see the DM
  const bobReads1 = await call(bob, "read_messages", {
    channel: "__all__", since_minutes: 5,
  });
  assert.ok(
    bobReads1.includes("first DM"),
    `Bob should see DM #1 via read_messages but didn't.\nGot:\n${bobReads1}`
  );
  console.log("✓ Bob saw DM #1 via read_messages");

  // 4. Bob disconnects + reconnects under SAME name (the prod scenario)
  await close(bob);
  await new Promise(r => setTimeout(r, 200));
  bob = await connect(BOB);
  await call(bob, "register", { name: BOB, role: "tester" });
  console.log("✓ Bob reconnected (new sessionId, same name)");

  // 5. Alice DMs Bob again
  await call(alice, "send_message", {
    content: "🔵 second DM after Bob reconnected",
    channel: "@" + BOB,
  });
  console.log("✓ Alice sent DM #2");

  await new Promise(r => setTimeout(r, 100));

  // 6. Bob's read_messages must show DM #2 even though he has a fresh sessionId
  const bobReads2 = await call(bob, "read_messages", {
    channel: "__all__", since_minutes: 5,
  });
  assert.ok(
    bobReads2.includes("second DM"),
    `Bob should see DM #2 after reconnect but didn't.\nGot:\n${bobReads2}`
  );
  console.log("✓ Bob saw DM #2 after reconnect via read_messages");

  // 7. poll_messages with channel="__all__" should also pick up a fresh DM
  const dmKey = `dm:${[ALICE, BOB].map(s => s.toLowerCase()).sort().join("__")}`;
  const pollPromise = call(bob, "poll_messages", {
    channel: "__all__", timeout_seconds: 6,
  });
  await new Promise(r => setTimeout(r, 200));
  await call(alice, "send_message", {
    content: "🟣 third DM during Bob's poll",
    channel: "@" + BOB,
  });
  const pollResult = await pollPromise;
  assert.ok(
    pollResult.includes("third DM"),
    `Bob's poll_messages should pick up DM #3 but didn't.\nDM channel was: ${dmKey}\nGot:\n${pollResult}`
  );
  console.log("✓ Bob's poll_messages picked up DM #3");

  // Cleanup
  await close(alice);
  await close(bob);

  console.log("\n🎉 DM visibility regression — ALL ASSERTIONS PASSED");
}

main().catch(err => {
  console.error("\n❌ FAILED:", err.message);
  process.exit(1);
});
