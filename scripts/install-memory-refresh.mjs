#!/usr/bin/env node
/**
 * install-memory-refresh.mjs — tâche autonome quotidienne (brique 2).
 *
 * Provisionne un déclencheur planifié qui lance scripts/publish-memory.mjs une
 * fois par jour : filet de sécurité qui capture tout ce qui ne passe pas par le
 * hook close_project (décisions, tasks, knowledge mis à jour en cours de route).
 *
 *   - Windows : Task Scheduler, /SC DAILY
 *   - macOS   : launchd LaunchAgent, StartCalendarInterval
 *   - Linux   : crontab utilisateur, entrée quotidienne
 *
 * Idempotent : re-run remplace l'entrée existante.
 *
 * Usage :
 *   node scripts/install-memory-refresh.mjs --repo <dir> [--at HH:MM]
 *   node scripts/install-memory-refresh.mjs --uninstall
 */

import os from "os";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const NODE_BIN = process.execPath;
const PUBLISH_ENTRY = path.join(REPO_ROOT, "scripts", "publish-memory.mjs");
const TASK_NAME = "WikiChatMemoryRefresh";
const SERVICE_LABEL = "com.wikichat.memory-refresh";

const argv = process.argv.slice(2);
const argVal = (n) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const UNINSTALL = argv.includes("--uninstall");
const MEMORY_REPO = argVal("--repo") || process.env.WIKICHAT_MEMORY_REPO;
const AT = argVal("--at") || "03:30"; // heure de run par défaut (creux)

function fail(msg) {
  console.error(`[memory-refresh] ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`[memory-refresh] ${msg}`);
}

if (!UNINSTALL && !MEMORY_REPO)
  fail("Repo privé requis : --repo <dir> ou WIKICHAT_MEMORY_REPO.");

const [hh, mm] = AT.split(":");

// --------------------------------------------------------------------------
// Windows — Task Scheduler
// --------------------------------------------------------------------------

function installWindows() {
  const wrapperPath = path.join(os.homedir(), ".wikichat", "memory-refresh.cmd");
  if (UNINSTALL) {
    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "ignore" });
    } catch {
      /* pas installé */
    }
    fs.rmSync(wrapperPath, { force: true });
    return ok("Tâche supprimée.");
  }
  // Wrapper .cmd : contourne le quoting brutal de schtasks /TR (chemins avec
  // espaces + quotes imbriquées). cwd hérité d'une tâche = System32, d'où le cd.
  const wrapper =
    `@echo off\r\n` +
    `cd /d "${REPO_ROOT}"\r\n` +
    `set "WIKICHAT_MEMORY_REPO=${MEMORY_REPO}"\r\n` +
    `"${NODE_BIN}" "${PUBLISH_ENTRY}" --repo "${MEMORY_REPO}"\r\n`;
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, wrapper);
  execSync(
    `schtasks /Create /TN "${TASK_NAME}" /TR "\\"${wrapperPath}\\"" /SC DAILY /ST ${hh}:${mm} /F`,
    { stdio: "inherit" }
  );
  ok(`Tâche quotidienne créée (${AT}). Wrapper: ${wrapperPath}`);
  ok(`Test : schtasks /Run /TN "${TASK_NAME}"`);
}

// --------------------------------------------------------------------------
// macOS — launchd
// --------------------------------------------------------------------------

function installMac() {
  const plistPath = path.join(
    os.homedir(),
    "Library",
    "LaunchAgents",
    `${SERVICE_LABEL}.plist`
  );
  if (UNINSTALL) {
    try {
      execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
    } catch {
      /* non chargé */
    }
    fs.rmSync(plistPath, { force: true });
    return ok("LaunchAgent supprimé.");
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>
  <key>EnvironmentVariables</key><dict><key>WIKICHAT_MEMORY_REPO</key><string>${MEMORY_REPO}</string></dict>
  <key>ProgramArguments</key>
  <array><string>${NODE_BIN}</string><string>${PUBLISH_ENTRY}</string><string>--repo</string><string>${MEMORY_REPO}</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(hh)}</integer><key>Minute</key><integer>${Number(mm)}</integer></dict>
</dict></plist>`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch {
    /* premier install */
  }
  execSync(`launchctl load "${plistPath}"`, { stdio: "inherit" });
  ok(`LaunchAgent installé (${AT}).`);
}

// --------------------------------------------------------------------------
// Linux — crontab
// --------------------------------------------------------------------------

function installLinux() {
  const marker = `# ${SERVICE_LABEL}`;
  let current = "";
  try {
    current = execSync("crontab -l", { encoding: "utf8" });
  } catch {
    /* pas de crontab */
  }
  const cleaned = current
    .split("\n")
    .filter((l) => !l.includes(marker))
    .join("\n")
    .trim();
  if (UNINSTALL) {
    execSync(`printf '%s\\n' ${JSON.stringify(cleaned)} | crontab -`, { shell: "/bin/bash" });
    return ok("Entrée crontab supprimée.");
  }
  const line =
    `${Number(mm)} ${Number(hh)} * * * cd "${REPO_ROOT}" && ` +
    `WIKICHAT_MEMORY_REPO="${MEMORY_REPO}" "${NODE_BIN}" "${PUBLISH_ENTRY}" --repo "${MEMORY_REPO}" ${marker}`;
  const next = (cleaned ? cleaned + "\n" : "") + line + "\n";
  execSync(`printf '%s' ${JSON.stringify(next)} | crontab -`, { shell: "/bin/bash" });
  ok(`Entrée crontab installée (${AT}).`);
}

// --------------------------------------------------------------------------

switch (process.platform) {
  case "win32":
    installWindows();
    break;
  case "darwin":
    installMac();
    break;
  case "linux":
    installLinux();
    break;
  default:
    fail(`Plateforme non supportée: ${process.platform}`);
}
