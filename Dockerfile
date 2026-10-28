FROM node:24-slim

# docker.io  → terminal tool shells out to `docker exec`
# python3/make/g++ → better-sqlite3 native build fallback
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates docker.io python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
# MCP servers pre-installed at BUILD time so the boot handshake never
# depends on the npm registry at runtime (npx resolves global installs
# offline). The Dockerfile is the right place for network-dependent work:
# a failed build is a visible, retryable error — not a dead boot.
RUN npm install -g @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-git
COPY . .

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fs http://localhost:3000/api/health || exit 1
CMD ["node", "src/server.js"]
