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

> **First boot:** the API comes up only after the full boot chain finishes —
> including pulling the required models (~2 GB for `qwen2.5:3b` +
> `nomic-embed-text`). On a fresh host that can take 10–25 minutes; the log
> above shows live pull progress, and subsequent boots reuse the pulled models
> and come up in seconds.

Full profile adds Whisper STT, Piper TTS, and ComfyUI image generation:

```bash
docker compose --profile full up -d --build
```

Open `http://localhost:3000` — the web console (Chat · Team · Runs · Ledger · Approvals).

To verify the stack without GitHub Actions, run `./verify.sh`. It waits up to 60 minutes by default for a true ready state, detects early crashes/restart loops, runs the real live suite, and writes the verdict to `data/VERIFY.md`. Use `VERIFY_BOOT_TIMEOUT_SECONDS=7200 ./verify.sh` on slower hosts. A skipped AVRONE check is reported as **partial**, not system-green.

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

## The system bridge (AVRONE ↔ Grok Bot)

For the supported combined deployment, run the two repositories on one private Docker Compose network. This avoids the common failure where AVRONE binds to host loopback but a container tries to reach it through `host.docker.internal`.

- **Grok Bot → AVRONE:** the `avrone.squad` tool delegates a complete task to AVRONE's squad (plan → parallel workers → lead merge; `mode: "deep"` adds adversarial review waves). The integration overlay sets `AVRONE_URL=http://avrone:8710` and the live suite invokes this actual tool.
- **Network boundary:** AVRONE is published to the host only at `127.0.0.1:8710`; Grok Bot reaches it by Compose service DNS. The AVRONE container uses its unprivileged image, the local runner, and `AVRONE_ALLOW_NETWORK=false`; the overlay does not mount the Docker socket into AVRONE.
- **AVRONE → Grok Bot:** AVRONE's `http_request` tool can call Grok Bot's API, but the console is bound to `127.0.0.1:3000` on the host by default. A reverse direction from the AVRONE container is not implicitly enabled by that host-only binding; configure an authenticated, private-network route before relying on it.
- **MCP:** `avrone-mcp` exposes AVRONE to MCP clients (`avrone_squad`, `avrone_chat`, `avrone_deep`, `avrone_tools`); Grok Bot handshakes configured MCP servers at boot.

### Run the combined stack

Keep both repositories as siblings:

```text
workspace/
  grok-bot-/
  Avrone/
```

From the Grok Bot repository root:

```bash
./launch.sh
```

When `../Avrone` exists, the launcher runs AVRONE's offline test suite and uses `docker-compose.integration.yml` to start both services. To fail closed instead of allowing core-only mode when AVRONE is missing, run `LAUNCH_REQUIRE_AVRONE=true ./launch.sh`. Run `./verify.sh` for the bounded boot gate and live suite; with the sibling repository present it requires the bridge test too.

## The agents' evolution loop

The agents evolve through their own runs — the same sequential process that built the system:

1. **Observe** — every run lands in the Eternal CodeX JSONL; user feedback (`POST /api/feedback`) is injected into future context.
2. **Conclude** — `scripts/evolve.js` scans the run logs (corrupt lines skipped), counts tool use and errors, lists recorded skills, and writes `data/EVOLVE.md` with proposed next evolutions: `docker compose exec grok-bot node scripts/evolve.js` (CI runs it right after the live tests).
3. **Evolve** — recorded skills become replayable tools; AVRONE's test-gated self-evolution (`AVRONE_SELF_EVOLVE=allow` in its `deploy/full.env`) proposes code edits that land only if the full test suite passes.
4. **Re-benchmark** — `tools/model_bench.py` re-validates the model default after any model or stack change, so the system never silently degrades.

## Launch locally (the sequential process)

`./launch.sh` runs preflight → AVRONE offline test gate (when the sibling checkout exists) → integrated Compose stack → strict boot gate → live tests → evolution report. In integrated mode AVRONE is available to the host at `127.0.0.1:8710` and to Grok Bot as `http://avrone:8710`; the Grok Bot console is available at `http://localhost:3000`.

### Verify without CI

GitHub Actions is not required to prove the boot. The repository's billing/runner
availability does not sit in the local execution path: `./verify.sh` checks Docker
and Compose, validates both Compose profiles, builds and starts the full profile,
waits for `/api/status` to report `ready:true`, runs all live agent tests, then
writes the evolution report and final verdict to `data/VERIFY.md`.

The verifier's default boot budget is 60 minutes because `.env.full` can enable
LLaVA in addition to the chat and embedding models. It fails early if Docker is
unavailable, the Compose configuration/build fails, the container exits, a restart
loop appears, or the API reports degraded self-tests. It prints container state
and logs on boot failure. Override the wait budget with
`VERIFY_BOOT_TIMEOUT_SECONDS=7200 ./verify.sh` on slow hosts.

- `SYSTEM GREEN`: boot self-tests and live tests passed, EVOLVE.md was written, and the adjacent AVRONE offline suite passed.
- `GROK BOT CORE VERIFIED / INTEGRATION PARTIAL`: all required Grok Bot checks passed, but the AVRONE repo or Python was absent.
- To make AVRONE mandatory, run `VERIFY_REQUIRE_AVRONE=true AVRONE_DIR=../Avrone ./verify.sh`.
- `./launch.sh` starts AVRONE first when present and health-checks its API; it reuses the same bounded boot gate for Grok Bot. If AVRONE cannot be reached, it does not falsely claim the bridge is live. Set `LAUNCH_REQUIRE_AVRONE=true` to stop the launch when the combined bridge cannot be verified.

Boot is race-hardened: images already on the host are not re-pulled, required
models must become visible in Ollama before self-tests, and the verifier's
longer wait is sized for several sequential model pulls. The scripts do not
pretend to run Docker when the current machine lacks a Docker daemon: on such a
machine they fail at preflight with a diagnostic.

## Credit

The orchestration core is a port of [Avrone](https://github.com/doitupsolutions810-crow/Avrone)
(Python) into this Node.js runtime — trinity.py → `src/agents/trinity.js`,
governor.py → `src/agents/governor.js`, codex.py → `src/agents/codex.js`.
