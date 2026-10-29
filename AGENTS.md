# Working in this repo (Base44 sandbox)

## Run the whole system

```bash
docker compose -f docker-compose.base44.yml up -d --build
docker compose -f docker-compose.base44.yml ps        # wait for grok-bot (healthy)
curl -s http://localhost:3000/api/status              # {"ready":true,...}
```

Services: `ollama` (local LLM), `models` (one-shot model pull, then exits),
`avrone` (Python half of the system, internal only), `grok-bot` (web console on
host port 3000, the preview entry point).

## Non-obvious things

- **Native mode, no Docker socket.** `.env.base44-defaults` sets
  `GROK_NATIVE=true`: the app boots against Ollama only, the `terminal` tool runs
  `sh -lc` inside the app container, and the `browser` tool drives a local
  Chromium from `/ms-playwright`. The Docker-sandbox path still exists but is
  not used inside the sandbox. The terminal is therefore *not* container-isolated.
- **`BOOT_STRICT=true` gates serving.** `src/server.js` runs six live self-tests
  (real inference, terminal, browser, MCP handshake, RAG embeddings; the Docker
  check is skipped in native mode) and exits the process if any fails. The
  container is unhealthy until that finishes. Read `docker compose logs grok-bot`
  when port 3000 does not answer.
- **Models are pulled by the `models` service, not at app boot.** Recreating
  `grok-bot` alone is fast (~30 s). Wiping the `ollama-models` volume means
  re-pulling ~2.2 GB.
- **CPU-only inference is slow.** `qwen2.5:3b` takes ~60–90 s per chat turn;
  `squad`/`deep` modes take minutes because they fan out several agents.
  Frontend/tab checks are quick; a chat answer is not.
- **AVRONE bridge.** `AVRONE_URL=http://avrone:8710` enables the `avrone.squad`
  tool. AVRONE runs on `AVRONE_RUNNER=local` (no Docker), shares the same Ollama,
  keeps its data in the `avrone-data` volume, and is deliberately not published
  on a host port.
- **Playwright is pinned twice.** `Dockerfile.base44` installs
  `playwright@1.64.1` browsers to match `package-lock.json`; bump both together or
  the browser tool fails at boot.
- **Data lives in named volumes** (`grok-data` → `/app/data`, `grok-output` →
  `/output`, `avrone-data`, `ollama-models`), so `docker compose down -v` deletes
  the SQLite DBs and the pulled models.
- **Live reload** is `node --watch src/server.js` over the bind-mounted repo:
  editing a file restarts the server and reruns the boot self-tests (~20 s).

## Tests

`tests/` is the Python AVRONE suite (`pytest`, inside the `avrone` container:
`docker compose -f docker-compose.base44.yml exec avrone python -m pytest -q`).
`tests/live.test.js` requires the real Docker path and is not runnable in native
mode.
