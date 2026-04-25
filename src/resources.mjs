/**
 * resources.mjs — MCP Resources for WikiChat.
 *
 * Exposes dynamic, session-aware resources that agents and IDEs can read:
 *   wikichat://briefing          — filtered briefing for the connected session
 *   wikichat://role/{name}       — role definition from .wikichat/roles/
 *   wikichat://identity/{name}   — agent identity (memories, skills, last state)
 *   wikichat://decisions         — recent decisions from #decisions channel
 *   wikichat://kb/{topic}        — knowledge base entry
 *
 * Resources complement tools: tools are for actions, resources for context.
 * IDEs display resources in panels — Nicolas can see agent state without the dashboard.
 */

import fs from "fs";
import path from "path";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  state, getSessionName, getChannelCount, timeSince,
} from "./state.mjs";
import { recall } from "./identity.mjs";
import { loadSnapshot } from "./persistence.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const ROLES_DIRS = [
  path.join(process.cwd(), ".wikichat", "roles"), // local override
  path.join(process.cwd(), "docs", "roles"),       // shipped templates
];

const KB_DIR = path.join(process.cwd(), ".wikichat", "knowledge");

function listRoleFiles() {
  const roles = [];
  for (const dir of ROLES_DIRS) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith(".md")) roles.push({ name: f.replace(".md", ""), dir });
      }
    } catch { /* ignore */ }
  }
  return roles;
}

function listKBFiles() {
  try {
    if (!fs.existsSync(KB_DIR)) return [];
    return fs.readdirSync(KB_DIR).filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""));
  } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resource registration
// ─────────────────────────────────────────────────────────────────────────────

