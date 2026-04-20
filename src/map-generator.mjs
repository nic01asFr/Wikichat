/**
 * map-generator.mjs — Tom Nook's island generation algorithm
 *
 * Generates map.json from the project registry.
 * Called once on first setup, or when user requests a full remap.
 * Result is written to .wikichat/map.json and never auto-updated.
 *
 * Clustering is THEMATIC (subjects, domains) not technical (tech stack).
 */

import fs from "fs";
import path from "path";
import os from "os";

// ── Thematic keyword mapping ───────────────────────────────────────────────

const THEMES = {
  "data-public": {
    name: "Quartier des Données",
    keywords: ["data", "dataset", "opendata", "gouv", "stats", "analytics", "csv", "api", "metrics", "grist", "airtable", "base"],
    palette: { floor: "#0a0e18", path: "#2a3a7a", accent: "#a371f7", wall: "#141828", roof: "#6644cc", smoke: "#bb88ee", water: "#442288" },
  },
  "ai-agents": {
    name: "Nexus des Agents",
    keywords: ["claude", "anthropic", "mcp", "agent", "llm", "ai", "openai", "prompt", "wikichat", "chat", "assistant", "model"],
    palette: { floor: "#120820", path: "#3a1a6a", accent: "#bc8cff", wall: "#2a1050", roof: "#8855cc", smoke: "#cc99ff", water: "#6622aa" },
  },
  "creative-tools": {
    name: "Atelier Créatif",
    keywords: ["design", "art", "visual", "pixel", "game", "creative", "generative", "image", "video", "music", "canvas", "animation", "3d", "render"],
    palette: { floor: "#1a0e08", path: "#7a3a10", accent: "#ffa657", wall: "#3a1808", roof: "#cc6622", smoke: "#ffbb88", water: "#aa4410" },
  },
  "infrastructure": {
    name: "Port Conteneur",
    keywords: ["docker", "deploy", "server", "infra", "devops", "ci", "cd", "pipeline", "k8s", "cloud", "hosting", "nginx", "proxy"],
    palette: { floor: "#040e14", path: "#145a7a", accent: "#2196f3", wall: "#082030", roof: "#1166aa", smoke: "#66aadd", water: "#0a4488" },
  },
  "web-apps": {
    name: "Cristal Web",
    keywords: ["web", "app", "react", "vue", "frontend", "backend", "api", "site", "dashboard", "ui", "ux", "interface", "portal", "platform"],
    palette: { floor: "#080e20", path: "#2040aa", accent: "#58a6ff", wall: "#101830", roof: "#3366cc", smoke: "#88aaff", water: "#2244aa" },
  },
  "games": {
    name: "Terres du Jeu",
    keywords: ["game", "jeu", "level", "map", "world", "player", "score", "engine", "unity", "godot", "dungeon", "rpg", "simulation"],
    palette: { floor: "#0e2210", path: "#4a6a14", accent: "#5dd672", wall: "#1a3a1a", roof: "#6ab83a", smoke: "#aade88", water: "#3a8a20" },
  },
  "analysis": {
    name: "Archives",
    keywords: ["analysis", "audit", "report", "research", "monitor", "log", "trace", "inspect", "review", "scan", "survey", "benchmark"],
    palette: { floor: "#06060e", path: "#1a1a5a", accent: "#7a9aff", wall: "#0e0e22", roof: "#4455aa", smoke: "#9999ee", water: "#2233aa" },
  },
  "communication": {
    name: "Quartier des Échanges",
    keywords: ["chat", "message", "slack", "discord", "email", "notify", "alert", "channel", "broadcast", "social", "community"],
    palette: { floor: "#0e1a0e", path: "#3a6a3a", accent: "#56d364", wall: "#162016", roof: "#3a8a3a", smoke: "#88cc88", water: "#2a5a2a" },
  },
  "unknown": {
    name: "Terres Libres",
    keywords: [],
    palette: { floor: "#0c1406", path: "#4a5a2a", accent: "#8b949e", wall: "#182010", roof: "#5a6a4a", smoke: "#aab8a0", water: "#3a4a2a" },
  },
};

// ── Theme detection ────────────────────────────────────────────────────────

function detectTheme(project) {
  const text = [
    project.name || "",
    project.slug || "",
    project.description || "",
    (project.stack || []).join(" "),
  ].join(" ").toLowerCase();

  let best = "unknown";
  let bestScore = 0;

  for (const [themeId, theme] of Object.entries(THEMES)) {
    if (themeId === "unknown") continue;
    const score = theme.keywords.filter(kw => text.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      best = themeId;
    }
  }

  return best;
}

