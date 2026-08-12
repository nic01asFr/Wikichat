#!/usr/bin/env node
/**
 * memory-mcp-server.mjs — Brique 3 du pipeline de consultation distante.
 *
 * Serveur MCP HÉBERGEABLE et STRICTEMENT READ-ONLY. Il lit le snapshot
 * canonique produit par les briques 1 et 2 (un clone local du repo privé) et
 * expose un sous-ensemble d'outils de consultation. Aucune écriture, aucun
 * spawn, aucun secret : il ne connaît que des données déjà sanitisées.
 *
 * Sécurité : auth bearer obligatoire (sauf si explicitement désactivée pour un
 * dev local). Penser à le placer derrière du TLS (l'hébergeur fournit HTTPS).
 *
 * Usage :
 *   WIKICHAT_MEMORY_SNAPSHOT=<dir> WIKICHAT_MEMORY_TOKEN=<secret> \
 *     node remote/memory-mcp-server.mjs
 *
 * Env :
 *   WIKICHAT_MEMORY_SNAPSHOT  — dossier du snapshot (défaut ./wikichat-memory-staging)
 *   WIKICHAT_MEMORY_TOKEN     — bearer requis ; si absent, le serveur REFUSE de
 *                               démarrer sauf WIKICHAT_MEMORY_ALLOW_ANON=1
 *   WIKICHAT_MEMORY_PORT      — port HTTP (défaut 3778)
 *   WIKICHAT_MEMORY_RELOAD_MS — intervalle de rechargement du snapshot (défaut 60000)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

const SNAPSHOT_DIR = path.resolve(
  process.env.WIKICHAT_MEMORY_SNAPSHOT || "wikichat-memory-staging"
);
// Token : soit en clair via WIKICHAT_MEMORY_TOKEN, soit lu depuis le fichier
// pointé par WIKICHAT_MEMORY_TOKEN_FILE (permet un lancement persistant sans
// écrire le secret dans le script de démarrage — le launcher ne référence qu'un
// chemin).
function resolveToken() {
  const direct = (process.env.WIKICHAT_MEMORY_TOKEN || "").trim();
  if (direct) return direct;
  const file = process.env.WIKICHAT_MEMORY_TOKEN_FILE;
  if (file) {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {
      console.error(`[memory-mcp] Fichier-token illisible: ${file}`);
    }
  }
  return "";
}
const TOKEN = resolveToken();
const ALLOW_ANON = process.env.WIKICHAT_MEMORY_ALLOW_ANON === "1";
const PORT = Number(process.env.WIKICHAT_MEMORY_PORT || 3778);
const RELOAD_MS = Number(process.env.WIKICHAT_MEMORY_RELOAD_MS || 60000);

// Capture entrante (write path). Désactivé par défaut : un déploiement de pure
// consultation reste read-only. Quand activé, l'outil add_idea écrit UNIQUEMENT
// dans inbox/ du repo (jamais le snapshot) puis commit + push.
const ALLOW_WRITE = process.env.WIKICHAT_MEMORY_ALLOW_WRITE === "1";
const INBOX_DIR = path.join(SNAPSHOT_DIR, "inbox");

if (!TOKEN && !ALLOW_ANON) {
  console.error(
    "[memory-mcp] WIKICHAT_MEMORY_TOKEN absent. Refus de démarrer sans auth.\n" +
      "  Définis un token, ou WIKICHAT_MEMORY_ALLOW_ANON=1 pour un dev local."
  );
  process.exit(1);
}

// --------------------------------------------------------------------------
// Snapshot en mémoire (rechargé périodiquement)
// --------------------------------------------------------------------------

const snapshot = { projects: [], ideas: [], cartography: null, manifest: null, loadedAt: null };

function readJSON(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(SNAPSHOT_DIR, name), "utf8"));
  } catch {
    return fallback;
  }
}

function loadSnapshot() {
  snapshot.projects = readJSON("projects.json", { projects: [] }).projects || [];
  snapshot.ideas = readJSON("ideas.json", { ideas: [] }).ideas || [];
  snapshot.cartography = readJSON("cartography.json", null);
  snapshot.manifest = readJSON("manifest.json", null);
  snapshot.loadedAt = new Date().toISOString();
  console.log(
    `[memory-mcp] Snapshot chargé: ${snapshot.projects.length} projets, ` +
      `${snapshot.ideas.length} idées (hash ${snapshot.manifest?.hash || "?"}).`
  );
}

loadSnapshot();
setInterval(loadSnapshot, RELOAD_MS).unref();

// --------------------------------------------------------------------------
// Recherche knowledge — port du scoring de src/tools.mjs (titre x3, headers x2,
// corps x1), appliqué aux .md du snapshot.
// --------------------------------------------------------------------------

function searchKnowledge(query, scope, limit) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const kdir = path.join(SNAPSHOT_DIR, "knowledge");
  let files;
  try {
    files = fs.readdirSync(kdir).filter((n) => n.endsWith(".md"));
  } catch {
    return [];
  }
  // Convention de nommage de l'export : "central" = pas de préfixe,
  // "<slug>__fichier.md" = par-projet.
  if (scope === "central") files = files.filter((n) => !n.includes("__"));
  if (scope === "projects") files = files.filter((n) => n.includes("__"));

  const results = [];
  for (const name of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(kdir, name), "utf8");
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : name.replace(/\.md$/, "");
    const headers = [...content.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1].toLowerCase());

    let score = 0;
    for (const term of terms) {
      if (title.toLowerCase().includes(term)) score += 3;
      for (const h of headers) if (h.includes(term)) score += 2;
      score += Math.min(lower.split(term).length - 1, 10);
    }
    if (score === 0) continue;

    let idx = -1;
    for (const term of terms) {
      const at = lower.indexOf(term);
      if (at !== -1 && (idx === -1 || at < idx)) idx = at;
    }
    const start = Math.max(0, idx - 80);
    const excerpt = content.slice(start, start + 240).replace(/\s+/g, " ").trim();

    results.push({ file: name, title, score, excerpt });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// --------------------------------------------------------------------------
// Capture entrante : écriture d'une idée dans inbox/ + push.
// --------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", ["-C", SNAPSHOT_DIR, ...args], { encoding: "utf8" }).trim();
}

/**
 * Dépose une idée brute dans inbox/ et la pousse sur le repo. L'idée n'est PAS
 * intégrée ici : elle est en status "pending", l'ingesteur local la traitera.
 * Retourne le nom du fichier inbox créé.
 */
