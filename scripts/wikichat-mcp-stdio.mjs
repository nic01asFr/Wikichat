#!/usr/bin/env node
/**
 * wikichat-mcp-stdio.mjs — pont stdio → SSE WikiChat avec identité.
 *
 * Cursor et Claude Code (VS Code / Desktop) n'envoient pas les en-têtes du
 * headersHelper, et substituent ${CLAUDE_CODE_SESSION_ID} par une chaîne vide.
 * Chaque reconnexion SSE repart donc anonyme — WikiChat « coupe » pour le client.
 *
 * Ce pont calcule le jeton (même helper), l'injecte dans l'URL (?token=…), et
 * expose WikiChat en stdio. Les clients qui ne savent parler qu'en stdio
 * gardent leur identité d'une reconnexion à l'autre.
 *
 * Config MCP :
 *   { "command": "node", "args": ["…/scripts/wikichat-mcp-stdio.mjs"] }
 *
 * Env optionnelles : WIKICHAT_AGENT, PORT / WIKICHAT_PORT, WIKICHAT_HOST,
 * CLAUDE_CODE_SESSION_ID (si présente, le helper la préfère au PPID).
 */
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  CompleteRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(__dirname, "wikichat-token-helper.mjs");
const HOST = process.env.WIKICHAT_HOST || "127.0.0.1";
const PORT = process.env.WIKICHAT_PORT || process.env.PORT || "3777";

function logErr(...a) {
  try { process.stderr.write(`[wikichat-stdio] ${a.join(" ")}\n`); } catch { /* */ }
}

function lireIdentite() {
  const r = spawnSync(process.execPath, [HELPER], {
    encoding: "utf8",
    env: process.env,
    cwd: process.cwd(),
    windowsHide: true,
  });
  if (r.status !== 0) {
    logErr("helper exit", r.status, (r.stderr || "").slice(0, 200));
    return {};
  }
  try {
    return JSON.parse((r.stdout || "").trim() || "{}");
  } catch (e) {
    logErr("helper JSON", e.message);
    return {};
  }
}

function urlAvecIdentite(headers) {
  const url = new URL(`http://${HOST}:${PORT}/sse`);
  const agent = (process.env.WIKICHAT_AGENT || "").trim();
  if (agent && !/^\$\{.*\}$/.test(agent)) url.searchParams.set("agent", agent);
  const token = (headers["x-wikichat-token"] || "").trim();
  if (token) url.searchParams.set("token", token);
  const conv = (headers["x-wikichat-claude-session"] || "").trim();
  if (conv) url.searchParams.set("claude_session", conv);
  return url;
}

async function main() {
  const headers = lireIdentite();
  const url = urlAvecIdentite(headers);
  if (!url.searchParams.get("token") && !url.searchParams.get("agent")) {
    logErr("aucun jeton ni agent — connexion anonyme (helper vide ?)");
  } else {
    logErr(`→ ${url.origin}${url.pathname}?… token=${url.searchParams.has("token") ? "oui" : "non"} agent=${url.searchParams.get("agent") || "-"}`);
  }

  const upstream = new Client({ name: "wikichat-stdio-bridge", version: "1.0.0" });
  const sse = new SSEClientTransport(url, {
    requestInit: {
      headers: Object.fromEntries(
        Object.entries(headers).filter(([, v]) => typeof v === "string" && v.length > 0)
      ),
    },
  });
  await upstream.connect(sse);

  const caps = upstream.getServerCapabilities() || {};
  const server = new Server(
    { name: "wikichat", version: "2.0.0" },
    { capabilities: caps }
  );

  if (caps.tools) {
    server.setRequestHandler(ListToolsRequestSchema, async () => upstream.listTools());
    server.setRequestHandler(CallToolRequestSchema, async (req) =>
      upstream.callTool(req.params)
    );
  }
  if (caps.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, async (req) =>
      upstream.listResources(req.params)
    );
    server.setRequestHandler(ReadResourceRequestSchema, async (req) =>
      upstream.readResource(req.params)
    );
    try {
      server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) =>
        upstream.listResourceTemplates(req.params)
      );
    } catch { /* schéma absent selon version */ }
  }
  if (caps.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, async (req) =>
      upstream.listPrompts(req.params)
    );
    server.setRequestHandler(GetPromptRequestSchema, async (req) =>
      upstream.getPrompt(req.params)
    );
  }
  if (caps.completions) {
    try {
      server.setRequestHandler(CompleteRequestSchema, async (req) =>
        upstream.complete(req.params)
      );
    } catch { /* optionnel */ }
  }

  const stdio = new StdioServerTransport();
  await server.connect(stdio);
}

main().catch((err) => {
  logErr("fatal", err?.stack || err?.message || String(err));
  process.exit(1);
});
