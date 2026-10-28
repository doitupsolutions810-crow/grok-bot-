# AVRONE

A self-hosted chat + search system where agents don't just answer, they **work**:
they get a real terminal, a workspace, network access and Docker, they spawn
sub-agents, and every action they take is logged and shown live on a HUD.

Orchestration follows the **Grok Heavy** pattern: a squad of agents attacks the
same request in parallel from different angles, then a **Lead** agent compares
their work like a study group, resolves disagreements, and writes one answer.

The model brain is your **OpenClaw** Gateway by default (any OpenAI-compatible
backend works too: xAI Grok, OpenAI, Ollama, LM Studio, vLLM).

## Architecture (from the sketch)

```
 Ghost Shell   (server.py, static/)   Web UI, REST API, WebSocket HUD, admin terminal
      │
 Trinity Core  (trinity.py)           Daemon kernel: PLAN → SQUAD (parallel) → LEAD merge,
      │                               tool loop, sub-agent spawning
      ├── Eternal CodeX (codex.py)    Event bus + permanent JSONL action log per run (replayable)
      │
 Sovereign OS  (sovereign.py)         Environment established FIRST on launch: Docker container
                                      ("VM environment") or local sandbox, health-checked
      │
 Model backend (llm.py)               OpenClaw Gateway /v1/chat/completions (or any OpenAI-compatible)
```

| Sketch item | Where it lives |
|---|---|
| AVRONE chatbot/search, website/phone/app | Web UI (mobile-friendly) + REST API any app can call |
| Chat orchestrate / Agent orchestrate | `chat` mode (one agent) / `squad` mode (Grok Heavy) |
| Agent action logs | Eternal CodeX: `/api/runs`, `/api/runs/{id}`, live Logs tab |
| Admin-level / terminal access | `/api/terminal` + Terminal tab, gated by `AVRONE_ADMIN_TOKEN` |
| Backend environment hosting so agents can install resources | Sovereign OS runner, `shell` tool |
| Long-term artifacts, Docker, network, real terminal | `background: true` runs, Docker runner, `fetch`, `shell` |
| HUD display for hosted environments | HUD tab: live agent tree, current tool, status |
| Agents spawn sub-agents | `spawn` tool (depth-limited by `AVRONE_MAX_SPAWN_DEPTH`) |

## v0.2: Deep Analysis, MCP, plugins, 17 tools

**Deep Analysis (second wave).** Give AVRONE a question plus an answer that
already exists (from you, another AI, or its own squad) and a second squad
stress-tests it: Fact-Checker, Gap-Finder, Contrarian, Deep-Diver, Forecaster,
Source-Synthesizer. The Deep Lead returns: Verdict (confirmed / corrected /
extended + confidence), Corrections, Additions, Counterpoints, Sources, Bottom line.

```bash
avrone-cli deep "Is X true?" --first-answer-file answer.txt -n 4
avrone-cli deep "Plan a home lab"            # runs wave 1 squad, then wave 2
```

**Tools.** shell, python, read_file, write_file, edit_file, list_files,
search_files, fetch, http_request, web_search (DuckDuckGo free; Brave/Tavily
if keyed), git (no force push), docker_run, memory_save, memory_recall,
artifact_save, think, spawn. Plus plugin and MCP tools.

**MCP, both ways.** AVRONE loads any MCP server from `mcp.json` (Claude Desktop
format, stdio or Streamable HTTP; see `examples/mcp.json.example`); its tools
appear as `mcp__<server>__<tool>`. And `avrone-mcp` serves AVRONE itself over
stdio with `avrone_squad`, `avrone_chat`, `avrone_deep`, `avrone_tools`, so
OpenClaw, Claude Desktop or Cursor can call the squad.

**Plugins.** Drop a `.py` with `def register(registry, settings)` in `plugins/`
(examples: calculator, current_time) or publish an `avrone.plugins` entry point.

**Providers.** `AVRONE_PROVIDER=openclaw|xai|openai|openrouter|ollama|custom`,
with `AVRONE_LEAD_MODEL` for a stronger merge model. Retries with backoff.

**CLI.** `avrone-cli squad|chat|deep|tools|runs [--json out.json] [--quiet]`.

