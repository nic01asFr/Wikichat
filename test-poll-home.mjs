#!/usr/bin/env node
/**
 * Focused E2E for the new coordination primitives:
 *  - unified server-side inbox cursor (poll + /api/inbox share one position)
 *  - argless `poll` (everything addressed to me since last poll)
 *  - project home channels (register auto-joins, contact_agent routes there)
 *  - contact_agent deposits in recipient's home with @mention (async, no spawn)
 *
 * Run against an isolated instance: SERVER_URL=http://localhost:3778 node test-poll-home.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const URL_ = process.env.SERVER_URL || "http://localhost:3778";
let pass = 0, fail = 0;
function check(label, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} ${detail}`); }
}

async function connect(name) {
  const transport = new SSEClientTransport(new URL(`${URL_}/sse`));
  const client = new Client({ name: `test-${name}`, version: "1.0.0" });
  await client.connect(transport);
  return { client, transport, name };
}
async function call(s, tool, args = {}) {
  const r = await s.client.callTool({ name: tool, arguments: args });
  return r.content?.map(c => c.text).join("\n") || "";
}
async function identity(name, cwd) {
  const r = await fetch(`${URL_}/api/identity`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, cwd }),
  });
  return r.json();
}
async function inbox(name) {
  const r = await fetch(`${URL_}/api/inbox?agent=${encodeURIComponent(name)}&since_minutes=10`);
  return r.json();
}

async function main() {
  console.log(`\n🧪 poll/home E2E → ${URL_}\n`);
  const alice = await connect("Alice");
  const bob = await connect("Bob");

  // Simulate each agent's Stop hook reporting its repo cwd BEFORE register,
  // so register() can resolve the project home channel.
  await identity("Alice", "C:\\tmp\\projA");
  await identity("Bob", "C:\\tmp\\projB");

  console.log("1) register resolves home channel");
  const regA = await call(alice, "register", { name: "Alice", role: "architecte" });
  const regB = await call(bob, "register", { name: "Bob", role: "dev" });
  check("Alice home = #proj-proja", /#proj-proja/.test(regA), `\n--\n${regA}\n--`);
  check("Bob home = #proj-projb", /#proj-projb/.test(regB), `\n--\n${regB}\n--`);

  console.log("2) Bob's first poll is empty (baseline armed, no replay)");
  const p0 = await call(bob, "poll", {});
  check("poll empty baseline", /Rien de neuf/.test(p0), `\n--\n${p0}\n--`);

  console.log("3) Alice contacts Bob → deposited in Bob's home with @mention");
  const c1 = await call(alice, "contact_agent", { target: "Bob", message: "ping de test home", expects_reply: true });
  check("routed to Bob home", /#proj-projb/.test(c1), `\n--\n${c1}\n--`);
  check("mentions reciprocity hint", /poll\(\)/.test(c1), `\n--\n${c1}\n--`);

  console.log("4) Bob polls → sees Alice's @mention (inbox), cursor advances");
  const p1 = await call(bob, "poll", {});
  check("Bob sees the message", /ping de test home/.test(p1), `\n--\n${p1}\n--`);
  check("message is the @Bob mention", /@Bob/.test(p1), `\n--\n${p1}\n--`);

  console.log("5) Bob polls again → nothing new (unified cursor advanced)");
  const p2 = await call(bob, "poll", {});
  check("second poll empty", /Rien de neuf/.test(p2), `\n--\n${p2}\n--`);

  console.log("6) unified cursor: /api/inbox for Bob is also empty now");
  const ib = await inbox("Bob");
  check("/api/inbox empty (shared cursor)", ib.count === 0, `count=${ib.count} ${JSON.stringify(ib.messages)}`);

  console.log("7) reciprocity: Bob replies to Alice → lands in Alice's inbox");
  await call(bob, "send_message", { channel: "@Alice", content: "pong reçu, ok", status: "over" });
  const pa = await call(alice, "poll", {});
  check("Alice sees Bob's reply", /pong reçu/.test(pa), `\n--\n${pa}\n--`);

  console.log("8) broadcast reaches a fresh poller");
  await call(alice, "broadcast", { content: "annonce générale test", priority: "info" });
  const pbc = await call(bob, "poll", {});
  check("Bob sees broadcast", /annonce générale test/.test(pbc), `\n--\n${pbc}\n--`);

  console.log(`\n${fail === 0 ? "🟢 ALL PASS" : "🔴 FAILURES"} — ${pass} pass, ${fail} fail\n`);
  await alice.transport.close();
  await bob.transport.close();
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(e => { console.error("test crashed:", e); process.exit(2); });
