/**
 * game.mjs — WikiChat RPG route handler
 * HTML is in public/game.html (avoids backtick escaping issues)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GAME_HTML_PATH = path.join(__dirname, "../public/game.html");

export function handleGamePage(req, res) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  try {
    res.end(fs.readFileSync(GAME_HTML_PATH, "utf8"));
  } catch {
    res.status(500).end("game.html not found");
  }
}
