# Agent notes

## Base44 sandbox runbook

- Single Node/Express service: `src/server.js`. UI at `/`, health at `/api/health`,
  readiness at `/api/status` (`ready:true` only after the real boot self-test passes).
- Run with `docker compose -f docker-compose.base44.yml up -d --build` (host port 3000).
  Do not use the repo's `docker-compose.yml` for development: it builds a production
  image that bakes the source in, so edits would not appear.
- `docker-compose.base44.yml` builds `Dockerfile.base44` (system dependencies only,
  source bind-mounted, `npm install` into the `node_modules` volume at startup) and runs
  `node --watch src/server.js`. Four services: `grok-bot`, `ollama`, `browser`,
  `socket-proxy`.
- Boot is slow on a fresh workspace: Ollama pulls `qwen2.5:3b` (~1.9 GB) and
  `nomic-embed-text` into the `ollama_models` volume. Later boots reuse them. Boot also
  creates the `grok-sandbox` container through the Docker socket proxy.
- Boot chain in `src/server.js`: Docker daemon (`src/boot/docker.js`) → sidecar/model
  preinstall (`src/boot/preinstall.js`) → MCP handshake → live self-test
  (`src/boot/selftest.js`). `BOOT_STRICT=true` exits on any failure. ComfyUI is optional.
- The Docker socket proxy must allow `PING` and `INFO` (plus `CONTAINERS`, `EXEC`,
  `POST`, `PULL`, `IMAGES`, `ALLOW_RESTARTS`); without `INFO` the readiness probe gets a
  403 and the boot dies.
- The browser sidecar must build from `browser-service/Dockerfile`: the Playwright image
  ships browsers but not the `playwright` npm package. Chromium only listens on
  127.0.0.1, so `browser-service/cdp-proxy.js` exposes CDP on :3000 and rewrites the
  reported websocket host. `BROWSER_WS=http://browser:3000` — Playwright resolves the
  websocket itself; a bare `ws://browser:3000` cannot work.
- Ollama reports an untagged model as `name:latest`. Match model names through
  `src/boot/models.js` (`withTag` / `modelPresent`), never by exact string.

## Verify

- `docker compose -f docker-compose.base44.yml ps` — all services healthy (the app
  healthcheck has a 20-minute start period while models pull).
- `curl -s localhost:3000/api/status` must show `"ready":true` and `"degraded":false`.
- Live suite: `docker compose -f docker-compose.base44.yml exec -T grok-bot node tests/live.test.js`.
- Boot logs: `docker compose -f docker-compose.base44.yml logs -f grok-bot`.