// ── Activity scoring ───────────────────────────────────────────────────────

function activityScore(project) {
  // Prefer updatedAt recency; fallback to deterministic hash of slug
  if (project.updatedAt) {
    const age = Date.now() - new Date(project.updatedAt).getTime();
    const days = age / (1000 * 60 * 60 * 24);
    if (days < 7)  return 1.0;
    if (days < 30) return 0.7;
    if (days < 90) return 0.4;
    return 0.1;
  }
  // Deterministic pseudo-score from slug
  let h = 0;
  for (const c of (project.slug || "")) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return 0.2 + (h % 100) / 200;
}

// ── Island layout ──────────────────────────────────────────────────────────

// Hub always at center
const HUB_POSITION = { x: 0, y: 0 };
const HUB_RADIUS = 180;

// Surrounding islands placed radially
function islandPositions(count) {
  const positions = [];
  const baseRadius = 420;
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    // Slight organic variation
    const r = baseRadius + (((i * 137) % 60) - 30);
    positions.push({
      x: Math.round(Math.cos(angle) * r),
      y: Math.round(Math.sin(angle) * r),
    });
  }
  return positions;
}

// Place houses within an island
function housePositions(count, islandX, islandY, radius = 90) {
  const positions = [];
  if (count === 0) return positions;
  if (count === 1) return [{ x: islandX, y: islandY }];
  for (let i = 0; i < count; i++) {
    const angle = (2 * Math.PI * i) / count;
    const r = radius * 0.45 + (radius * 0.45 * (i % 2));
    positions.push({
      x: Math.round(islandX + Math.cos(angle) * r),
      y: Math.round(islandY + Math.sin(angle) * r),
    });
  }
  return positions;
}

// ── Hub buildings ──────────────────────────────────────────────────────────

const HUB_BUILDINGS = [
  { id: "nook-inc",  type: "nook",    label: "Nook Inc.",     emoji: "🏠", x: -60, y: -30 },
  { id: "museum",    type: "museum",  label: "Musée",         emoji: "🦉", x:  60, y: -50 },
  { id: "tailor",    type: "tailor",  label: "Able Sisters",  emoji: "✂️", x: -80, y:  40 },
  { id: "roost",     type: "roost",   label: "The Roost",     emoji: "☕", x:  20, y:  60 },
  { id: "airport",   type: "airport", label: "Aéroport",      emoji: "✈️", x:  90, y:  30 },
  { id: "pier",      type: "pier",    label: "Ponton",        emoji: "⛵", x: -20, y:  90 },
];

// ── River generation ───────────────────────────────────────────────────────

function generateRivers(islands) {
  // Rivers are drawn between thematically distant island pairs
  const rivers = [];
  const themeGroups = {};
  for (const island of islands) {
    if (!themeGroups[island.theme]) themeGroups[island.theme] = [];
    themeGroups[island.theme].push(island.id);
  }
  // One river per major thematic boundary (simplified: hub to each cluster)
  for (const island of islands) {
    if (island.id === "hub") continue;
    rivers.push({
      id: `river-hub-${island.id}`,
      from: "hub",
      to: island.id,
      type: "thematic-boundary",
      label: island.theme_name,
    });
  }
  return rivers;
}

// ── Main generator ────────────────────────────────────────────────────────

