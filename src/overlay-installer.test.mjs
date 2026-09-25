/**
 * overlay-installer.test.mjs — Le bloc de ~/.claude/CLAUDE.md et la skill
 * ne disent que ce qui est vrai sur toutes les surfaces.
 *
 * Usage : node --test src/overlay-installer.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

const MAISON = fs.mkdtempSync(path.join(os.tmpdir(), "wikichat-overlay-"));
process.env.HOME = MAISON;
process.env.USERPROFILE = MAISON;
delete process.env.WIKICHAT_NO_OVERLAY_INSTALL;

const { ensureUserOverlay } = await import("./overlay-installer.mjs");
const CLAUDE = path.join(MAISON, ".claude");
const SKILL = path.join(CLAUDE, "skills", "wikichat", "SKILL.md");
const silencieux = () => {};

test("bloc CLAUDE.md : plus de réflexe register, over/standby et search_knowledge gardés", () => {
  fs.mkdirSync(CLAUDE, { recursive: true });
  fs.writeFileSync(path.join(CLAUDE, "CLAUDE.md"), "# Mes règles\n\nNe pas toucher.\n");
  ensureUserOverlay({ log: silencieux });
  const md = fs.readFileSync(path.join(CLAUDE, "CLAUDE.md"), "utf8");
  assert.ok(md.startsWith("# Mes règles\n\nNe pas toucher."), "contenu de l'utilisateur modifié");
  assert.ok(!/register\(name=/.test(md), "le bloc demande encore un register");
  assert.ok(!/Au début de session/.test(md));
  assert.match(md, /N'appelle pas `register` pour te présenter/);
  assert.match(md, /status="over"/);
  assert.match(md, /status="standby"/);
  assert.match(md, /search_knowledge/);
  assert.match(md, /skill `wikichat`/);
});

test("skill installée : guetteur résolu, pas de register au début", () => {
  const skill = fs.readFileSync(SKILL, "utf8");
  assert.ok(!skill.includes("{{GUETTEUR}}"));
  assert.match(skill, /wikichat-attendre-courrier\.mjs/);
  assert.match(skill, /wikichat:skill-version 2/);
  assert.ok(!/À faire au début de session/.test(skill));
});

test("skill d'une version antérieure : remplacée, ancienne gardée en .bak", () => {
  fs.writeFileSync(SKILL, "# vieille skill\n1. register(name=...) au début\n");
  ensureUserOverlay({ log: silencieux });
  assert.match(fs.readFileSync(SKILL, "utf8"), /wikichat:skill-version 2/);
  assert.match(fs.readFileSync(SKILL + ".bak", "utf8"), /vieille skill/);
});

test("skill déjà à jour : laissée telle quelle", () => {
  const avant = fs.readFileSync(SKILL, "utf8") + "\n<!-- ajout perso -->\n";
  fs.writeFileSync(SKILL, avant);
  ensureUserOverlay({ log: silencieux });
  assert.equal(fs.readFileSync(SKILL, "utf8"), avant);
});

test.after(() => { try { fs.rmSync(MAISON, { recursive: true, force: true }); } catch { /* */ } });
