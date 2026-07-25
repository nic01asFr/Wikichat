/**
 * ideas.mjs — Idea pool persistence + CRUD.
 *
 * Ideas are first-class objects that live OUTSIDE projects : a holding pen
 * for thoughts before they're scoped into a project. The Harmonizer routine
 * (J4) clusters them ; the Bootstrapper (later) turns a scoped idea into
 * a project skeleton. Until then, ideas just accumulate and get tagged.
 *
 * Storage : ~/.wikichat/ideas/<id>.json — one file per idea, atomic writes.
 * One-file-per-idea makes them easy to inspect, version, sync (git), and
 * survive corruption (a single broken file doesn't kill the pool).
 *
 * Schema :
 *   id, title, body, axes[], related_projects[], status, source,
 *   created_at, updated_at, created_by,
 *   cluster_id (set by Harmonizer), similar_to[] (set by Harmonizer)
 *
 * Status flow : raw → clustered → scoped → started | shelved
 */

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";

const IDEAS_DIR = path.join(os.homedir(), ".wikichat", "ideas");

const VALID_STATUS = new Set(["raw", "clustered", "scoped", "started", "shelved"]);
const VALID_SOURCE = new Set(["user", "channel", "closure", "git-signal", "harmonizer"]);

// In-memory cache : Map<id, idea>. Hydrated on first access, kept in sync on writes.
let _cache = null;

function _ensureDir() {
  fs.mkdirSync(IDEAS_DIR, { recursive: true });
}

function _writeAtomic(filepath, data) {
  const tmp = `${filepath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, filepath);
}

function _loadAll() {
  _ensureDir();
  const map = new Map();
  for (const f of fs.readdirSync(IDEAS_DIR).filter(f => f.endsWith(".json") && !f.endsWith(".tmp"))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(IDEAS_DIR, f), "utf8"));
      if (data?.id) map.set(data.id, data);
    } catch { /* corrupt file — skip, don't crash the pool */ }
  }
  return map;
}

export function loadIdeas() {
  if (!_cache) _cache = _loadAll();
  return _cache;
}

export function getIdea(id) {
  return loadIdeas().get(id) || null;
}

/**
 * Create a new idea. Returns the persisted idea object.
 *
 * @param {object} opts
 * @param {string} opts.title         Required, short headline
 * @param {string} [opts.body]        Longer description
 * @param {string[]} [opts.axes]      KB axes this idea touches
 * @param {string[]} [opts.related_projects]  Existing project names connected to this idea
 * @param {string} [opts.source]      "user" | "channel" | "closure" | "git-signal" | "harmonizer"
 * @param {string} [opts.created_by]  Author display name
 */
export function createIdea({ title, body = "", axes = [], related_projects = [], source = "user", created_by = "anonymous" }) {
  if (!title || typeof title !== "string") throw new Error("idea.title required");
  if (!VALID_SOURCE.has(source)) source = "user";
  const now = new Date().toISOString();
  const idea = {
    id: randomUUID().slice(0, 12),
    title: title.trim(),
    body: String(body),
    axes: Array.from(new Set(axes.map(s => String(s).trim().toLowerCase()).filter(Boolean))),
    related_projects: Array.from(new Set(related_projects.filter(Boolean))),
    status: "raw",
    source,
    created_at: now,
    updated_at: now,
    created_by,
    cluster_id: null,
    similar_to: [],
  };
  loadIdeas().set(idea.id, idea);
  _writeAtomic(path.join(IDEAS_DIR, `${idea.id}.json`), idea);
  return idea;
}

/**
 * Partial update. Only the fields provided are touched. Returns the updated
 * idea, or null if id not found.
 */
export function updateIdea(id, patch = {}) {
  const idea = loadIdeas().get(id);
  if (!idea) return null;
  if (patch.title !== undefined) idea.title = String(patch.title).trim();
  if (patch.body !== undefined) idea.body = String(patch.body);
  if (patch.axes !== undefined) {
    idea.axes = Array.from(new Set(patch.axes.map(s => String(s).trim().toLowerCase()).filter(Boolean)));
  }
  if (patch.related_projects !== undefined) {
    idea.related_projects = Array.from(new Set(patch.related_projects.filter(Boolean)));
  }
  if (patch.status !== undefined) {
    if (!VALID_STATUS.has(patch.status)) throw new Error(`invalid status: ${patch.status}`);
    idea.status = patch.status;
  }
  if (patch.cluster_id !== undefined) idea.cluster_id = patch.cluster_id;
  if (patch.similar_to !== undefined) idea.similar_to = patch.similar_to;
  idea.updated_at = new Date().toISOString();
  _writeAtomic(path.join(IDEAS_DIR, `${id}.json`), idea);
  return idea;
}

/** Hard delete — removes the file from disk. Use shelved status to soft-archive. */
export function deleteIdea(id) {
  const cache = loadIdeas();
  if (!cache.has(id)) return false;
  cache.delete(id);
  try { fs.unlinkSync(path.join(IDEAS_DIR, `${id}.json`)); } catch { /* */ }
  return true;
}

/**
 * List ideas with optional filters. Returns a sorted array (most recent first).
 *
 * @param {object} [filter]
 * @param {string} [filter.status]            Match exact status
 * @param {string} [filter.axis]              Match if axis is in idea.axes
 * @param {string} [filter.project]           Match if project name in idea.related_projects (case-insensitive)
 * @param {number} [filter.since_days]        Only ideas updated in the last N days
 * @param {number} [filter.limit]             Cap results
 */
export function listIdeas(filter = {}) {
  const all = [...loadIdeas().values()];
  let out = all;
  if (filter.status) out = out.filter(i => i.status === filter.status);
  if (filter.axis) {
    const a = String(filter.axis).toLowerCase();
    out = out.filter(i => (i.axes || []).includes(a));
  }
  if (filter.project) {
    const p = String(filter.project).toLowerCase();
    out = out.filter(i => (i.related_projects || []).some(r => r.toLowerCase() === p));
  }
  if (typeof filter.since_days === "number") {
    const cutoff = Date.now() - filter.since_days * 24 * 60 * 60 * 1000;
    out = out.filter(i => new Date(i.updated_at).getTime() >= cutoff);
  }
  out.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  if (typeof filter.limit === "number" && filter.limit > 0) out = out.slice(0, filter.limit);
  return out;
}

/**
 * Simple keyword search across title + body + axes. Returns scored matches
 * (basic AND-of-terms, no embeddings — Harmonizer J4 will add similarity).
 */
export function searchIdeas(query, { limit = 10 } = {}) {
  const terms = String(query || "").toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (terms.length === 0) return [];
  const all = [...loadIdeas().values()];
  const scored = [];
  for (const idea of all) {
    const hay = `${idea.title} ${idea.body} ${(idea.axes || []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (hay.includes(t)) score += idea.title.toLowerCase().includes(t) ? 3 : 1;
    }
    if (score > 0) scored.push({ idea, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.idea);
}

/**
 * Stats helper — used by `list_ideas` summary header and the Harmonizer.
 * Returns counts per status, per axis, total.
 */
export function ideaStats() {
  const all = [...loadIdeas().values()];
  const byStatus = {};
  const byAxis = {};
  for (const i of all) {
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    for (const a of i.axes || []) byAxis[a] = (byAxis[a] || 0) + 1;
  }
  return { total: all.length, by_status: byStatus, by_axis: byAxis };
}

/** Reset the in-memory cache — used by tests and after bulk file edits. */
export function reloadIdeas() {
  _cache = _loadAll();
  return _cache.size;
}