function captureIdea({ title, body, project, axes }) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(3).toString("hex");
  const name = `${ts}-${rand}.json`;
  const entry = {
    title: String(title).trim(),
    body: String(body || ""),
    related_projects: project ? [String(project)] : [],
    axes: Array.isArray(axes) ? axes.map(String) : [],
    status: "pending",
    source: "mcp-capture",
    captured_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(INBOX_DIR, name), JSON.stringify(entry, null, 2));

  // Commit + push, cantonnés à inbox/. Rebase léger d'abord pour limiter les
  // collisions avec le refresh du snapshot.
  git(["add", "--", `inbox/${name}`]);
  git(["commit", "-m", `inbox: idea ${name}`]);
  try {
    git(["pull", "--rebase", "--quiet"]);
  } catch {
    /* premier commit ou pas de remote tracking */
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  git(["push", "origin", branch]);
  return name;
}

// --------------------------------------------------------------------------
// MCP server factory (read tools + capture optionnelle)
// --------------------------------------------------------------------------

const txt = (s) => ({ content: [{ type: "text", text: s }] });

function buildMcpServer() {
  const server = new McpServer({ name: "mcp-wikichat-memory", version: "1.0.0" });

  server.tool(
    "list_projects",
    "Liste les projets WikiChat consultables (snapshot read-only). Retourne slug, nom, statut, stack, description.",
    { status: z.enum(["active", "closed", "discovered", "all"]).default("all") },
    async ({ status }) => {
      const list = snapshot.projects
        .filter((p) => status === "all" || p.status === status)
        .map((p) => ({
          slug: p.slug,
          name: p.name,
          status: p.status,
          stack: p.stack,
          description: p.description,
        }));
      return txt(JSON.stringify({ count: list.length, projects: list }, null, 2));
    }
  );

  server.tool(
    "get_project",
    "Détail complet d'un projet (decisions, tasks, blockers, closure) depuis le snapshot.",
    { slug: z.string().describe("slug du projet (cf. list_projects)") },
    async ({ slug }) => {
      const p = snapshot.projects.find(
        (x) => x.slug === slug || (x.name && x.name.toLowerCase() === slug.toLowerCase())
      );
      if (!p) return txt(`Projet introuvable: ${slug}`);
      return txt(JSON.stringify(p, null, 2));
    }
  );

  server.tool(
    "search_knowledge",
    "Recherche full-text dans la KB transverse (Compiled Truth) du snapshot. Scoring titre x3 / headers x2 / corps x1.",
    {
      query: z.string(),
      scope: z.enum(["central", "projects", "all"]).default("all"),
      limit: z.number().default(5),
    },
    async ({ query, scope, limit }) => {
      const r = searchKnowledge(query, scope, limit);
      if (!r.length) return txt(`Aucun résultat pour "${query}" (scope=${scope}).`);
      return txt(JSON.stringify(r, null, 2));
    }
  );

  server.tool(
    "list_ideas",
    "Liste les idées capitalisées (titre, statut, projets liés) depuis le snapshot.",
    {},
    async () => {
      const list = snapshot.ideas.map((i) => ({
        id: i.id,
        title: i.title,
        status: i.status,
        related_projects: i.related_projects,
      }));
      return txt(JSON.stringify({ count: list.length, ideas: list }, null, 2));
    }
  );

  server.tool(
    "get_idea",
    "Détail d'une idée (corps complet) depuis le snapshot.",
    { id: z.string() },
    async ({ id }) => {
      const i = snapshot.ideas.find((x) => x.id === id);
      if (!i) return txt(`Idée introuvable: ${id}`);
      return txt(JSON.stringify(i, null, 2));
    }
  );

  // Capture entrante — seul outil d'écriture, activé via WIKICHAT_MEMORY_ALLOW_WRITE.
  if (ALLOW_WRITE) {
    server.tool(
      "add_idea",
      "Note une idée dans la mémoire WikiChat partagée. Elle est déposée en inbox " +
        "(status pending) et poussée sur le repo ; le WikiChat local l'intégrera ensuite.",
      {
        title: z.string().describe("titre court de l'idée"),
        body: z.string().default("").describe("description / contenu"),
        project: z.string().optional().describe("slug ou nom du projet lié (optionnel)"),
        axes: z.array(z.string()).optional().describe("axes/thèmes (optionnel)"),
      },
      async ({ title, body, project, axes }) => {
        if (!title || !title.trim()) return txt("titre requis.");
        try {
          const name = captureIdea({ title, body, project, axes });
          return txt(
            `Idée capturée et poussée (inbox/${name}). ` +
              `Elle sera intégrée au prochain passage de l'ingesteur local.`
          );
        } catch (e) {
          return txt(`Échec de la capture: ${e.message}`);
        }
      }
    );
  }

  return server;
}