export function registerResources(server, sessionId) {

  // ── wikichat://briefing — session-aware briefing ──────────────────────────

  server.resource(
    "briefing",
    "wikichat://briefing",
    { description: "Briefing filtré pour votre session : mentions, messages récents, sessions actives, projets" },
    async () => {
      const session = state.sessions.get(sessionId);
      const myName = getSessionName(sessionId);

      // Sessions
      const sessions = [...state.sessions.entries()]
        .map(([id, s]) => `${s.name}${s.role ? ` (${s.role})` : ""}${s.current_task ? ` — ${s.current_task}` : ""}${id === sessionId ? " ← vous" : ""}`)
        .join("\n");

      // Mentions
      const mentionPattern = new RegExp(`@${myName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");
      const sinceDate = session?.lastSeen ? new Date(session.lastSeen) : null;
      let msgs = state.messages.filter(m =>
        !m.isDM || (state.channels.get(m.channel)?.participants ?? []).includes(sessionId)
      );
      if (sinceDate) msgs = msgs.filter(m => new Date(m.timestamp) > sinceDate);
      const mentions = msgs.filter(m => m.from !== sessionId && mentionPattern.test(m.content));

      // Recent
      const recent = (sinceDate ? msgs : msgs.slice(-10))
        .slice(-15)
        .map(m => `[${new Date(m.timestamp).toLocaleTimeString("fr-FR")}] #${m.channel || "dm"} ${m.fromName}: ${m.content.slice(0, 150)}`)
        .join("\n");

      // Projects
      const projects = [...state.projects.values()]
        .map(p => `${p.name}${[...state.sessions.values()].some(s => s.current_project?.toLowerCase() === p.name.toLowerCase()) ? " (actif)" : ""}`)
        .join(", ");

      const text = [
        `# WikiChat Briefing — ${myName}`,
        ``,
        `## Sessions (${state.sessions.size})`,
        sessions || "(aucune)",
        ``,
        mentions.length > 0 ? `## Mentions (${mentions.length})\n${mentions.map(m => `- ${m.fromName}: ${m.content.slice(0, 150)}`).join("\n")}` : "",
        ``,
        `## Messages récents`,
        recent || "(aucun)",
        ``,
        `## Projets`,
        projects || "(aucun)",
      ].filter(Boolean).join("\n");

      return { contents: [{ uri: "wikichat://briefing", text, mimeType: "text/markdown" }] };
    }
  );

  // ── wikichat://role/{name} — role definitions ─────────────────────────────

  server.resource(
    "role",
    new ResourceTemplate("wikichat://role/{name}", { list: () => {
      return listRoleFiles().map(r => ({
        uri: `wikichat://role/${r.name}`,
        name: `Role: ${r.name}`,
        description: `Définition du rôle ${r.name}`,
      }));
    }}),
    { description: "Définition d'un rôle agent depuis .wikichat/roles/" },
    async (uri, { name }) => {
      for (const dir of ROLES_DIRS) {
        const filePath = path.join(dir, `${name}.md`);
        try {
          if (fs.existsSync(filePath)) {
            const text = fs.readFileSync(filePath, "utf8");
            return { contents: [{ uri: uri.href, text, mimeType: "text/markdown" }] };
          }
        } catch { /* ignore */ }
      }
      return { contents: [{ uri: uri.href, text: `Rôle "${name}" introuvable. Disponibles: ${listRoleFiles().map(r => r.name).join(", ")}`, mimeType: "text/plain" }] };
    }
  );

  // ── wikichat://identity/{name} — agent identity ───────────────────────────

  server.resource(
    "identity",
    new ResourceTemplate("wikichat://identity/{name}", { list: () => {
      // List all known agent names (from sessions + snapshots)
      const names = new Set();
      for (const s of state.sessions.values()) {
        if (!s.name.startsWith("session-")) names.add(s.name);
      }
      return [...names].map(n => ({
        uri: `wikichat://identity/${n}`,
        name: `Identity: ${n}`,
        description: `État et mémoires de l'agent ${n}`,
      }));
    }}),
    { description: "Identité persistante d'un agent : mémoires, skills, dernier état" },
    async (uri, { name }) => {
      const memories = recall(name) || {};
      const snap = loadSnapshot(name);
      const live = [...state.sessions.values()].find(s => s.name === name);

      const text = [
        `# Agent Identity: ${name}`,
        ``,
        `## État`,
        live ? `- Status: en ligne (${live.agent_type || "interactive"})` : "- Status: hors ligne",
        live?.role ? `- Rôle: ${live.role}` : "",
        live?.current_project ? `- Projet: ${live.current_project}` : "",
        live?.current_task ? `- Tâche: ${live.current_task}` : "",
        live?.skills?.length ? `- Skills: ${live.skills.join(", ")}` : "",
        snap ? `- Dernier snapshot: ${timeSince(snap.savedAt)}` : "",
        ``,
        `## Mémoires`,
        ...Object.entries(memories).map(([k, v]) => `- **${k}**: ${String(v).slice(0, 200)}`),
        Object.keys(memories).length === 0 ? "- (aucune)" : "",
      ].filter(Boolean).join("\n");

      return { contents: [{ uri: uri.href, text, mimeType: "text/markdown" }] };
    }
  );

  // ── wikichat://decisions — recent decisions ───────────────────────────────

  server.resource(
    "decisions",
    "wikichat://decisions",
    { description: "Décisions récentes du canal #decisions" },
    async () => {
      const decisions = state.messages
        .filter(m => m.channel === "decisions")
        .slice(-20)
        .map(m => `[${new Date(m.timestamp).toLocaleTimeString("fr-FR")}] ${m.fromName}: ${m.content}`)
        .join("\n\n---\n\n");

      return {
        contents: [{
          uri: "wikichat://decisions",
          text: decisions || "Aucune décision enregistrée. Utilisez #decisions pour les décisions structurées.",
          mimeType: "text/markdown",
        }],
      };
    }
  );

  // ── wikichat://kb/{topic} — knowledge base ────────────────────────────────

  server.resource(
    "knowledge",
    new ResourceTemplate("wikichat://kb/{topic}", { list: () => {
      return listKBFiles().map(t => ({
        uri: `wikichat://kb/${t}`,
        name: `KB: ${t}`,
        description: `Article de la knowledge base: ${t}`,
      }));
    }}),
    { description: "Article de la Knowledge Base WikiChat" },
    async (uri, { topic }) => {
      const filePath = path.join(KB_DIR, `${topic}.md`);
      try {
        if (fs.existsSync(filePath)) {
          const text = fs.readFileSync(filePath, "utf8");
          return { contents: [{ uri: uri.href, text, mimeType: "text/markdown" }] };
        }
      } catch { /* ignore */ }
      const available = listKBFiles();
      return {
        contents: [{
          uri: uri.href,
          text: `Topic "${topic}" introuvable.${available.length ? ` Disponibles: ${available.join(", ")}` : " KB vide."}`,
          mimeType: "text/plain",
        }],
      };
    }
  );
}