## v0.3: Telemetry + System Map

AVRONE traces its own nodes: Trinity Core, Eternal CodeX, the Sovereign OS
runner, worker and lead models, every tool (built-in, plugin, MCP) and every
agent role, with the traffic between them built from the action logs. It never
probes outside networks.

- `GET /api/telemetry?hours=24`: runs (total, live, by mode, p50/p95 duration), agents by role, per-tool calls, errors and average latency
- `GET /api/map?format=json|mermaid`: node/edge graph, or a Mermaid flowchart you can paste into GitHub
- **Map** tab in the UI: live graph + headline metrics
- `avrone-cli telemetry` and `avrone-cli map [--format mermaid|json]`

## v0.18: Squad round 5 — full-context sub-agents, recursive learning bridge, network-dispatched squads, edge-case hardening — 1680 tests

Four lanes in parallel, Lead merge + fixes: the bridge now relays across nodes per run (`net-<sender>-<origin_run>`; inbound posts readable by the remote squad, only locally written posts return), and fleet audits that carried `kind=`/`run_id=` were silently dropped by Codex.emit (now `req_*`). Note: `AVRONE_BRIDGE_ROUNDS` defaults to 1 (one extra model call per worker) and lessons are on; set `AVRONE_BRIDGE_ROUNDS=0` / `AVRONE_LESSONS=off` for v0.17 behaviour. Known: agent packs carry memory under the dir id, which differs from the name-derived namespace for roles with spaces or punctuation.

- **edgecases** — agent spawning / per-agent env / fleet edge cases (tests/test_edgecases_v018.py, 27 tests): concurrent live agents of one run whose roles sanitize alike ("Builder!" / "Builder?", or "Fact-Checker" / "FactChecker" for memory) now get distinct homes and memory namespaces (`-2`, `-3` suffix; the first keeps the plain id, so persistence across runs and sequential re-spawns is unchanged); `core.active` records each agent's `agent_id`, so thermal migration never moves the home of a working agent whose `agent_id` differs from its role; messages that land during an agent's last turn are audited as `agent.message_dropped` instead of vanishing; a deep checkpoint resumed after `squad_size` changed no longer mixes cached reviews of the old first-wave answer with the new one; memstore appends after a torn (crash mid-append) last line no longer lose the new record; `remote_broadcast` normalizes routes before de-duplicating (`good/`, `/good`, ` good `) and drops empty targets instead of turning them into an `auto` pick. Pinned as safe: batched spawns with `max_parallel=1` at depth 2 (no deadlock), squad cancellation (no ghosts, inbox cleared, no failed step checkpointed), quota races, self/A→B→A routes and hops at the limit, multi-process memstore writers, empty/zero-memory/at-quota agent packs, unicode/huge checkpoint tasks.
- **ctxspawn** — `spawn` now hands the child a ContextPack: `context` = `full` (default: the run's original task, a lineage chain root -> ... -> parent, the parent's role/focus, squad sibling roles/focuses, the parent's last 8 tool calls/results, a read-only snapshot of its memory namespace and the file names in its agent dir) | `summary` (task + lineage + a compact digest) | `none` (old behaviour); optional `focus` and `share_dir` (child may read, never write, the parent's agent dir under a confined `parent/` prefix in read_file/list_files/search_files/diff_files). Packs are capped by `AVRONE_SPAWN_CONTEXT_CHARS` (default 12000, max 64000; deterministic truncation keeps task + lineage first) and secret-redacted (tokens, keys, Authorization headers, `*_TOKEN/*_KEY/*_SECRET` values). Children get their own dir `<parent id>-<role>`; lineage lives on AgentContext and in the `agent.spawn` CodeX event (`context_mode`, `context_chars`, `lineage`, `share_dir`); `AVRONE_MAX_AGENTS_PER_RUN` (default 64) caps agents per run alongside the unchanged depth limit.
- **netsquad** — squad mode dispatched into the node network: `AVRONE_SQUAD_DISPATCH=local|network|hybrid` (default local = unchanged) places each squad subtask on a healthy fleet node (round-robin by health score), where it runs as a sub-squad of `AVRONE_NET_SUBSQUAD` agents (default 2, max 4; `AVRONE_NET_WORKER_MODE=chat` for one) and may place further down the tree hop by hop (cycle refusal, `AVRONE_FLEET_MAX_HOPS`); capped by `AVRONE_NET_MAX_NODES` (8) and `AVRONE_NET_MAX_REMOTE_AGENTS` (32); remote failure runs the subtask locally; privileged runs never leave the node; receivers need capability `squad:net`; optional bridge-post relay; per-request `"dispatch"` on `/api/chat` and `avrone-cli squad --dispatch network`; doctor warns on network/hybrid with an open allowlist.
- **bridge** — a recursive learning bridge so agents among agents conclude with each other's information: a run-scoped blackboard (`avrone/bridge.py`; posts `finding|question|answer|correction|conclusion` with refs, bounded by `AVRONE_BRIDGE_MAX_POSTS` (500) and 4000 chars/post, persisted to `data_dir/bridge/<run_id>.jsonl` with corrupt-line-tolerant replay) shared by every squad worker, sub-agent at any depth and deep reviewer via `bridge_post` / `bridge_read` / `bridge_reply` (codex `bridge.post`); a squad cross-examination round before the Lead merge (`AVRONE_BRIDGE_ROUNDS`, default 1, max 3, 0 = classic squad; stops early when a round adds no correction) whose digest of joint conclusions and unresolved disagreements goes to the Lead; run-end distillation of up to 5 conclusions into a `lessons` memory namespace (hash-deduped, `AVRONE_LESSONS_MAX` 200, oldest evicted) that is keyword-matched back into new runs' worker prompts (`AVRONE_LESSONS=off` disables); `Bridge.export(since)` / `merge_remote(posts, origin_node)` hooks for fleet relay; `GET /api/runs/{id}/bridge`.

