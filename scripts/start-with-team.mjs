#!/usr/bin/env node
// Boot WikiChat with the autonomous team enabled (Sentinel/Librarian/Orchestrator
// daemons + cron triggers for cartography, clustering, nightly digest).
// Equivalent to : WIKICHAT_AUTONOMOUS_TEAM=1 node server.mjs
//
// Cross-platform : sets the env var via process.env (no shell wrapping).

process.env.WIKICHAT_AUTONOMOUS_TEAM = "1";

await import("../server.mjs");
