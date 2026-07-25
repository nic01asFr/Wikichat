import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const SERVER_URL = "http://localhost:3777";

async function main() {
  console.log("🧪 WikiChat Startup Ritual — Librarian\n");
  console.log(`Connecting to ${SERVER_URL}...\n`);

  const transport = new SSEClientTransport(new URL(`${SERVER_URL}/sse`));
  const client = new Client({ name: "test-librarian", version: "1.0.0" });
  await client.connect(transport);
  console.log("✅ Connected\n");

  try {
    // 1. Register
    console.log("=== STEP 1: REGISTER ===");
    const register = await client.callTool({
      name: "register",
      arguments: {
        name: "Librarian",
        role: "daemon-librarian",
        agent_type: "daemon"
      }
    });
    console.log(register.content.map(c => c.text).join("\n"));

    // 2. List projects
    console.log("\n=== STEP 2: LIST_PROJECTS ===");
    const list = await client.callTool({
      name: "list_projects",
      arguments: {}
    });
    console.log(list.content.map(c => c.text).join("\n"));

    // 3. Declare project
    console.log("\n=== STEP 3: DECLARE_PROJECT ===");
    const declare = await client.callTool({
      name: "declare_project",
      arguments: {
        name: "WikiChat",
        description: "Local multi-agent coordination MCP server",
        repo: "https://github.com/nic01asFr/Wikichat.git",
        stack: ["node", "express", "mcp"]
      }
    });
    console.log(declare.content.map(c => c.text).join("\n"));

    // 4. Get briefing
    console.log("\n=== STEP 4: GET_BRIEFING ===");
    const briefing = await client.callTool({
      name: "get_briefing",
      arguments: {}
    });
    console.log(briefing.content.map(c => c.text).join("\n"));

    // 5. Search knowledge
    console.log("\n=== STEP 5: SEARCH_KNOWLEDGE ===");
    const search = await client.callTool({
      name: "search_knowledge",
      arguments: {
        query: "daemon coordination polling",
        limit: 3
      }
    });
    console.log(search.content.map(c => c.text).join("\n"));

    console.log("\n\n🎉 Ritual completed!");

  } finally {
    await client.close();
    console.log("\n🔌 Session disconnected.");
  }
}

main().catch(console.error);