## v0.17: Squad round 4 + edgepack — unified agent fs, batched + schema-checked tool calls, health-routed edge offload, API/fleet checkpoints, container-hosted agent homes with thermal migration — 1586 tests

Five lanes in parallel (git worktrees, two green commits each), Lead merge + fixes (collision-free fleet checkpoint keys; one shared node-health block for routing and migration). Everything new is off by default except fsunify and toolcall.

- **fsunify** — the generic file tools (`read_file`, `write_file`, `edit_file`, `list_files`, `search_files`, `diff_files`) now work inside the agent's own persistent dir (`workspace/agents/<id>/`, confined and symlink-proof), with the per-file cap and dir quota applied to `write_file`/`edit_file`; a `shared/` prefix reaches the old shared workspace (its `agents/` subtree is off limits), and `python` runs with cwd = the agent dir on the local and Docker runners. `AVRONE_AGENT_FS=0` (or no agent dir) keeps the exact old behaviour.
- **toolcall** — agents can send a batch `{"tools": [...]}` of independent calls per turn (run concurrently, results fed back in order; cap `AVRONE_MAX_CALLS_PER_TURN`, default 4, max 8; one crashing call never sinks the others); core tools declare arg schemas that are checked before the call, so a bad call returns an `ARG ERROR` the model repairs instead of running (unknown tools suggest close names; checks step aside after 3 consecutive errors); new CodeX events `tool.batch` and `tool.arg_error`.
- **edgeroute** — governor-aware fleet routing: heartbeats/registration carry a compact governor health block (load ratio, mem %, disk free, CPU temp, headroom, ok/throttled/hot, active agents), stale with node status; `FleetManager.select_nodes(k, need)` ranks online, allowlisted children cool/idle first and skips hot/throttled ones (`remote_spawn node=auto` uses it); opt-in `AVRONE_FLEET_OFFLOAD=off|spill|spread` (default off) sends a governor-capped squad's overflow workers to healthy edge nodes over the signed dispatch path (mode chat, `AVRONE_FLEET_OFFLOAD_TIMEOUT` 300 s) and runs any failed one locally; privileged runs never offload; audited as `fleet.offload` / `fleet.offload_fallback`; node health in `fleet_nodes`, telemetry and the map; doctor warns on offload with an open `AVRONE_FLEET_ALLOW`.
- **ckpt** — server-managed checkpoint/resume over the API, MCP, CLI and fleet: `POST /api/chat` takes `checkpoint_id` (squad/deep, `[A-Za-z0-9_-]{1,64}`, stored only under `data_dir/checkpoints/<id>.json`); re-posting the same id + task resumes (also a background run that died), a different task is 409; admin `GET /api/checkpoints`, `GET`/`DELETE /api/checkpoints/{id}`; `avrone_squad`/`avrone_deep` and `avrone-cli --checkpoint-id` take the same id; remote squad/deep jobs carry it in the signed body and the running node keys it `fleet-<sender>-<id>` (owner-stamped), so a retried job resumes and senders never collide.
- **edgepack** — portable, container-hosted agent homes for edge nodes. `AVRONE_AGENT_CONTAINER=persistent` (default `off`) gives each agent one long-lived, lazily created Docker container `avrone-agent-<node>-<id>` with only its dir mounted at `/agent` (`--cap-drop ALL`, `no-new-privileges`, pids cap, `AVRONE_AGENT_MEM_MB` 512, `AVRONE_AGENT_CPUS` 1.0, `--network none` unless `AVRONE_ALLOW_NETWORK`; the isolate path now shares these flags), reaped after `AVRONE_AGENT_IDLE_SECS` (600) idle. `avrone/agentpack.py` exports an agent's dir + memory namespace as a deterministic tar.gz with a sha256 manifest (no symlinks/devices, quota-bound); import verifies every hash, confines paths and only replaces the same agent's home (same id and birth node) with a newer copy. `AVRONE_AGENT_MIGRATE=on` (default off) adds signed `POST /api/fleet/agentpack` (capability `agent:migrate`, sender must be in a non-empty `AVRONE_FLEET_ALLOW`, never privileged), `FleetManager.migrate_agent` to the coolest / least-loaded peer, and a governor hook that moves idle agents off a node hotter than `AVRONE_THERMAL_MAX_C` (audited `agent.migrate` / `agent.migrate_refused` / `agent.migrate_failed`; a failed agent stays put). Tools `agent_pack_export`, `agent_pack_import`, `agent_migrate`; doctor warns on migrate + open allowlist.

