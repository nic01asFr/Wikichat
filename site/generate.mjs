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

function blocFonctionnalites(v) {
  const l = v.fonctionnalites || [];
  if (!l.length) return "";
  return `<section class="features" id="fonctionnalites">
    <h2><span class="sec-label">Capacités</span> ${echapper(v.titreFonctionnalites || "Ce que tu peux faire")}</h2>
    <div class="feat-list">
${l.map((f) => `      <article>
        <h3>${echapper(f.titre)}</h3>
        <p>${echapper(f.texte)}</p>
        ${f.pourQui ? `<p class="pour-qui">${echapper(f.pourQui)}</p>` : ""}
      </article>`).join("\n")}
    </div>
  </section>`;
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
    <h2><span class="sec-label">Parcours</span> ${echapper(produit.titreSequence || "Le parcours")}</h2>
    <ol>
${l.map((s, i) => `      <li><span class="n">${i + 1}</span><div><b>${echapper(s.titre)}</b><p>${echapper(s.texte)}</p></div></li>`).join("\n")}
    </ol>
  </section>`;
}

function blocContextes(produit) {
  const l = produit.contextes || [];
  if (!l.length) return "";
  return `<section class="contextes" id="usages">
    <h2><span class="sec-label">Usages</span> ${echapper(produit.titreContextes || "Quand ça compte")}</h2>
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
  const accent = v.couleur || "#d97757";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${echapper(v.nom)} — collaboration projets &amp; agents</title>
  <meta name="description" content="${echapper(v.pitch)}" />
  <meta property="og:title" content="${echapper(v.nom)}" />
  <meta property="og:description" content="${echapper(v.pitch)}" />
  <meta property="og:type" content="website" />
  <link rel="canonical" href="https://nic01asfr.github.io${base}" />
  <base href="${echapper(base)}" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --accent: ${echapper(accent)};
      --ok: #4bb98a;
      --warn: #d9a441;
      --bg: #16120e;
      --panel: #1e1813;
      --panel2: #1b1611;
      --row: #191410;
      --ink: #ece7e1;
      --soft: #d7cfc4;
      --muted: #8a8175;
      --dim: #6f665b;
      --label: #7d7468;
      --line: #2b2319;
      --line2: #3a2f22;
      --deep: #120e0a;
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", system-ui, sans-serif;
      font-size: 15px;
      line-height: 1.55;
      color: var(--ink);
      background: var(--bg);
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { color: #eb9070; }
    ::selection { background: rgba(217, 119, 87, 0.35); }
    .wrap { width: min(920px, calc(100% - 2.5rem)); margin: 0 auto; }

    .topbar {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 10px 20px;
      background: var(--panel2);
      border-bottom: 1px solid var(--line);
    }
    .mark {
      width: 22px; height: 22px; border-radius: 5px;
      background: var(--accent); color: #1a120d;
      font-family: "IBM Plex Sans", sans-serif;
      font-weight: 700; font-size: 12px;
      display: inline-flex; align-items: center; justify-content: center;
    }
    .crumb {
      font-family: "IBM Plex Mono", monospace;
      font-size: 12px; color: var(--muted);
    }
    .crumb b { color: var(--soft); font-weight: 500; }
    .status {
      margin-left: auto;
      display: inline-flex; align-items: center; gap: 8px;
      font-size: 12.5px; color: var(--muted);
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); }

    header.hero { padding: clamp(2.8rem, 8vw, 4.5rem) 0 1.5rem; }
    .eyebrow {
      font-size: 10.5px; font-weight: 600; letter-spacing: 1.4px;
      color: var(--label); text-transform: uppercase; margin: 0 0 12px;
    }
    .brand {
      font-weight: 700;
      font-size: clamp(2.4rem, 7vw, 3.6rem);
      letter-spacing: -0.03em;
      line-height: 1.05;
      margin: 0 0 0.85rem;
    }
    .pitch {
      font-size: clamp(1rem, 2.2vw, 1.15rem);
      max-width: 40rem;
      color: var(--muted);
      margin: 0 0 1.35rem;
    }
    .tags { display: flex; flex-wrap: wrap; gap: 0.45rem; margin-bottom: 1.5rem; }
    .tag {
      font-family: "IBM Plex Mono", monospace;
      font-size: 10.5px; font-weight: 500;
      padding: 3px 8px; border-radius: 6px;
      background: var(--deep); color: #9a9084;
      border: 1px solid var(--line2);
    }
    .cta { display: flex; flex-wrap: wrap; gap: 0.65rem; }
    .btn {
      font-family: inherit; font-weight: 600; font-size: 13px;
      text-decoration: none; padding: 8px 14px; border-radius: 8px;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .btn.primary { background: var(--accent); color: #1a120d; border: none; }
    .btn.primary:hover { filter: brightness(1.06); color: #1a120d; }
    .btn.ghost {
      background: transparent; color: #d7cfc4;
      border: 1px solid var(--line2);
    }
    .btn.ghost:hover { border-color: var(--accent); color: var(--ink); }

    main section, main aside { margin: 2.4rem 0; }
    h2 {
      font-size: 15px; font-weight: 700; margin: 0 0 1rem;
      display: flex; align-items: center; gap: 10px;
    }
    h2 .sec-label {
      font-size: 10.5px; font-weight: 600; letter-spacing: 1.3px;
      color: var(--label); text-transform: uppercase;
    }
    h3 { font-size: 14px; font-weight: 600; margin: 0 0 0.4rem; }
    .accroche { font-size: 15.5px; max-width: 42rem; color: var(--soft); }

    .chiffres {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px; margin: 1.25rem 0 0;
    }
    .chiffres div {
      padding: 14px 15px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
      border-left: 3px solid var(--accent);
    }
    .chiffres strong {
      font-family: "IBM Plex Mono", monospace;
      font-size: 1.55rem; font-weight: 600;
      display: block; color: var(--ink);
    }
    .chiffres span { color: var(--muted); font-size: 12px; }

    .points { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    .points li {
      padding: 12px 13px;
      background: var(--row);
      border: 1px solid var(--line);
      border-radius: 10px;
      color: var(--soft);
    }
    .points b { display: block; margin-bottom: 0.2rem; color: var(--ink); font-weight: 600; font-size: 13.5px; }

    .feat-list { display: grid; gap: 10px; }
    .feat-list article {
      padding: 14px 15px;
      background: linear-gradient(180deg, #231c14, #1e1813);
      border: 1px solid var(--line2);
      border-radius: 13px;
      box-shadow: 0 0 0 1px rgba(217, 119, 87, 0.04);
    }
    .feat-list h3 { color: var(--accent); font-size: 14px; margin-bottom: 0.45rem; }
    .feat-list p { margin: 0; color: var(--soft); font-size: 13.5px; }
    .pour-qui {
      margin-top: 0.65rem !important;
      font-size: 12px !important;
      color: var(--dim) !important;
    }

    .sequence ol { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
    .sequence li {
      display: grid; grid-template-columns: 2rem 1fr; gap: 0.85rem; align-items: start;
      padding: 12px 13px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
    }
    .sequence .n {
      font-family: "IBM Plex Mono", monospace;
      font-weight: 600; color: var(--accent); font-size: 14px;
    }
    .sequence b { font-size: 13.5px; }
    .sequence p { margin: 0.25rem 0 0; color: var(--muted); font-size: 13px; }

    .ctx-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 10px;
    }
    .ctx-grid article {
      padding: 14px 15px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 12px;
    }
    .ctx-grid p { color: var(--soft); margin: 0; font-size: 13.5px; }
    .pourquoi { color: var(--dim) !important; font-size: 12px !important; margin-top: 0.6rem !important; }

    .encart {
      padding: 16px 18px;
      background: var(--panel);
      border: 1px solid var(--line2);
      border-radius: 13px;
      border-left: 3px solid var(--accent);
    }
    .encart h2 { margin-bottom: 0.5rem; }
    .encart p { color: var(--soft); margin: 0 0 0.85rem; }
    .encart a.btn.ghost { border-color: var(--line2); }

    .journal { border-left: 2px solid var(--line); padding-left: 1.1rem; }
    .journal div { margin-bottom: 1rem; }
    .journal b {
      font-family: "IBM Plex Mono", monospace;
      font-size: 11.5px; color: var(--accent); font-weight: 600;
    }
    .journal p { margin: 0.2rem 0 0; color: var(--muted); font-size: 13px; }

    footer {
      margin: 3rem 0 2rem;
      padding: 16px 0;
      border-top: 1px solid var(--line);
      color: var(--dim);
      font-size: 12.5px;
    }
    @media (prefers-reduced-motion: no-preference) {
      .hero .brand { animation: rise 0.55s ease both; }
      .hero .pitch { animation: rise 0.55s 0.06s ease both; }
      .hero .tags, .hero .cta { animation: rise 0.55s 0.12s ease both; }
      @keyframes rise {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: none; }
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <span class="mark" aria-hidden="true">W</span>
    <span class="crumb"><b>${echapper(v.nom)}</b> · collaboration projets &amp; agents</span>
    <span class="status"><span class="dot" aria-hidden="true"></span> Service local · sans clé API</span>
  </div>
  <header class="hero">
    <div class="wrap">
      <p class="eyebrow">Produit</p>
      <h1 class="brand">${echapper(v.nom)}</h1>
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
      <h2><span class="sec-label">Promesse</span> Ce que ça change</h2>
      ${blocPoints(v.points)}
    </section>
    ${blocFonctionnalites(v)}
    ${blocSequence(produit)}
    ${blocContextes(produit)}
    ${blocEncart(v.encart)}
    ${blocJournal(v.journal)}
  </main>
  <footer class="wrap">
    <p>${echapper(v.nom)} — MIT · <a href="${echapper(v.depot)}">${echapper(depotCourt)}</a></p>
    <p>Même langage visuel que le Pilote du service. Doc technique dans le dépôt.</p>
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
