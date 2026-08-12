#!/usr/bin/env node
/**
 * install-memory-server.mjs — rend le serveur MCP mémoire persistant au logon.
 *
 * Provisionne un démarrage automatique du serveur read-only (brique 3) en
 * local, pour qu'il tourne sans dépendre d'une session Claude Code :
 *   - Windows : launcher .vbs caché dans le dossier Démarrage
 *   - macOS   : launchd LaunchAgent (RunAtLoad)
 *   - Linux   : systemd --user unit
 *
 * Le secret n'est JAMAIS écrit dans le launcher : on référence un fichier-token
 * (WIKICHAT_MEMORY_TOKEN_FILE) dont le chemin seul figure dans la config. Le
 * serveur lit le token depuis ce fichier au démarrage.
 *
 * Usage :
 *   node scripts/install-memory-server.mjs --repo <snapshot-dir> [--token-file <path>] [--port 3778]
 *   node scripts/install-memory-server.mjs --uninstall
 *
 * Le fichier-token (défaut ~/.wikichat/memory-token.txt) doit contenir le token
 * en clair — à créer par l'utilisateur (le secret n'est pas géré par ce script).
 */

import os from "os";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const NODE_BIN = process.execPath;
const SERVER_ENTRY = path.join(REPO_ROOT, "remote", "memory-mcp-server.mjs");
const TASK_NAME = "WikiChatMemoryServer";
const SERVICE_LABEL = "com.wikichat.memory-server";

const argv = process.argv.slice(2);
const argVal = (n) => {
  const i = argv.indexOf(n);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};
const UNINSTALL = argv.includes("--uninstall");
const SNAPSHOT = argVal("--repo") || process.env.WIKICHAT_MEMORY_REPO;
const TOKEN_FILE =
  argVal("--token-file") || path.join(os.homedir(), ".wikichat", "memory-token.txt");
const PORT = argVal("--port") || "3778";
const WRITE = argv.includes("--write"); // active la capture entrante (add_idea)
const STDOUT = path.join(os.homedir(), ".wikichat", "memory-server.log");