## v0.16: Squad round 3 — privileged execution, per-agent filesystem + memory, edge resilience — 1372 tests, coverage 95%

- **priv_shell / priv_admin** — the v0.15 privileged tier now does something, and only when granted. Requires BOTH `core.fleet_privileged` and a run-scoped grant set by the signed `handle_run` (a concurrent unrelated run never inherits it). `priv_shell`: `AVRONE_PRIV_SHELL_ALLOW` bare-name allowlist (empty = refuse all), no metacharacters/pipelines/redirects, args re-quoted, `AVRONE_PRIV_SHELL_TIMEOUT` (30 s, max 300). `priv_admin`: fixed read-only actions (queue_stats, node_list, fleet_info, codex_runs, codex_tail). Audited as `priv.shell` / `priv.refused` / `admin.action` / `admin.refused`.
- **Per-agent filesystem** — each agent role gets `workspace/agents/<id>/` (0700, symlink-proof, confined); its `shell` commands start there. Docker: shared container uses `-w /workspace/agents/<id>`; `AVRONE_AGENT_DOCKER_ISOLATE=1` runs each command in a throwaway container with only that dir mounted at `/agent`. Tools `fs_write/fs_read/fs_list/fs_delete`, quota `AVRONE_AGENT_FS_QUOTA_MB` (50, max 1024), per-file `AVRONE_AGENT_FS_MAX_FILE_MB` (5, max 64). `AVRONE_AGENT_FS=0` disables.
- **Durable agent memory + edge sync** — per-agent namespaces in memory.jsonl (survive restarts, flock + atomic rewrite, caps `AVRONE_MEMORY_MAX_ENTRIES/VALUE/NAMESPACES`), `memory_list`. `memory_sync` pushes to the parent over a new signed `/api/fleet/memory` (full dispatch_gateway, capability `memory:sync`); receiver merges into `fleet:<sender>/<ns>`, never its own namespaces, newest wins.
- **Resilience governor** — reads load/CPU, memory, disk free and CPU temperature (psutil, `/proc`, `/sys/class/thermal`) and throttles squad/deep parallelism on hot or starved nodes (`AVRONE_THERMAL_MAX_C` 85, `AVRONE_MIN_PARALLEL` 1, `AVRONE_GOVERNOR`). Never 0, never deadlocks, falls back to full parallelism if sensors fail. Checkpoint/resume for long squad and deep runs (`--checkpoint PATH`). Node health + throttle/resume counts in telemetry.
- **Timeouts** — `AVRONE_AGENT_TIMEOUT` stays off by default (decision 2026-10-28).

