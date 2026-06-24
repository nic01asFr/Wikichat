# Dockerfile générique — serveur MCP mémoire WikiChat (read-only, brique 3).
#
# Portable sur n'importe quelle plateforme (Fly / Render / VPS / Cloud Run).
# Au démarrage : clone le repo privé du snapshot, lance le serveur MCP, et
# rafraîchit le clone par git pull périodique (entrypoint).
#
# Build (depuis la racine du repo wikichat) :
#   docker build -f remote/Dockerfile -t wikichat-memory-mcp .
#
# Run :
#   docker run -p 3778:3778 \
#     -e WIKICHAT_MEMORY_TOKEN=<secret-fort> \
#     -e WIKICHAT_MEMORY_GIT_URL=https://<token>@github.com/nic01asFr/wikichat-memory.git \
#     wikichat-memory-mcp
#
# Le serveur ne contient AUCUN secret WikiChat : il ne sert qu'un snapshot déjà
# sanitisé. Mettre du TLS devant (l'hébergeur fournit HTTPS).

FROM node:22-alpine

RUN apk add --no-cache git

WORKDIR /app

# Dépendances : on n'a besoin que du SDK MCP, d'express et de zod (cf. server).
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Code du serveur read-only.
COPY remote/memory-mcp-server.mjs ./remote/memory-mcp-server.mjs
COPY remote/entrypoint.sh ./remote/entrypoint.sh
RUN chmod +x ./remote/entrypoint.sh

# Le snapshot est cloné au runtime dans ce dossier par l'entrypoint.
ENV WIKICHAT_MEMORY_SNAPSHOT=/app/snapshot
ENV WIKICHAT_MEMORY_PORT=3778
ENV WIKICHAT_MEMORY_PULL_INTERVAL=300

EXPOSE 3778

# Healthcheck : le serveur expose /health (read-only, sans auth).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://localhost:3778/health || exit 1

ENTRYPOINT ["./remote/entrypoint.sh"]
