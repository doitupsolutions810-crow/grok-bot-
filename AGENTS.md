# Working in this repo

## Run it (Base44 sandbox / any dev host)

```bash
docker compose -f docker-compose.base44.yml up -d --build
```

- `grok-bot` → http://localhost:3000 (web console, main preview)
- `avrone` → http://localhost:8710 (AVRONE console + REST)
- infra: `ollama` (local models), `browser` (shared CDP Chromium), `socket-proxy` (Docker access)

Everything runs from the cloned source: the repo is bind-mounted at `/app`, npm
dependencies live in the `node_modules` volume and are installed on container
start, and the server runs under `node --watch`. AVRONE serves the mounted source
with `uvicorn --reload`. The repo's own `docker-compose.yml`/`Dockerfile` build a
production image — do not use them for the preview.

## Non-obvious things that will bite you

- **The app does not listen until the boot chain finishes.** `src/server.js` runs
  `bootDocker` → `preinstall` (pulls images/models, waits for Ollama + browser) →
  live self-tests → only then `app.listen`. Expect a few minutes even when warm;
  the first boot also downloads ~2 GB of models into the `ollama_models` volume.
  `BOOT_STRICT=true` (the default) exits the process if any self-test fails, so an
  unhealthy sidecar shows up as a crash-looping container, not a 500.
- **`/app/data` must exist before the app starts.** Modules such as
  `src/middleware/approvals.js` open `/app/data/*.db` at import time, so compose
  bind-mounts `./data:/app/data` (the directory is gitignored).
- **`MODELS_REQUIRED` tags must match `ollama list` exactly.** The boot gate waits
  for the literal name, and the embed model is tagged `:latest` — use
  `qwen2.5:3b,nomic-embed-text:latest`.
- **`browser-service/computer.js` needs two workarounds** (see the comments there):
  the Playwright image ships browsers but not the `playwright` npm package (the dev
  image installs it globally and sets `NODE_PATH`), and Playwright's Chromium keeps
  the CDP HTTP server on loopback and rejects requests whose `Host` is a name. The
  entry point forwards `:3000` to that loopback port and rewrites the Host header to
  the container IP, so `BROWSER_WS=http://browser:3000` still yields a dialable
  `ws://` URL.
- **Docker access is via `socket-proxy`.** The boot chain creates a `grok-sandbox`
  container on the host daemon and `terminal` runs `docker exec` in it, so the proxy
  needs `CONTAINERS`/`EXEC`/`POST` enabled and the app container needs the `docker`
  CLI (`docker.io` in the dev image).
- **`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`** is set for `grok-bot`: it only connects
  over CDP, so the ~500 MB local browser download is unnecessary.

## Verify

```bash
curl -s localhost:3000/api/status        # ready:true, 6/6 self-tests listed
curl -s localhost:8710/api/status        # AVRONE runtime snapshot
docker compose -f docker-compose.base44.yml exec grok-bot node tests/live.test.js
```

`tests/live.test.js` is the heavy end-to-end suite (real inference, squad runs,
docker exec) — the boot self-tests already cover the same subsystems at startup.
AVRONE's Python suite (`pytest`) is in `tests/` and needs `pip install -e ".[dev]"`.

## Configuration

Everything is env-driven; see `.env.example`. The stack needs **no external
credentials**: the LLM is local Ollama. `X_API_BEARER` and `XAI_API_KEY` are
optional and only enable the X listener and the xAI bridge respectively.