## v0.15: Squad round 2 — secure node dispatch gateway, privileged tier, background evolve, doctor — 1129 tests, coverage 95%

- **Dispatch gateway** — every inbound `/api/fleet/run` and `/api/fleet/message` goes through `FleetManager.dispatch_gateway`: token -> HMAC -> 60 s window -> nonce replay -> sender in `AVRONE_FLEET_ALLOW` -> hops -> capability. Distinct refusal codes (401 auth / 403 policy), `fleet.dispatch` / `fleet.refused` audit. `AVRONE_FLEET_REQUIRE_ALLOW=1` makes an empty allowlist refuse everyone. Outbound calls pre-check the same rules.
- **Privileged tier (deny by default)** — `priv:shell` / `priv:admin` requests only pass when the target has `AVRONE_FLEET_PRIVILEGED=allow` (exact) AND lists the sender in `AVRONE_PRIVILEGED_NODES`, within `AVRONE_FLEET_PRIVILEGED_MAX_HOPS` (default 1, direct only). The flag lives inside the HMAC-signed body; an unsigned header or in-transit edit is refused. Today it marks the run (`core.fleet_privileged`); no tool consumes it yet.
- **Evolve** — `evolve_start` / `evolve_cancel` background loops (same 10-iteration / 1800 s caps, max 2 concurrent, cancel-file survives restarts, deny re-checked between iterations, orphans show `interrupted`). `evolve_skill_propose` writes a new `skills/<name>/SKILL.md` only through the throwaway-clone + full-suite gate, confined to `skills/`, 16 KB cap, no overwrites.
- **Tooling** — deep `rounds` (clamped 1..5) on `/api/chat`, MCP `avrone_deep`, CLI and fleet remote deep. mcp_client, netdiag, agentkit to 100% coverage.
- **Hosting** — `avrone-cli doctor [--json PATH] [--strict]`: offline preflight with insecure-combo warnings (exposed shell, weak/placeholder/reused tokens, open fleet allowlist, privileged tier, cleartext fleet links). Dockerfile runs as uid 10001 with healthcheck; compose adds `cap_drop: ALL`, `no-new-privileges`, read-only rootfs, sandbox network off, and **publishes on 127.0.0.1 by default** (`AVRONE_PUBLISH_ADDR=0.0.0.0` for LAN). Fixed compose `.env` host/data_dir bugs. bootstrap.py 100%.

## v0.14: Squad Recon round — self-scan, hardened recon, evolve loop, multi-round deep — 767 tests, coverage 88%

Four lanes in parallel (git worktrees, two commits each, full suite green per commit), Lead merge + fix:

- **Introspect** — `self_scan` (read-only inventory of the agent's OWN host: OS, paths, runner, toggles, tools, interfaces; secret-shaped env values shown only as `***set***`/`unset`) and `capabilities_report` (plain-English CAN/CANNOT ledger).
- **Recon hardening** — one shared gate for all six recon/OSINT tools: kill switch -> target syntax -> `_reject_private` -> allowlist. Refuses IP literals (all encodings), CIDR/lists/wildcards, loopback/private/link-local/CGNAT/reserved, cloud-metadata hosts, internal TLDs, nip.io-style embedded private IPs; resolves first and connects only to the vetted public address; re-checks every redirect. `AVRONE_RECON` parsed strictly (unknown = off). Fixed cert_transparency suffix match (evilexample.com). Every refusal audited as `recon.refused`.
- **Self-evolve loop** — `evolve_loop` / `evolve_status`: up to N propose->full-suite iterations, stops on first pass, hard caps 10 iterations / 1800 s (`AVRONE_EVOLVE_MAX_ITERS`, `AVRONE_EVOLVE_TIME_BUDGET` can only lower). Still throwaway worktrees only, never touches main, never pushes.
- **Deep search** — multi-round `deep()` (`rounds=`, `AVRONE_DEEP_ROUNDS`, `avrone-cli deep --rounds`, cap 5), early stop on convergence (no new corrections), reviewer crash/junk/zero handling, `## Deep rounds` footer with confidence.
- **Lead fix** — `JobQueue`: closing while a cancelled claim was still inside SQLite could segfault the test run (~15% of runs). Thread lock + closed flag; regression tests.

## v0.13: Squad round (4 parallel lanes, Lead merge) — coverage 78% -> 87%, 379 tests

Four agents worked in separate branches; each landed two commits that passed the full suite, then the Lead merged and re-ran everything.

- **Coverage lane:** `test_fleet_edges.py` (fleet.py 48% -> 100%: HMAC failures, replayed nonce, stale timestamps, hop limits, allowlist, node-id collision, status ageing, routing errors) and `test_server_edges.py` (server.py 61% -> 99%, tools.py and sovereign.py -> 100%). Fixes: signed fleet requests with a malformed or non-object JSON body now return 400 (they returned 500), and `GET /api/runs/{id}` for an unknown run now returns 404 (it returned 200 `[]`).
- **Tools lane:** new `diff_files` (unified diff of two workspace files or a file vs text; path-confined, binary and size checks, capped output) and `codex_search` (read-only search of the Eternal CodeX logs by kind, agent, tool, substring or run id).
- **Skills lane:** hardened skill loader (one empty SKILL.md no longer hides every skill; real frontmatter parser; path-traversal, symlink and bad-name refusal; folder skills win over flat duplicates; sorted, stable `skill_list`). New playbooks `test-coverage-sweep` and `incident-triage`, plus a catalog test that every skill parses and names only real tools.
- **Robustness lane:** a crashing or hung worker no longer sinks a squad (failures become notes, the Lead merges the rest; optional `AVRONE_AGENT_TIMEOUT`, default off); junk planner output is normalised. Codex skips truncated or corrupt JSONL lines instead of 500ing a run log, closes file handles, and locks concurrent writes.
- Lead: FastAPI app version now tracks the package version.

## v0.12: Hardening + coverage round (66% -> 78%)

- **Security fix:** `AVRONE_RECON_ALLOWLIST` matched bare suffixes, so `evilmysite.com` passed an allowlist of `mysite.com`. Now only the exact host or a true subdomain (`*.mysite.com`) passes; a leading-dot entry (`.partner.org`) works too.
- `port_scan` validates ports (1-65535) and de-duplicates them before probing.
- MCP server clamps `squad_size` to its advertised 1-8 schema and reports the real package version.
- New offline suites: `test_cli.py` (0% -> 99%), `test_mcp_server.py` (0% -> 80%, full stdio JSON-RPC loop), `test_llm_legacy.py` (45% -> 100%), `test_recon_offline.py` (44% -> 97%). The old allowlist test no longer touches the network.

## v0.11: OSINT aggregation & metrics

- `osint_domain` — aggregate one domain's public footprint (DNS + TLS + HTTP + certificate-transparency subdomains) into a single structured profile. Public data, one domain per call, no private-individual targeting.
- `osint_metrics` / `GET /api/osint/metrics` — roll up recorded recon/OSINT activity from the action logs: counts per tool and top targets. Data-driven view of what the fleet has probed.
- Same guardrails as recon: AVRONE_RECON / AVRONE_RECON_ALLOWLIST, every call logged.

## v0.10: Advanced reconnaissance (bounded, authorized)

Deeper recon on hosts/domains you name, one target per call, public data or a direct connection only:
- `tls_inspect` — a host's TLS cert: issuer, validity, every SAN hostname.
- `http_fingerprint` — HTTP response headers (server/tech hints) and which security headers are missing.
- `cert_transparency` — a domain's subdomains from public certificate-transparency logs (crt.sh).
- `dns_enum` — A/AAAA/MX/NS/TXT/CNAME/SOA via DNS-over-HTTPS.
- `port_scan` — TCP-connect scan of a small port set on ONE host, and **only** with `authorized=true`; scanning third-party hosts is refused.

Guardrails: one target per call, no sweeps or ranges, `AVRONE_RECON=allow|deny`, optional `AVRONE_RECON_ALLOWLIST`, every call logged to Codex. No access to private infrastructure, satellites, towers, or any capability AVRONE does not actually have.

## v0.9: Self-evolution (AVRONE edits its own code, safely)

- Agents can propose changes to AVRONE's **own** codebase with `evolve_propose` ({goal, edits:[{path, content}]}).
- Each proposal is applied in a **throwaway clone** of the repo and the **full test suite is run**. It is kept only if every test passes; a failing proposal is discarded with its test output so the agent can retry.
- Nothing is pushed and **nothing touches `main`** or the live tree. An accepted change lands on an `evolve/<id>` branch in the sandbox and is surfaced as a diff (`evolve_diff`) for a human to review and merge.
- Paths that escape the repo are rejected. Tools: `evolve_propose`, `evolve_diff`, `evolve_list`, `evolve_reset`. `GET /api/evolve` and `avrone-cli evolve` list accepted proposals.
- Config: `AVRONE_SELF_EVOLVE=allow`(default)`|deny`, `AVRONE_REPO_DIR`, `AVRONE_EVOLVE_TEST_CMD` (default `python -m pytest -q`).

## v0.8: Agent kit (tooling, skills, resources, tasks)

- **Vision tools:** `image_inspect` (size, entropy, colors, estimated barcode grid) and `image_decode` (QR, DataMatrix, Aztec, PDF417, 1D at several scales). `pip install -e ".[vision]"`.
- **Skills:** markdown playbooks in `skills/` (`skill_list`, `skill_load`). Ships with barcode-forensics, network-mapping and self-heal-environment. Add your own as `skills/<name>/SKILL.md`.
- **Self-changes, logged:** `env_install` (pip, or apt with sudo fallback). Every install, including ones run through `shell`, goes to the resource ledger (`resources` tool, `env.change` events). Policy `AVRONE_SELF_CHANGES=allow` (default) | `log` | `deny`.
- **Task board:** `task_board` lets a squad split work into subtasks with owners and status, shared across the run.
- Agents are told to load fitting skills first, track multi-part work on the board, and self-heal missing tools.

## v0.7: Gateway and model fallback

AVRONE routes model calls across several providers so agents keep working when one throttles or fails.

- Set `AVRONE_LLM_FALLBACKS=openrouter:x-ai/grok-4,ollama:llama3.1` (each entry is `provider[:model][|lead_model]`). Each provider's key comes from its usual env var.
- On a 429, 5xx or network error the gateway retries the primary, then moves to the next healthy provider; results note the route taken.
- A circuit breaker opens a provider after repeated failures (`AVRONE_BREAKER_THRESHOLD`, default 3) for a cooldown (`AVRONE_BREAKER_COOLDOWN`, default 30s), so a throttled provider is skipped instead of hammered.
- Lead and worker models are chosen per provider.
- `GET /api/gateway` shows each upstream's state, calls, errors and the last route.

## v0.6: Fleet directory, agent messaging, durable queue

- **Where every agent is:** each node reports its device (hostname, OS, arch), runner and container, network interfaces and addresses, and services (URL, tools, MCP servers, model), plus every agent with its role, status and task. Routers fold in their children, so Main AVRONE sees the whole tree. `GET /api/fleet/directory` (admin), the Map tab, and the `fleet_agents` tool.
- **Tell any agent to build:** `agent_message` tool or `POST /api/fleet/tell` with `{"agent": "router/edge/Builder-3", "message": "..."}`. A live agent gets it in its inbox and acts on its next step inside its own container; a finished one is respawned on that node. Short names work when unique.
- **Durable job queue:** SQLite (WAL) per node, atomic claims, retries with backoff, dead-letter after max attempts, crash recovery via leases. Tools `queue_submit` / `queue_status`, `GET /api/fleet/jobs`.

## v0.5: Fleet (remote routers and servers)

Link AVRONE servers into a tree. Any server can be a node, a router (a node with
children) or both, and agents on every node can spawn agents on the others.

- **Join:** set `AVRONE_FLEET_TOKEN` (same on all nodes), `AVRONE_NODE_ID`, `AVRONE_PUBLIC_URL`, and `AVRONE_FLEET_PARENT` to the router or root it reports to. It registers and heartbeats; status shows online, degraded or offline.
- **Agent tools:** `fleet_nodes`, `remote_spawn` (target a node, a route like `router1/edge7`, or `auto` for least loaded) and `remote_broadcast` (same task on up to 8 nodes in parallel). Remote agents get the same tools, so they spawn further down the tree.
- **Routing:** jobs are forwarded hop by hop through routers; results return the full path.
- **Security:** every fleet request is HMAC-SHA256 signed (method, path, timestamp, nonce, body hash), 60 s window, replayed nonces rejected, hop limit (`AVRONE_FLEET_MAX_HOPS`, default 3), optional node allowlist (`AVRONE_FLEET_ALLOW`), node-id collision checks. Use HTTPS or a private mesh for confidentiality.
- **Visibility:** `GET /api/fleet` (admin) and the Map tab show the node tree.
- Example: `examples/fleet-compose.yml` (root, router, edge).

## v0.4: Network diagnostics tools

Real, bounded networking from AVRONE's own host (one host and port per call, no port sweeping):

- `dns_lookup`: A/AAAA/MX/TXT/NS/CNAME/SOA/PTR/CAA/SRV via the system resolver plus DNS-over-HTTPS
- `tcp_ping`: TCP connect latency to host:port, no root or ICMP needed
- `traceroute`: hop-by-hop route via mtr, traceroute or tracepath (bundled in the Docker image)
- `rdap_whois`: registrar, dates, nameservers or IP network owner via RDAP
- `ip_geo`: approximate city, ASN and ISP for a public IP or hostname (blank = AVRONE's own)

Ask a squad things like "trace the route to github.com and tell me who runs each network".

## Quick start

```bash
pip install -e ".[dev]"
cp .env.example .env          # set your OpenClaw token, or AVRONE_LLM_MODE=mock to demo
avrone                        # http://127.0.0.1:8710
```

### Connect OpenClaw

1. Install and run OpenClaw (the macOS app, or `npm i -g openclaw` on Linux).
2. Turn on its OpenAI-compatible endpoint (off by default). Merge
   `deploy/openclaw.json5` into `~/.openclaw/openclaw.json`, set a token, restart the gateway.
3. Put that token in `AVRONE_LLM_API_KEY`. Default URL is `http://127.0.0.1:18789/v1`.

Each AVRONE agent gets its own OpenClaw session (`x-openclaw-session-key`), so
squad members don't share context.

### Run in Docker

```bash
cp .env.example .env
docker compose up --build
```

AVRONE launches its agent environment as a sibling container through the host
Docker socket, with the workspace bind-mounted.

## API

```bash
# Squad (Grok Heavy style)
curl -s localhost:8710/api/chat -H 'content-type: application/json' \
  -d '{"message":"Build a FastAPI todo app in the workspace and test it","mode":"squad","squad_size":4}'

# Long-running job: returns immediately, watch it on the HUD
curl -s localhost:8710/api/chat -H 'content-type: application/json' \
  -d '{"message":"...","background":true}'

curl -s localhost:8710/api/runs              # past runs
curl -s localhost:8710/api/runs/<run_id>     # full action log
curl -s localhost:8710/api/terminal -H "X-Admin-Token: $AVRONE_ADMIN_TOKEN" \
  -H 'content-type: application/json' -d '{"cmd":"ls -la"}'
# Live events: ws://localhost:8710/ws/events
```

## Safety

Agents run real commands. Prefer the Docker runner, keep `AVRONE_HOST=127.0.0.1`
unless you put auth in front of it, set `AVRONE_ALLOW_NETWORK=false` or
`AVRONE_AGENTS_CAN_SHELL=false` to tighten things, and leave `AVRONE_ADMIN_TOKEN`
empty to turn the admin terminal off.

## Tests

```bash
pytest -q     # runs fully offline with the mock model and local runner
```

## Roadmap

- Native iOS/Android shell on the same API
- Self-hosted runners pool (multiple environments, one per run)
- Model hosting environment (Ollama/vLLM container managed by Sovereign OS)
- Persistent agent memory in Eternal CodeX