export function generateMap(projects) {
  // 1. Group projects by theme
  const grouped = {};
  for (const project of projects) {
    const theme = detectTheme(project);
    if (!grouped[theme]) grouped[theme] = [];
    grouped[theme].push({ ...project, _theme: theme, _score: activityScore(project) });
  }

  // 2. Build hub island
  const hub = {
    id: "hub",
    name: "Hub Central",
    theme: "hub",
    theme_name: "Hub Central",
    palette: { floor: "#1a1608", path: "#7a6228", accent: "#f0c040", wall: "#3a2a10", roof: "#c8962a", smoke: "#f8e080", water: "#4a3a18" },
    position: HUB_POSITION,
    radius: HUB_RADIUS,
    buildings: HUB_BUILDINGS,
    projects: [],
  };

  // 3. Build theme islands
  const themeIds = Object.keys(grouped).filter(t => t !== "unknown");
  const unknownProjects = grouped["unknown"] || [];

  // Merge tiny themes (1 project) into unknown if too many islands
  const MAX_ISLANDS = 7;
  const finalThemes = [];
  for (const t of themeIds) {
    if (grouped[t].length >= 2 || themeIds.length <= MAX_ISLANDS) {
      finalThemes.push(t);
    } else {
      unknownProjects.push(...grouped[t]);
    }
  }
  if (unknownProjects.length > 0) finalThemes.push("unknown");
  if (unknownProjects.length > 0) grouped["unknown"] = unknownProjects;

  const positions = islandPositions(finalThemes.length);

  const islands = [hub];
  const bridges = [];

  for (let i = 0; i < finalThemes.length; i++) {
    const themeId = finalThemes[i];
    const themeProjects = grouped[themeId];
    const pos = positions[i];
    const theme = THEMES[themeId];

    // Sort by activity score descending, cap visible houses per island
    themeProjects.sort((a, b) => b._score - a._score);
    const MAX_HOUSES = 20;
    const visibleProjects = themeProjects.slice(0, MAX_HOUSES);

    const housePosArr = housePositions(visibleProjects.length, pos.x, pos.y);

    const island = {
      id: `island-${themeId}`,
      name: theme.name,
      theme: themeId,
      theme_name: theme.name,
      palette: theme.palette,
      position: pos,
      radius: 90 + Math.min(themeProjects.length * 10, 60),
      buildings: [],
      projects: visibleProjects.map((p, j) => ({
        slug: p.slug,
        name: p.name,
        activity_score: p._score,
        position: housePosArr[j] || pos,
        house: {
          light: p._score > 0.5,
          style: themeId,
        },
      })),
    };

    islands.push(island);

    // Bridge from hub to this island
    bridges.push({
      id: `bridge-hub-${island.id}`,
      from: "hub",
      to: island.id,
      type: "main",
      label: theme.name,
    });
  }

  // 4. Cross-island bridges (for projects with shared keywords — simplified)
  // Only add if 2+ islands share a likely dependency
  for (let i = 1; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      const a = islands[i];
      const b = islands[j];
      // ai-agents ↔ data-public often linked
      const linked = (
        (a.theme === "ai-agents" && b.theme === "data-public") ||
        (a.theme === "web-apps" && b.theme === "infrastructure") ||
        (a.theme === "games" && b.theme === "creative-tools")
      );
      if (linked) {
        bridges.push({
          id: `bridge-${a.id}-${b.id}`,
          from: a.id,
          to: b.id,
          type: "affinity",
          label: "affinité thématique",
        });
      }
    }
  }

  // 5. Rivers
  const rivers = generateRivers(islands);

  // 6. Build final map (aligned with map.schema.json)
  const map = {
    meta: {
      generated_at: new Date().toISOString(),
      generated_by: "tom-nook",
      version: 1,
      last_modified: null,
      canvas_width: 2000,
      canvas_height: 2000,
    },
    zones: {
      hub_central: { label: "Place Nook", description: "Hub permanent, toujours accessible.", bounds: { x: 900, y: 900, width: 200, height: 200 } },
      active:       { label: "Quartiers actifs", description: "Clusters actifs ces 30 derniers jours.", bounds: { x: 100, y: 100, width: 1800, height: 1800 } },
      archive:      { label: "Archipel de la Forêt", description: "Projets dormants.", bounds: { x: 1600, y: 1600, width: 300, height: 300 } },
      unknown_waters: { label: "Eaux inconnues", description: "Kapp'n requis.", bounds: { x: 0, y: 1800, width: 500, height: 200 } },
      foreign_islands: { label: "Îles étrangères", description: "Autres instances WikiChat.", bounds: { x: 1800, y: 0, width: 200, height: 200 } },
    },
    islands: islands.map(island => ({
      ...island,
      zone: island.id === "hub" ? "hub_central"
          : island.projects?.every(p => p.activity_score < 0.3) ? "archive"
          : "active",
      shape: {
        type: "ellipse",
        rx: island.radius || 90,
        ry: Math.round((island.radius || 90) * 0.75),
        points: [],
      },
      villager_slots: (island.projects || []).map((p, i) => ({
        slot_id: `${island.id}-slot-${i + 1}`,
        position: p.position ? { x: p.position.x - island.position.x, y: p.position.y - island.position.y } : { x: 0, y: 0 },
        project_slug: p.slug || null,
      })),
      flowers: [],
    })),
    clusters: finalThemes.map((themeId, i) => ({
      id: `cluster-${themeId}`,
      island_id: `island-${themeId}`,
      theme: themeId,
      label: THEMES[themeId].name,
      project_slugs: (grouped[themeId] || []).map(p => p.slug),
    })),
    bridges,
    rivers,
    buildings: HUB_BUILDINGS.map(b => ({ ...b, island_id: "hub" })),
  };

  return map;
}
