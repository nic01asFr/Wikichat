import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { chargerVitrine, generate, echapper } from "./generate.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

test("echapper escape HTML", () => {
  assert.equal(echapper(`a<b>&"c`), "a&lt;b&gt;&amp;&quot;c");
});

test("chargerVitrine refuse un JSON incomplet", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wc-site-"));
  const f = path.join(dir, "bad.json");
  fs.writeFileSync(f, JSON.stringify({ nom: "X" }));
  assert.throws(() => chargerVitrine(f), /champ requis/);
});

test("generate produit un index.html avec pitch et parcours", () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "wc-dist-"));
  const { out, bytes } = generate({
    vitrinePath: path.join(ROOT, "vitrine.json"),
    distDir: dist,
    base: "/Wikichat/",
  });
  assert.ok(bytes > 1000);
  const html = fs.readFileSync(out, "utf8");
  assert.match(html, /WikiChat/);
  assert.match(html, /base href="\/Wikichat\/"/);
  assert.match(html, /id="parcours"/);
  assert.match(html, /id="fonctionnalites"/);
  assert.match(html, /Mémoire transverse/);
  assert.doesNotMatch(html, /Widgets Grist/i);
  assert.doesNotMatch(html, /manifest\.json/);
});
