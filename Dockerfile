successfully downloaded text file (SHA: de3e4b321471d7670fb3bd26e513a75e2c574ae4)
FROM node:24-slim

# docker.io  → terminal tool shells out to `docker exec`
# python3/make/g++ → better-sqlite3 native build fallback
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates docker.io python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .

ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fs http://localhost:3000/api/health || exit 1
CMD ["node", "src/server.js"]
