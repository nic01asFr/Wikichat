#!/usr/bin/env node
/**
 * wikichat-mailbox-hook.mjs — ancien hook Stop « boîte mail », gardé pour les
 * réglages qui le citent encore.
 *
 * Il attendait jusqu'à 45 s en fin de tour, puis jusqu'à l'ETA annoncé, et
 * relançait l'agent pour tout message reçu — y compris dans un tour de
 * l'Atelier, sans rien signaler. Il délègue désormais au hook unifié
 * (`wikichat-hook.mjs stop`) : relance seulement pour une réponse attendue,
 * sans attente, avec un plafond et un signal visible.
 * L'installateur (src/overlay-installer.mjs) remplace cette entrée par les
 * hooks SessionStart / UserPromptSubmit / Stop / SessionEnd.
 */
process.argv[2] = "stop";
await import("./wikichat-hook.mjs");
