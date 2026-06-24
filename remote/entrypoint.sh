#!/bin/sh
# entrypoint.sh — clone le snapshot privé, lance le serveur MCP, pull périodique.
#
# Variables :
#   WIKICHAT_MEMORY_GIT_URL        URL clonable du repo privé (avec token si HTTPS)
#   WIKICHAT_MEMORY_SNAPSHOT       dossier cible du clone (défaut /app/snapshot)
#   WIKICHAT_MEMORY_PULL_INTERVAL  secondes entre deux git pull (défaut 300)
#   WIKICHAT_MEMORY_TOKEN          bearer requis par le serveur (auth des clients)
set -e

SNAP="${WIKICHAT_MEMORY_SNAPSHOT:-/app/snapshot}"
INTERVAL="${WIKICHAT_MEMORY_PULL_INTERVAL:-300}"

if [ -z "$WIKICHAT_MEMORY_GIT_URL" ]; then
  echo "[entrypoint] WIKICHAT_MEMORY_GIT_URL manquant — impossible de cloner le snapshot." >&2
  exit 1
fi

if [ ! -d "$SNAP/.git" ]; then
  echo "[entrypoint] Clone du snapshot privé -> $SNAP"
  git clone --depth 1 "$WIKICHAT_MEMORY_GIT_URL" "$SNAP"
fi

# Boucle de rafraîchissement en arrière-plan : pull léger à intervalle régulier.
# Le serveur recharge le snapshot disque de son côté (WIKICHAT_MEMORY_RELOAD_MS).
(
  while true; do
    sleep "$INTERVAL"
    git -C "$SNAP" pull --ff-only --quiet || echo "[entrypoint] git pull a échoué (réseau ?)" >&2
  done
) &

echo "[entrypoint] Démarrage du serveur MCP read-only."
exec node /app/remote/memory-mcp-server.mjs
