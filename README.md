# Grok Bot ⚡

A self-hosted agent platform with full **Grok Bot parity**: Docker-connected on boot,
open-source LLMs (Ollama), MCP plugins, a personal terminal, a shared persistent
browser computer, and — new — the **Avrone agentic workflow**: plan → parallel
squad → lead merge, adversarial deep review waves, health-gated parallelism, and a
permanent replayable log of every run.

**No mocks.** On boot it pulls real images, real models, handshakes real MCP
servers, and runs live self-tests (`BOOT_STRICT`) before serving traffic.

## Quick start (any Docker host)

```bash
cp .env.example .env
docker compose up -d --build
# watch the live boot: images pulled, models pulled, MCP handshake, self-tests
docker compose logs -f grok-bot
```

Full profile adds Whisper STT, Piper TTS, and ComfyUI image generation:

```bash
docker compose --profile full up -d --build
```

Open `http://localhost:3000` — the web console (Chat · Team · Runs · Ledger · Approvals).

## What's inside

| Subsystem | What it really does |
| --- | --- |
| **Boot** | Connects to the Docker daemon (socket or socket-proxy), pulls images + models, runs live self-tests, fails hard in `BOOT_STRICT=true` mode |
| **LLM** | Ollama via OpenAI-compat API, multi-model routing with a fallback chain (`MODEL_CHAIN`) |
| **Tools** | `terminal` (docker exec in a hardened sandbox, per-agent homes), `browser` (shared CDP browser with persistent logins), `web.fetch`, `rag.search` (embeddings), `x.search`/`x.post`, `imagegen` (ComfyUI), `vision` (LLaVA), MCP servers from config |
| **Trinity (Avrone)** | `squad` mode: PLAN → parallel real agents → LEAD merge with weak-lead retry; `deep` mode: adversarial review waves until corrections converge, with confidence scoring |
| **Governor (Avrone)** | Sensors (CPU load, mem, disk, thermal) ramp parallelism down before the host melts; never below 1 lane, advisory, sensor errors ignored |
| **Eternal CodeX (Avrone)** | One JSONL per run: plan, spawns, tool calls, merges, throttles, errors. Corrupt lines skipped on replay; `GET /api/runs` + click-to-replay in the console |
| **Team** | Named teammates (Researcher 🔎, Inbox Manager 📬, Bug Fixer 🐛) with jobs, tools, modes; chief-of-staff dispatch; `team.ask` / depth-limited `team.spawn` |
| **Auto Review** | Dangerous terminal calls pause the agent thread → human approves in the console → thread resumes exactly once |
| **Ledger** | Every tool call hash-chained (tamper-evident); run feedback stored and injected into future context |
| **Skills** | Record a browser workflow once → replayable `skill.<name>` tool; SKILL.md playbooks via `skill.list`/`skill.load` |

## API (under `/api`)

- `POST /chat` and `POST /chat/stream` — modes: `chat` · `think` · `deepsearch` · `squad` · `deep` (SSE progress notes stream as `{note}` lines)
- `GET /runs`, `GET /runs/:id` — CodeX run replay · `GET /governor` — health snapshot
- `GET/POST /agents`, `PATCH/DELETE /agents/:id` — teammate CRUD (hot-reloaded)
- `GET /approvals`, `POST /approvals/:id/decision` — Auto Review
- `GET /ledger`, `POST /feedback` — trace ledger + run feedback
- `POST /x/trigger` — webhook variant of the @mention poller
- Plus: `/tools/:name/invoke`, `/rag/*`, `/vision`, `/voice/*`, `/tasks`, `/images/:file`, `/docker/containers`

## Configuration

Everything is env-driven (see `.env.example`). Key knobs:

- `MODELS_REQUIRED` — models pulled on boot AND valid teammate models (CI uses `llama3.2:1b,nomic-embed-text`)
- `GROK_MAX_PARALLEL` / `GROK_MIN_PARALLEL` / `GROK_WANT_PARALLEL` / `GROK_THERMAL_MAX_C` — Governor
- `GROK_SQUAD_N` / `GROK_SQUAD_STEPS` / `GROK_DEEP_ROUNDS` / `GROK_MAX_SPAWN_DEPTH` — Trinity
- `BOOT_STRICT=false` to boot degraded instead of failing

## Live tests

CI (GitHub Actions, real Docker runner) brings up the whole stack with
`llama3.2:1b` and runs `tests/live.test.js` against real inference, docker exec,
and the browser — 8 live tests including a squad end-to-end run, CodeX replay,
governor snapshot, and ledger integrity.

```bash
docker compose exec grok-bot node tests/live.test.js
```

## Credit

The orchestration core is a port of [Avrone](https://github.com/doitupsolutions810-crow/Avrone)
(Python) into this Node.js runtime — trinity.py → `src/agents/trinity.js`,
governor.py → `src/agents/governor.js`, codex.py → `src/agents/codex.js`.
