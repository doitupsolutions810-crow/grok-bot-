successfully downloaded text file (SHA: 84073fcf72602fa1febd09ad84436b8ceb251f28)
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

- `MODELS_REQUIRED` — models pulled on boot AND valid teammate models (CI uses `qwen2.5:3b,nomic-embed-text`)
- `GROK_MAX_PARALLEL` / `GROK_MIN_PARALLEL` / `GROK_WANT_PARALLEL` / `GROK_THERMAL_MAX_C` — Governor
- `GROK_SQUAD_N` / `GROK_SQUAD_STEPS` / `GROK_DEEP_ROUNDS` / `GROK_MAX_SPAWN_DEPTH` — Trinity
- `BOOT_STRICT=false` to boot degraded instead of failing

## Models: the free open-source route

Default model: **`qwen2.5:3b`** — chosen by a live, no-mock benchmark (`tools/model_bench.py`),
not by guesswork. The bench scores each model on exactly what the Avrone
orchestration needs, on a real Ollama server with the `shell` tool really executing:

| Stage | Points | What it proves |
| --- | --- | --- |
| JSON actions | 30 | a valid tool/final action every turn (Avrone worker protocol) |
| Tool use | 25 | really calls the tool instead of guessing (15) + correct computed value (10) |
| Squad | 35 | planner JSON (10) + both workers finish (10) + Lead merge non-weak (15) |
| Deep wave | 10 | recursive review: 2 reviewers + Deep Lead report with all sections |

Results (2 vCPU, no GPU — your host will be faster): **qwen2.5:3b scored 100/100**
(every turn valid, correct tool calls, full squad with merged answer). The bench
survives server drops mid-run (health-wait + retries), scores models in
isolation, and writes partial results incrementally.

Run it yourself (also runs in CI via the `model-bench` workflow, weekly or on
demand from the Actions tab):

```bash
python3 tools/model_bench.py --base http://127.0.0.1:11434 --protocol native
```

On a GPU host, upgrade in one env line (`LLM_MODEL=qwen3.5:9b`): the Qwen family
leads open-weight tool-calling benchmarks (BFCL v4 / TAU2-bench), so bigger Qwen
models only get better at orchestration.

## Full profile (the final product configuration)

The maximal profile — every subsystem on, one file:

```bash
cp .env.full .env
docker compose --profile full up -d --build
```

`.env.full` enables: vision (LLaVA `llava:7b`, auto-pulled on boot), the model
fallback chain (`MODEL_CHAIN`), deeper squads and recursive deep review waves,
Auto Review for sensitive actions, and X integration (fill your listener
bearer token). The `full` compose profile adds Whisper STT, Piper TTS, and
ComfyUI image generation sidecars. Boot self-tests (`BOOT_STRICT`) still gate
startup, and CI validates both the core and full compose configurations on
every push.

## Live tests

CI (GitHub Actions, real Docker runner) brings up the whole stack with
`qwen2.5:3b` and runs `tests/live.test.js` against real inference, docker exec,
and the browser — 8 live tests including a squad end-to-end run, CodeX replay,
governor snapshot, and ledger integrity.

```bash
docker compose exec grok-bot node tests/live.test.js
```

## Credit

The orchestration core is a port of [Avrone](https://github.com/doitupsolutions810-crow/Avrone)
(Python) into this Node.js runtime — trinity.py → `src/agents/trinity.js`,
governor.py → `src/agents/governor.js`, codex.py → `src/agents/codex.js`.

