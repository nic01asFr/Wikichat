#!/usr/bin/env node
/**
 * Génère site/dist/index.html depuis site/vitrine.json.
 * Ne pas éditer le HTML à la main — régénérer.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const VITRINE = path.join(ROOT, "vitrine.json");
const DIST = path.join(ROOT, "dist");
const BASE = process.env.WIKICHAT_SITE_BASE || "/Wikichat/";

export function echapper(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function chargerVitrine(fichier = VITRINE) {
  const raw = fs.readFileSync(fichier, "utf8");
  const v = JSON.parse(raw);
  for (const k of ["nom", "pitch", "couleur", "depot", "points"]) {
    if (v[k] == null || (Array.isArray(v[k]) && v[k].length === 0)) {
      throw new Error(`vitrine.json: champ requis manquant ou vide: ${k}`);
    }
  }
  if (!v.produit?.sequence?.length) {
    throw new Error("vitrine.json: produit.sequence requis");
  }
  return v;
}

function blocPoints(points) {
  return `<ul class="points">
${points.map((p) => `    <li><b>${echapper(p.titre)}</b> ${echapper(p.texte)}</li>`).join("\n")}
  </ul>`;
}

function blocChiffres(chiffres) {
  if (!chiffres?.length) return "";
  return `<div class="chiffres">
${chiffres.map((c) => `    <div><strong>${echapper(c.valeur)}</strong><span>${echapper(c.libelle)}</span></div>`).join("\n")}
  </div>`;
}

function blocSequence(produit) {
  const l = produit.sequence || [];
  return `<section class="sequence" id="parcours">
    <h2>${echapper(produit.titreSequence || "Le parcours")}</h2>
    <ol>
${l.map((s, i) => `      <li><span class="n">${i + 1}</span><div><b>${echapper(s.titre)}</b><p>${echapper(s.texte)}</p></div></li>`).join("\n")}
    </ol>
  </section>`;
}

function blocContextes(produit) {
  const l = produit.contextes || [];
  if (!l.length) return "";
  return `<section class="contextes" id="usages">
    <h2>${echapper(produit.titreContextes || "Quand ça compte")}</h2>
    <div class="ctx-grid">
${l.map((c) => `      <article>
        <h3>${echapper(c.titre)}</h3>
        <p>${echapper(c.texte)}</p>
        ${c.pourquoi ? `<p class="pourquoi">${echapper(c.pourquoi)}</p>` : ""}
      </article>`).join("\n")}
    </div>
  </section>`;
}

function blocEncart(encart) {
  if (!encart) return "";
  const lien = encart.lien
    ? `<p class="cta-line"><a class="btn ghost" href="${echapper(encart.lien.url)}">${echapper(encart.lien.libelle)}</a></p>`
    : "";
  return `<aside class="encart">
    <h2>${echapper(encart.titre)}</h2>
    <p>${echapper(encart.texte)}</p>
    ${lien}
  </aside>`;
}

function blocJournal(journal) {
  if (!journal?.length) return "";
  return `<section class="journal" id="journal">
    <h2>Journal</h2>
${journal.map((j) => `    <div><b>${echapper(j.version)}</b><p>${echapper(j.texte)}</p></div>`).join("\n")}
  </section>`;
}

export function rendreHtml(v, base = BASE) {
  const tags = (v.tags || []).map((t) => `<span class="tag">${echapper(t)}</span>`).join("");
  const produit = v.produit || {};
  const install = "https://github.com/nic01asFr/Wikichat/blob/main/docs/setup/INSTALL.md";
  const depotCourt = v.depot.replace(/^https?:\/\//, "");

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${echapper(v.nom)} — mémoire et coordination pour Claude Code</title>
  <meta name="description" content="${echapper(v.pitch)}" />
  <meta property="og:title" content="${echapper(v.nom)}" />
  <meta property="og:description" content="${echapper(v.pitch)}" />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://nic01asfr.github.io${base}" />
  <base href="${echapper(base)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500&family=Syne:wght@600;700;800&display=swap" rel="stylesheet" />
  <style>
    :root {
      --accent: ${echapper(v.couleur)};
      --bg: #0b1210;
      --bg2: #121a17;
      --ink: #e7efe9;
      --muted: #8a9a92;
      --line: rgba(231, 239, 233, 0.12);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", system-ui, sans-serif;
      font-size: 1.05rem;
      line-height: 1.55;
      color: var(--ink);
      background:
        radial-gradient(1000px 520px at 12% -8%, color-mix(in srgb, var(--accent) 28%, transparent), transparent 60%),
        radial-gradient(700px 400px at 95% 10%, rgba(255,255,255,0.04), transparent 45%),
        linear-gradient(180deg, var(--bg), var(--bg2) 40%, var(--bg));
      min-height: 100vh;
    }
    a { color: var(--accent); }
    .wrap { width: min(920px, calc(100% - 2.5rem)); margin: 0 auto; }
    header.hero { padding: clamp(3.5rem, 12vw, 6.5rem) 0 2.5rem; }
    .brand {
      font-family: Syne, system-ui, sans-serif;
      font-weight: 800;
      font-size: clamp(2.8rem, 9vw, 4.6rem);
      letter-spacing: -0.04em;
      line-height: 0.95;
      margin: 0 0 1rem;
    }
    .pitch {
      font-size: clamp(1.05rem, 2.4vw, 1.25rem);
      max-width: 38rem;
      color: var(--muted);
      margin: 0 0 1.5rem;
    }
    .tags { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-bottom: 1.75rem; }
    .tag {
      font-family: Syne, sans-serif;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 0.28rem 0.55rem;
      border: 1px solid var(--line);
      color: var(--muted);
    }
    .cta { display: flex; flex-wrap: wrap; gap: 0.75rem; }
    .btn {
      font-family: Syne, sans-serif;
      font-weight: 700;
      text-decoration: none;
      padding: 0.7rem 1.15rem;
      border-radius: 2px;
      display: inline-block;
    }
    .btn.primary { background: var(--accent); color: #04110f; }
    .btn.ghost { border: 1px solid var(--line); color: var(--ink); }
    .btn.primary:hover { filter: brightness(1.08); }
    main section, main aside { margin: 3.2rem 0; }
    h2 {
      font-family: Syne, sans-serif;
      font-size: 1.45rem;
      letter-spacing: -0.02em;
      margin: 0 0 1.1rem;
    }
    h3 {
      font-family: Syne, sans-serif;
      font-size: 1.05rem;
      margin: 0 0 0.45rem;
    }
    .accroche { font-size: 1.15rem; max-width: 40rem; color: #c5d2cb; }
    .chiffres {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
      gap: 1rem;
      margin: 1.5rem 0 0;
    }
    .chiffres div {
      padding: 1rem 1.1rem;
      background: rgba(255,255,255,0.03);
      border-left: 3px solid var(--accent);
    }
    .chiffres strong {
      font-family: Syne, sans-serif;
      font-size: 1.8rem;
      display: block;
      letter-spacing: -0.03em;
    }
    .chiffres span { color: var(--muted); font-size: 0.9rem; }
    .points { list-style: none; padding: 0; margin: 0; display: grid; gap: 0.9rem; }
    .points li {
      padding: 0.9rem 0 0.9rem 1rem;
      border-left: 2px solid var(--accent);
      color: #c5d2cb;
    }
    .points b { font-family: Syne, sans-serif; display: block; margin-bottom: 0.2rem; color: var(--ink); }
    .sequence ol { list-style: none; padding: 0; margin: 0; display: grid; gap: 1rem; }
    .sequence li { display: grid; grid-template-columns: 2.2rem 1fr; gap: 0.85rem; align-items: start; }
    .sequence .n {
      font-family: Syne, sans-serif;
      font-weight: 800;
      color: var(--accent);
      font-size: 1.2rem;
    }
    .sequence p { margin: 0.25rem 0 0; color: var(--muted); }
    .ctx-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
    }
    .ctx-grid article {
      padding: 1.1rem 1.15rem;
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--line);
    }
    .ctx-grid p { color: #c5d2cb; margin: 0; }
    .pourquoi { color: var(--muted) !important; font-size: 0.92rem; margin-top: 0.6rem !important; }
    .encart {
      padding: 1.4rem 1.5rem;
      background: color-mix(in srgb, var(--accent) 16%, #0b1210);
      border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
    }
    .encart p { color: #c5d2cb; }
    .encart a.btn.ghost { border-color: var(--accent); color: var(--ink); }
    .journal { border-left: 2px solid var(--line); padding-left: 1.1rem; }
    .journal div { margin-bottom: 1rem; }
    .journal b { font-family: ui-monospace, Menlo, monospace; font-size: 0.85rem; color: var(--accent); }
    .journal p { margin: 0.2rem 0 0; color: var(--muted); font-size: 0.95rem; }
    footer {
      margin: 4rem 0 2.5rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 0.9rem;
    }
    @media (prefers-reduced-motion: no-preference) {
      .hero .brand { animation: rise 0.7s ease both; }
      .hero .pitch { animation: rise 0.7s 0.08s ease both; }
      .hero .tags, .hero .cta { animation: rise 0.7s 0.14s ease both; }
      @keyframes rise {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: none; }
      }
    }
  </style>
</head>
<body>
  <header class="hero">
    <div class="wrap">
      <p class="brand">${echapper(v.nom)}</p>
      <p class="pitch">${echapper(v.pitch)}</p>
      <div class="tags">${tags}</div>
      <div class="cta">
        <a class="btn primary" href="${echapper(v.depot)}">Code source</a>
        <a class="btn ghost" href="${echapper(install)}">Installer</a>
      </div>
    </div>
  </header>
  <main class="wrap">
    <section id="produit">
      <p class="accroche">${echapper(produit.accroche || "")}</p>
      ${blocChiffres(produit.chiffres)}
    </section>
    <section id="promesse">
      <h2>Ce que ça change</h2>
      ${blocPoints(v.points)}
    </section>
    ${blocSequence(produit)}
    ${blocContextes(produit)}
    ${blocEncart(v.encart)}
    ${blocJournal(v.journal)}
  </main>
  <footer class="wrap">
    <p>${echapper(v.nom)} — MIT · <a href="${echapper(v.depot)}">${echapper(depotCourt)}</a></p>
    <p>Service local pour Claude Code. Cette page présente le produit ; la documentation technique vit dans le dépôt.</p>
  </footer>
</body>
</html>
`;
}

export function generate({ vitrinePath = VITRINE, distDir = DIST, base = BASE } = {}) {
  const v = chargerVitrine(vitrinePath);
  fs.mkdirSync(distDir, { recursive: true });
  const html = rendreHtml(v, base);
  const out = path.join(distDir, "index.html");
  fs.writeFileSync(out, html, "utf8");
  return { out, bytes: Buffer.byteLength(html, "utf8") };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = generate();
  console.log(`[site] écrit ${r.out} (${r.bytes} octets)`);
}