function fail(msg) {
  console.error(`[memory-server] ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`[memory-server] ${msg}`);
}

if (!UNINSTALL && !SNAPSHOT)
  fail("Dossier snapshot requis : --repo <dir> (clone local du repo privé).");

// --------------------------------------------------------------------------
// Windows — launcher .vbs caché dans le dossier Démarrage
// --------------------------------------------------------------------------

function installWindows() {
  const startupDir = path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup"
  );
  const vbsPath = path.join(startupDir, "WikiChatMemoryServer.vbs");
  if (UNINSTALL) {
    fs.rmSync(vbsPath, { force: true });
    return ok("Launcher de démarrage supprimé.");
  }
  if (!fs.existsSync(startupDir)) fail(`Dossier Démarrage introuvable: ${startupDir}`);

  // cwd hérité d'un lancement Startup = System32 → cd dans le repo. Variables
  // d'env (chemins, pas de secret), puis node. stdout/err redirigés vers le log.
  const cd = `cd /d "${REPO_ROOT}"`;
  const env =
    `set "WIKICHAT_MEMORY_SNAPSHOT=${SNAPSHOT}" && ` +
    `set "WIKICHAT_MEMORY_TOKEN_FILE=${TOKEN_FILE}" && ` +
    `set "WIKICHAT_MEMORY_PORT=${PORT}"` +
    (WRITE ? ` && set "WIKICHAT_MEMORY_ALLOW_WRITE=1"` : "");
  const innerCmd = `${cd} && ${env} && "${NODE_BIN}" "${SERVER_ENTRY}" > "${STDOUT}" 2>&1`;
  const vbsEscaped = innerCmd.replace(/"/g, '""');
  const vbs =
    `' WikiChat Memory MCP server — démarrage caché au logon.\r\n` +
    `' Idempotent : supprimer ce fichier pour désactiver.\r\n` +
    `Dim WshShell\r\n` +
    `Set WshShell = CreateObject("WScript.Shell")\r\n` +
    `WshShell.Run "cmd /c ${vbsEscaped}", 0, False\r\n`;
  fs.writeFileSync(vbsPath, vbs, "utf8");
  ok(`Launcher installé: ${vbsPath}`);
  ok(`Démarre au logon sur http://localhost:${PORT}/sse — log: ${STDOUT}`);
  ok(`Test immédiat : cscript //nologo "${vbsPath}"`);
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
  <key>EnvironmentVariables</key><dict>
    <key>WIKICHAT_MEMORY_SNAPSHOT</key><string>${SNAPSHOT}</string>
    <key>WIKICHAT_MEMORY_TOKEN_FILE</key><string>${TOKEN_FILE}</string>
    <key>WIKICHAT_MEMORY_PORT</key><string>${PORT}</string>${WRITE ? `
    <key>WIKICHAT_MEMORY_ALLOW_WRITE</key><string>1</string>` : ""}
  </dict>
  <key>ProgramArguments</key><array><string>${NODE_BIN}</string><string>${SERVER_ENTRY}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${STDOUT}</string>
  <key>StandardErrorPath</key><string>${STDOUT}</string>
</dict></plist>`;
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.writeFileSync(plistPath, plist);
  try {
    execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" });
  } catch {
    /* premier install */
  }
  execSync(`launchctl load "${plistPath}"`, { stdio: "inherit" });
  ok(`LaunchAgent installé (port ${PORT}).`);
}

// --------------------------------------------------------------------------
// Linux — systemd --user
// --------------------------------------------------------------------------

function installLinux() {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  const unitPath = path.join(unitDir, "wikichat-memory.service");
  if (UNINSTALL) {
    try {
      execSync(`systemctl --user disable --now wikichat-memory.service`, { stdio: "ignore" });
    } catch {
      /* non activé */
    }
    fs.rmSync(unitPath, { force: true });
    return ok("Unit systemd supprimée.");
  }
  fs.mkdirSync(unitDir, { recursive: true });
  const unit = `[Unit]
Description=WikiChat Memory MCP server (read-only)
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
Environment="WIKICHAT_MEMORY_SNAPSHOT=${SNAPSHOT}"
Environment="WIKICHAT_MEMORY_TOKEN_FILE=${TOKEN_FILE}"
Environment="WIKICHAT_MEMORY_PORT=${PORT}"${WRITE ? `
Environment="WIKICHAT_MEMORY_ALLOW_WRITE=1"` : ""}
ExecStart=${NODE_BIN} ${SERVER_ENTRY}
Restart=on-failure
RestartSec=5
StandardOutput=append:${STDOUT}
StandardError=append:${STDOUT}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit);
  execSync(`systemctl --user daemon-reload`, { stdio: "inherit" });
  execSync(`systemctl --user enable --now wikichat-memory.service`, { stdio: "inherit" });
  ok(`Unit systemd installée (port ${PORT}).`);
}

// --------------------------------------------------------------------------

fs.mkdirSync(path.join(os.homedir(), ".wikichat"), { recursive: true });

if (!UNINSTALL) {
  console.log(`[memory-server] Installation serveur persistant`);
  console.log(`  node      : ${NODE_BIN}`);
  console.log(`  serveur   : ${SERVER_ENTRY}`);
  console.log(`  snapshot  : ${SNAPSHOT}`);
  console.log(`  token-file: ${TOKEN_FILE}`);
  console.log(`  port      : ${PORT}`);
  if (!fs.existsSync(TOKEN_FILE)) {
    console.log("");
    console.log(`  ATTENTION : le fichier-token n'existe pas encore.`);
    console.log(`  Crée-le avec ton token (le serveur refusera de démarrer sinon) :`);
    console.log(`    > "${TOKEN_FILE}"  contenant le token en clair, une ligne.`);
  }
  console.log("");
}

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
