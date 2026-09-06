#!/usr/bin/env node
/**
 * install-service.mjs — Install WikiChat as a user-level auto-start service.
 *
 * Detects OS and provisions the appropriate auto-start mechanism :
 *   - Windows : Task Scheduler `OnLogon`
 *   - macOS   : launchd LaunchAgent in ~/Library/LaunchAgents
 *   - Linux   : systemd --user unit in ~/.config/systemd/user
 *
 * The installed service starts WikiChat as the current user when they log in.
 * Symmetric uninstall available via `npm run uninstall-service`.
 *
 * Idempotent : re-running replaces the existing entry cleanly.
 */

import os from "os";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const NODE_BIN = process.execPath;
const SERVER_ENTRY = path.join(REPO_ROOT, "server.mjs");
const TASK_NAME = "WikiChat";
const SERVICE_LABEL = "com.wikichat";

// CLI flag : --with-team activates the autonomous team (Sentinel/Librarian/Orchestrator)
// at boot. Daemons stay dormant until a named session registers (dormant gate).
const WITH_TEAM = process.argv.includes("--with-team");

function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }
function ok(msg) { console.log(`✅ ${msg}`); }

function installWindows() {
  // Startup folder approach — per-user, no admin required, runs at every user logon.
  // We drop a .vbs file that launches node in hidden mode (no visible cmd window).
  // Output is redirected to ~/.wikichat/stdout.log for inspection.
  const startupDir = path.join(os.homedir(), "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  if (!fs.existsSync(startupDir)) {
    fail(`Startup folder not found: ${startupDir}`);
  }
  const vbsPath = path.join(startupDir, "WikiChat.vbs");
  const stdout = path.join(os.homedir(), ".wikichat", "stdout.log");
  const stderr = path.join(os.homedir(), ".wikichat", "stderr.log");
  // Build the inner cmd command. Escape backslashes and quotes for VBS string literal.
  // IMPORTANT: cd into the repo root first. A Startup-folder launch inherits
  // cwd=C:\Windows\System32, and the server creates its data dirs relative to
  // process.cwd() — without this cd it tried to mkdir under System32 and crashed
  // at boot with EPERM. macOS/Linux set WorkingDirectory; Windows needs this cd.
  const cd = `cd /d "${REPO_ROOT}"`;
  const innerCmd = WITH_TEAM
    ? `${cd} && set WIKICHAT_AUTONOMOUS_TEAM=1 && "${NODE_BIN}" "${SERVER_ENTRY}" > "${stdout}" 2> "${stderr}"`
    : `${cd} && "${NODE_BIN}" "${SERVER_ENTRY}" > "${stdout}" 2> "${stderr}"`;
  // VBS escapes : double-quote → "" inside string literal
  const vbsEscaped = innerCmd.replace(/"/g, '""');
  const vbs = `' WikiChat auto-start — runs node server.mjs at user logon, hidden window.
' Idempotent : delete this file to disable. Edit by re-running install-service.
Dim WshShell
Set WshShell = CreateObject("WScript.Shell")
' Run cmd /c <innerCmd>, WindowStyle=0 (hidden), WaitOnReturn=False (background)
WshShell.Run "cmd /c ${vbsEscaped}", 0, False
`;
  try {
    fs.writeFileSync(vbsPath, vbs, "utf8");
    ok(`Startup entry installed: ${vbsPath}`);
    console.log(`  WikiChat will auto-start at every user logon.`);
    console.log(`  Logs:    ${stdout} (and stderr.log)`);
    console.log(`  Disable: delete the .vbs file, or via Task Manager → Startup tab`);
    console.log(`  Test:    cscript //nologo "${vbsPath}"`);
  } catch (err) {
    fail(`Failed to write startup VBS: ${err.message}`);
  }
}

function installMacOS() {
  const plistDir = path.join(os.homedir(), "Library", "LaunchAgents");
  fs.mkdirSync(plistDir, { recursive: true });
  const plistPath = path.join(plistDir, `${SERVICE_LABEL}.plist`);
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SERVER_ENTRY}</string>
  </array>
  <key>WorkingDirectory</key><string>${REPO_ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>${WITH_TEAM ? `
  <key>EnvironmentVariables</key>
  <dict><key>WIKICHAT_AUTONOMOUS_TEAM</key><string>1</string></dict>` : ""}
  <key>StandardOutPath</key><string>${path.join(os.homedir(), ".wikichat", "stdout.log")}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), ".wikichat", "stderr.log")}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  try {
    // unload first (idempotent), then load
    try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }); } catch { /* not loaded yet */ }
    execSync(`launchctl load "${plistPath}"`, { stdio: "inherit" });
    ok(`LaunchAgent installed at ${plistPath}`);
    console.log(`  Status: launchctl list | grep ${SERVICE_LABEL}`);
  } catch (err) {
    fail(`launchctl failed: ${err.message}`);
  }
}

function installLinux() {
  const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  const unitPath = path.join(unitDir, "wikichat.service");
  const unit = `[Unit]
Description=WikiChat — local multi-agent coordination service
After=network.target

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}${WITH_TEAM ? `
Environment="WIKICHAT_AUTONOMOUS_TEAM=1"` : ""}
ExecStart=${NODE_BIN} ${SERVER_ENTRY}
Restart=on-failure
RestartSec=5
StandardOutput=append:${path.join(os.homedir(), ".wikichat", "stdout.log")}
StandardError=append:${path.join(os.homedir(), ".wikichat", "stderr.log")}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(unitPath, unit);
  try {
    execSync(`systemctl --user daemon-reload`, { stdio: "inherit" });
    execSync(`systemctl --user enable --now wikichat.service`, { stdio: "inherit" });
    ok(`systemd unit installed at ${unitPath}`);
    console.log(`  Status: systemctl --user status wikichat`);
    console.log(`  Logs:   journalctl --user -u wikichat -f`);
  } catch (err) {
    fail(`systemctl failed: ${err.message}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (!fs.existsSync(SERVER_ENTRY)) {
  fail(`server.mjs not found at ${SERVER_ENTRY}. Run from the repo root.`);
}

// Ensure log dir exists
fs.mkdirSync(path.join(os.homedir(), ".wikichat"), { recursive: true });

console.log(`📦 Installing WikiChat auto-start service`);
console.log(`   node:    ${NODE_BIN}`);
console.log(`   server:  ${SERVER_ENTRY}`);
console.log(`   platform: ${process.platform}`);
console.log(`   team:     ${WITH_TEAM ? "ENABLED (Sentinel/Librarian/Orchestrator daemons gated by dormant mode)" : "off (re-run with --with-team to enable)"}`);
console.log("");

switch (process.platform) {
  case "win32":  installWindows();  break;
  case "darwin": installMacOS();    break;
  case "linux":  installLinux();    break;
  default: fail(`Unsupported platform: ${process.platform}. See docs/setup/autostart.md for manual setup.`);
}

console.log("");
console.log(`🌐 Once started, the service listens on http://localhost:3777`);
console.log(`🛠️  Pilote:                          http://localhost:3777/pilote`);
console.log(`🛑 Uninstall:                       npm run uninstall-service`);
