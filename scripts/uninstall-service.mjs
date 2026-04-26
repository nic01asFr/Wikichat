#!/usr/bin/env node
/**
 * uninstall-service.mjs — Symmetric removal of the WikiChat auto-start service.
 * Mirror of install-service.mjs.
 */

import os from "os";
import path from "path";
import fs from "fs";
import { execSync } from "child_process";

const TASK_NAME = "WikiChat";
const SERVICE_LABEL = "com.wikichat";

function ok(msg) { console.log(`✅ ${msg}`); }
function warn(msg) { console.warn(`⚠️  ${msg}`); }

function uninstallWindows() {
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: "inherit", shell: "cmd.exe" });
    ok(`Task Scheduler "${TASK_NAME}" removed.`);
  } catch (err) {
    warn(`schtasks delete failed (task may not exist): ${err.message}`);
  }
}

function uninstallMacOS() {
  const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
  try { execSync(`launchctl unload "${plistPath}"`, { stdio: "ignore" }); } catch { /* not loaded */ }
  if (fs.existsSync(plistPath)) {
    fs.unlinkSync(plistPath);
    ok(`LaunchAgent removed from ${plistPath}`);
  } else {
    warn(`No plist at ${plistPath}`);
  }
}

function uninstallLinux() {
  try { execSync(`systemctl --user disable --now wikichat.service`, { stdio: "inherit" }); }
  catch (err) { warn(`disable failed: ${err.message}`); }
  const unitPath = path.join(os.homedir(), ".config", "systemd", "user", "wikichat.service");
  if (fs.existsSync(unitPath)) {
    fs.unlinkSync(unitPath);
    ok(`systemd unit removed from ${unitPath}`);
    try { execSync(`systemctl --user daemon-reload`); } catch { /* */ }
  } else {
    warn(`No unit at ${unitPath}`);
  }
}

console.log(`🗑️  Removing WikiChat auto-start service (platform: ${process.platform})`);
console.log("");

switch (process.platform) {
  case "win32":  uninstallWindows();  break;
  case "darwin": uninstallMacOS();    break;
  case "linux":  uninstallLinux();    break;
  default: warn(`Unsupported platform: ${process.platform}`);
}
