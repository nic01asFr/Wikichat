#!/usr/bin/env node
/**
 * install-memory-refresh.mjs — battement de cœur autonome de la mémoire.
 *
 * Provisionne un déclencheur planifié qui lance scripts/sync-memory.mjs à
 * intervalle régulier (défaut 15 min). Chaque passage ferme la boucle dans les
 * deux sens : ingest des idées capturées (inbox -> local) puis publish du
 * snapshot (local -> repo). Idempotent quand rien n'a bougé.
 *
 *   - Windows : Task Scheduler, /SC MINUTE /MO N
 *   - macOS   : launchd LaunchAgent, StartInterval
 *   - Linux   : crontab utilisateur, intervalle de N minutes
 *
 * Idempotent : re-run remplace l'entrée existante.
 *
 * Usage :
 *   node scripts/install-memory-refresh.mjs --repo <dir> [--every <minutes>]
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
const SYNC_ENTRY = path.join(REPO_ROOT, "scripts", "sync-memory.mjs");
const TASK_NAME = "WikiChatMemoryRefresh";
const SERVICE_LABEL = "com.wikichat.memory-refresh";

const argv = process.argv.slice(2);
const argVal = (n) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const UNINSTALL = argv.includes("--uninstall");
const MEMORY_REPO = argVal("--repo") || process.env.WIKICHAT_MEMORY_REPO;
// Intervalle du sync bidirectionnel (ingest entrant + publish sortant), minutes.
const EVERY = String(Math.max(1, Number(argVal("--every") || 15)));

function fail(msg) {
  console.error(`[memory-refresh] ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`[memory-refresh] ${msg}`);
}

if (!UNINSTALL && !MEMORY_REPO)
  fail("Repo privé requis : --repo <dir> ou WIKICHAT_MEMORY_REPO.");

// --------------------------------------------------------------------------
// Windows — Task Scheduler
// --------------------------------------------------------------------------

function installWindows() {
  const wrapperPath = path.join(os.homedir(), ".wikichat", "memory-refresh.cmd");
  const vbsPath = path.join(os.homedir(), ".wikichat", "memory-refresh.vbs");
  const logPath = path.join(os.homedir(), ".wikichat", "memory-sync.log");
  if (UNINSTALL) {
    try {
      execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "ignore" });
    } catch {
      /* pas installé */
    }
    fs.rmSync(wrapperPath, { force: true });
    fs.rmSync(vbsPath, { force: true });
    return ok("Tâche supprimée.");
  }
  // Wrapper .cmd : contourne le quoting brutal de schtasks /TR (chemins avec
  // espaces + quotes imbriquées). cwd hérité d'une tâche = System32, d'où le cd.
  // La sortie va dans un log (jamais à l'écran).
  const wrapper =
    `@echo off\r\n` +
    `cd /d "${REPO_ROOT}"\r\n` +
    `set "WIKICHAT_MEMORY_REPO=${MEMORY_REPO}"\r\n` +
    `"${NODE_BIN}" "${SYNC_ENTRY}" --repo "${MEMORY_REPO}" >> "${logPath}" 2>&1\r\n`;
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, wrapper);

  // Launcher .vbs : exécute le .cmd en fenêtre CACHÉE (WindowStyle 0). Sans ça,
  // Task Scheduler ouvre une console visible dans la session de l'utilisateur.
  const vbs =
    `' Sync mémoire WikiChat — exécution invisible (pas de fenêtre console).\r\n` +
    `Dim WshShell\r\n` +
    `Set WshShell = CreateObject("WScript.Shell")\r\n` +
    `WshShell.Run "cmd /c " & Chr(34) & "${wrapperPath}" & Chr(34), 0, False\r\n`;
  fs.writeFileSync(vbsPath, vbs, "utf8");

  // La tâche lance wscript sur le .vbs → tout reste caché.
  execSync(
    `schtasks /Create /TN "${TASK_NAME}" /TR "wscript.exe //nologo \\"${vbsPath}\\"" /SC MINUTE /MO ${EVERY} /F`,
    { stdio: "inherit" }
  );
  ok(`Tâche de sync créée (toutes les ${EVERY} min, fenêtre cachée).`);
  ok(`Log: ${logPath}`);
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
  <array><string>${NODE_BIN}</string><string>${SYNC_ENTRY}</string><string>--repo</string><string>${MEMORY_REPO}</string></array>
  <key>StartInterval</key><integer>${Number(EVERY) * 60}</integer>
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
    `*/${Number(EVERY)} * * * * cd "${REPO_ROOT}" && ` +
    `WIKICHAT_MEMORY_REPO="${MEMORY_REPO}" "${NODE_BIN}" "${SYNC_ENTRY}" --repo "${MEMORY_REPO}" ${marker}`;
  const next = (cleaned ? cleaned + "\n" : "") + line + "\n";
  execSync(`printf '%s' ${JSON.stringify(next)} | crontab -`, { shell: "/bin/bash" });
  ok(`Entrée crontab installée (toutes les ${EVERY} min).`);
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