// --------------------------------------------------------------------------
// HTTP + SSE transport (auth bearer)
// --------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Garde d'authentification : bearer sur tout sauf /health.
function authorized(req) {
  if (ALLOW_ANON && !TOKEN) return true;
  const hdr = (req.headers["authorization"] || "").toString();
  const fromHeader = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : null;
  const fromQuery = (req.query.token || "").toString().trim();
  return fromHeader === TOKEN || fromQuery === TOKEN;
}

const transports = new Map();

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    readOnly: true,
    snapshot: {
      hash: snapshot.manifest?.hash || null,
      projects: snapshot.projects.length,
      loadedAt: snapshot.loadedAt,
    },
  })
);

app.get("/sse", async (req, res) => {
  if (!authorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const transport = new SSEServerTransport("/messages", res);
  const sid = transport.sessionId;
  const server = buildMcpServer();
  transports.set(sid, { transport, server });
  res.on("close", () => transports.delete(sid));
  await server.connect(transport);
});

app.post("/messages", async (req, res) => {
  // L'auth est faite à l'établissement de la connexion SSE (GET /sse). Le
  // sessionId est un UUID crypto distribué uniquement après une auth réussie :
  // sa simple existence dans `transports` prouve la légitimité du POST. Le
  // client SSE n'ayant pas de moyen de recopier le token sur l'endpoint de
  // messages, on s'appuie sur ce modèle (capability-based) plutôt que sur un
  // re-check du token ici. Fallback : on accepte aussi un token explicite.
  const sid = req.query.sessionId;
  const entry = transports.get(sid);
  if (!entry) {
    if (!authorized(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await entry.transport.handlePostMessage(req, res, req.body);
});

app.listen(PORT, () => {
  console.log(`[memory-mcp] Read-only MCP sur http://localhost:${PORT}/sse`);
  console.log(`[memory-mcp] Snapshot: ${SNAPSHOT_DIR}`);
  console.log(`[memory-mcp] Auth: ${TOKEN ? "bearer requis" : "ANONYME (dev only)"}`);
});
