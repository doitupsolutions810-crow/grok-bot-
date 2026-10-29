# Working in this repo (Base44 sandbox)

## Run it

```bash
docker compose -f docker-compose.base44.yml up -d --build
docker compose -f docker-compose.base44.yml logs -f grok-bot
```

Console: host port **3000**. Liveness: `GET /api/health`. Readiness: `GET /api/status`.

The app runs from the bind-mounted checkout under `node --watch` (edits to `src/`
restart the server; `public/index.html` is served statically). Sidecars: `ollama`
(local LLM), `browser` (the shared computer), `socket-proxy` (Docker API used by
the `terminal` tool and for creating the `grok-sandbox` container).

## Boot order and timing

`src/server.js` binds :3000 only after: Docker reachable through the socket proxy →
required images/models present (qwen2.5:3b ≈1.9 GB + nomic-embed-text ≈274 MB cached
in the `ollama_models` volume) → browser probe → MCP stdio handshake → 6 live
self-tests. First boot ≈5–8 min; later boots ≈3 min, because the optional ComfyUI
probe always waits out its 120 s timeout (that sidecar is not part of this stack).

`BOOT_STRICT=true` (the app default) exits on any failed self-test. Under
`node --watch` a fatal error leaves the container "up" but dead — recreate it, then
recreate `browser` (see below).

Inference is CPU-only here: one short chat answer takes ~90 s. That is normal, not a
hang — watch `docker compose logs -f ollama`.

## Sandbox-specific wiring (differs from the repo's own docker-compose.yml)

- `MODELS_REQUIRED` must use explicit tags (`nomic-embed-text:latest`): the boot
  check compares `/api/tags` names exactly, so an untagged model never matches and
  boot hangs until it exits.
- The shared browser is CDP-only on loopback, so the wiring is not the repo default:
  - the official Playwright image ships browsers but **not** the `playwright` npm
    module, so `Dockerfile.browser` installs the matching client (1.64.1);
  - Chrome ignores `--remote-debugging-address` (binds 127.0.0.1) and Playwright
    1.64.1 rejects `launchPersistentContext({ port })`, so
    `browser-service/computer.js` launches Chromium directly and the service shares
    the app's network namespace (`network_mode: service:grok-bot`), CDP on :9222;
  - the app therefore uses `BROWSER_WS=http://127.0.0.1:9222`, not `ws://browser:3000`;
  - **recreating or restarting `grok-bot` gives it a new network namespace and
    orphans the browser** — always follow with
    `docker compose -f docker-compose.base44.yml up -d --force-recreate browser`;
  - the persistent profile volume keeps Chromium's `SingletonLock` between
    containers; the service command clears it before launching.
- The app creates the `grok-sandbox` container itself through the Docker API, so the
  app image needs the Docker CLI and `socket-proxy` must allow CONTAINERS/EXEC/POST/PULL.
- No external credentials are required. `X_API_BEARER` (X mention poller) and
  `XAI_API_KEY` (hosted-Grok bridge) are optional and arrive through Base44 secrets
  into `/run/base44/app.env` — never bake them into compose.
- `BASE44_PREVIEW_MODE` is passed through to the app service; no app code gates on it
  and no host/origin allowlists are needed (single origin, express static + `/api`).

## Verify

```bash
curl -s localhost:3000/api/status | head -c 400        # "ready":true, 28 tools
curl -s -X POST localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"Reply with exactly: ok","mode":"chat"}'   # ~90 s on CPU
```

Full project suite (slow — squad mode spawns parallel workers and does real
inference): `docker compose -f docker-compose.base44.yml exec -T grok-bot node tests/live.test.js`

## Known pre-existing issues (not setup problems)

- `public/index.html` is not responsive: at mobile widths the console overflows
  horizontally by ~110 px and the chat panel collapses.
- `verify.sh` / `launch.sh` assume the repo's own compose file and a host with
  GitHub-grade resources; they are not the sandbox path.
