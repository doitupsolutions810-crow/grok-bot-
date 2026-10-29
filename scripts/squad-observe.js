import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const BASE = (process.env.GROKBOT_URL || "http://localhost:3000").replace(/\/+$/, "");
const AVRONE = (process.env.AVRONE_URL || "").replace(/\/+$/, "");
const DATA = process.env.DATA_DIR || "/app/data";
const REPORT_DIR = join(DATA, "observations");
const EXPECTED_WORKERS = Math.max(2, Number(process.env.GROK_SQUAD_N) || 2);
const marker = "SQUAD_OBSERVATION_" + Date.now().toString(36) + "_" + randomUUID().slice(0, 8);
const failures = [];
const snapshot = { createdAt: new Date().toISOString(), marker, expectedWorkers: EXPECTED_WORKERS,
  nodeRuntime: null, grokBot: null, governor: null, containers: null, avrone: null, grokSquad: null,
  grokToAvrone: { configured: !!AVRONE, ok: false, error: AVRONE ? "Forward bridge not attempted yet." : "AVRONE_URL is not configured." },
  avroneToGrok: { configured: !!AVRONE, ok: false, error: AVRONE ? "Reverse bridge not attempted yet." : "AVRONE_URL is not configured." },
  avroneSquadTrace: null, avroneReverseTrace: null, bridgeReceipts: [], conclusions: [] };

function redact(value, cap = 3000) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|password|secret|authorization|cookie|private[_ -]?key)(\s*[:=]\s*)(["']?)[^\s"',;]+/gi, "$1$2[REDACTED]")
    .slice(0, cap);
}

function runReadOnlyCommand(command, args) {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf8", timeout: 4000, maxBuffer: 8192,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return { ok: true, output: redact(String(output || "").trim(), 1600) };
  } catch (error) {
    const output = [error.stdout, error.stderr, error.message].filter(Boolean).join("\n");
    return { ok: false, output: redact(output.trim(), 500) };
  }
}

function inspectNodeRuntime() {
  const mb = value => Math.round(value / (1024 * 1024));
  return {
    capturedAt: new Date().toISOString(),
    process: {
      version: process.version, platform: process.platform, arch: process.arch,
      pid: process.pid, uid: typeof process.getuid === "function" ? process.getuid() : null,
      gid: typeof process.getgid === "function" ? process.getgid() : null,
      cwd: process.cwd(), uptimeSeconds: Math.round(process.uptime())
    },
    os: {
      hostname: redact(os.hostname(), 120), release: os.release(),
      platform: os.platform(), arch: os.arch(),
      availableParallelism: typeof os.availableParallelism === "function"
        ? os.availableParallelism() : os.cpus().length,
      loadAverage: os.loadavg().map(n => Number(n.toFixed(2))),
      totalMemoryMB: mb(os.totalmem()), freeMemoryMB: mb(os.freemem()),
      uptimeSeconds: Math.round(os.uptime())
    },
    dataDirectory: DATA,
    avroneUrlConfigured: !!AVRONE,
    commands: {
      uname: runReadOnlyCommand("uname", ["-a"]),
      hostname: runReadOnlyCommand("hostname", []),
      utcTime: runReadOnlyCommand("date", ["-u", "+%Y-%m-%dT%H:%M:%SZ"]),
      nodeVersion: runReadOnlyCommand("node", ["--version"]),
      pythonVersion: runReadOnlyCommand("python3", ["--version"]),
      processOne: runReadOnlyCommand("ps", ["-p", "1", "-o", "pid=,comm="]),
      disk: runReadOnlyCommand("df", ["-h", "/app", "/app/data", "/tmp"]),
      osRelease: runReadOnlyCommand("cat", ["/etc/os-release"])
    }
  };
}


async function requestJson(url, options = {}, timeoutMs = 15000) {
  const response = await fetch(url, { ...options,
    headers: { ...(options.headers || {}), ...(options.body ? { "content-type": "application/json" } : {}) },
    signal: AbortSignal.timeout(timeoutMs) });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = { text: raw.slice(0, 1200) }; }
  if (!response.ok) throw new Error("HTTP " + response.status + " from " + new URL(url).origin +
    new URL(url).pathname + ": " + redact(JSON.stringify(body), 500));
  return { status: response.status, body };
}

async function probe(label, url, options = {}, timeoutMs = 15000) {
  try { const result = await requestJson(url, options, timeoutMs);
    return { ok: true, httpStatus: result.status, body: result.body };
  } catch (error) {
    const note = label + ": " + redact(error.message, 600);
    failures.push(note);
    return { ok: false, error: note };
  }
}

function safeGrokStatus(body) {
  const tests = Array.isArray(body?.selftest) ? body.selftest.map(t =>
    ({ name: String(t.name || "unnamed"), ok: !!t.ok })) : [];
  return { ready: body?.ready === true, degraded: body?.degraded === true,
    toolCount: Array.isArray(body?.tools) ? body.tools.length : null, selftest: tests };
}

function safeAvroneStatus(body) {
  return { runner: body?.runner || null, provider: body?.provider || null, model: body?.model || null,
    tools: Number.isFinite(body?.tools) ? body.tools : null,
    agents: Number.isFinite(body?.agents) ? body.agents : null, adminEnabled: !!body?.admin_enabled };
}

function summarizeContainers(body) {
  if (!Array.isArray(body)) return { count: null, items: [] };
  return { count: body.length, items: body.slice(0, 30).map(c => ({
    id: c.id || null, names: Array.isArray(c.names) ? c.names.map(n => String(n).replace(/^\//, "")) : [],
    image: c.image || null, state: c.state || null })) };
}

function findMatchingRun(runs, needle) {
  if (!Array.isArray(runs)) return null;
  return runs.find(run => Array.isArray(run.events) && run.events.some(e =>
    e.kind === "run.start" && String(e.question || e.task || "").includes(needle))) || null;
}

function intervalsFor(events) {
  const starts = new Map(), finishes = new Map();
  for (const e of events) {
    if (e.kind === "worker.start" && e.agent && Number.isFinite(e.at_ms)) starts.set(e.agent, e.at_ms);
    if (e.kind === "worker.finish" && e.agent && Number.isFinite(e.at_ms)) finishes.set(e.agent, e.at_ms);
  }
  return [...starts.entries()].flatMap(([agent, start]) => {
    const end = finishes.get(agent);
    return Number.isFinite(end) ? [{ agent, start, end }] : [];
  });
}

function countOverlappingPairs(intervals) {
  let count = 0;
  for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length; j++) {
    if (Math.max(intervals[i].start, intervals[j].start) < Math.min(intervals[i].end, intervals[j].end)) count++;
  }
  return count;
}

async function saveReport() {
  snapshot.failures = failures.slice();
  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = join(REPORT_DIR, "latest.json"), mdPath = join(REPORT_DIR, "latest.md");
  writeFileSync(jsonPath, JSON.stringify(snapshot, null, 2) + "\n");
  const findings = snapshot.grokSquad?.findings || [];
  const selftests = snapshot.grokBot?.summary?.selftest || [];
  const lines = [
    "# Live Squad Observation", "",
    "- Created: " + snapshot.createdAt,
    "- Run marker: " + marker,
    "- Configured worker count: " + EXPECTED_WORKERS, "",
    "## Node-container runtime", "",
    "- Node: " + (snapshot.nodeRuntime?.process?.version || "unavailable") + " (" +
      (snapshot.nodeRuntime?.process?.platform || "unknown") + "/" + (snapshot.nodeRuntime?.process?.arch || "unknown") + ")",
    "- Hostname / release: " + (snapshot.nodeRuntime?.os?.hostname || "unknown") + " / " + (snapshot.nodeRuntime?.os?.release || "unknown"),
    "- PID / UID / GID: " + [snapshot.nodeRuntime?.process?.pid, snapshot.nodeRuntime?.process?.uid, snapshot.nodeRuntime?.process?.gid].map(v => v ?? "unknown").join(" / "),
    "- Working directory: " + (snapshot.nodeRuntime?.process?.cwd || "unknown"),
    "- CPU lanes / load: " + (snapshot.nodeRuntime?.os?.availableParallelism ?? "unknown") + " / " + (snapshot.nodeRuntime?.os?.loadAverage || []).join(", "),
    "- Memory total/free MB: " + (snapshot.nodeRuntime?.os?.totalMemoryMB ?? "unknown") + " / " + (snapshot.nodeRuntime?.os?.freeMemoryMB ?? "unknown"),
    ...Object.entries(snapshot.nodeRuntime?.commands || {}).flatMap(([name, result]) => [
      "### " + name + (result.ok ? " — observed" : " — unavailable"), "",
      "`" + (result.ok ? "output captured" : "command failed") + "`",
      redact(result.output || "(no output)", 1600), ""
    ]),
    "",
    "## Runtime witnesses", "",
    "- Grok Bot API: " + (snapshot.grokBot?.ok ? "reachable" : "unavailable"),
    "- Grok Bot ready: " + (snapshot.grokBot?.summary?.ready ?? "unknown"),
    "- Self-tests: " + selftests.filter(t => t.ok).length + "/" + selftests.length + " passed",
    "- Governor: " + (snapshot.governor?.body ?
      snapshot.governor.body.state + ", target " + snapshot.governor.body.target + "/" + snapshot.governor.body.max : "unavailable"),
    "- Container API: " + (snapshot.containers?.summary?.count ?? "unavailable") + " container records",
    "- AVRONE API: " + (snapshot.avrone?.ok ? "reachable" : AVRONE ? "unreachable" : "not configured"),
    snapshot.avrone?.summary ? "- AVRONE runner/provider/model: " + [snapshot.avrone.summary.runner,
      snapshot.avrone.summary.provider, snapshot.avrone.summary.model].map(v => v || "unknown").join(" / ") : "",
    "", "## Dual-parallel S-mode execution", "",
    "- Workers spawned: " + (snapshot.grokSquad?.spawned ?? 0) + "/" + EXPECTED_WORKERS,
    "- Successful worker findings: " + (snapshot.grokSquad?.successfulFindings ?? 0) + "/" + EXPECTED_WORKERS,
    "- Overlapping worker interval pairs: " + (snapshot.grokSquad?.overlappingPairs ?? 0),
    "- Run ID: " + (snapshot.grokSquad?.runId || "not found"), "",
    ...findings.flatMap(f => ["### " + f.agent + " — " + (f.ok ? "finding captured" : "worker failure"), "",
      "Task: " + redact(f.task || "not recorded", 600),
      "Observed tool calls: " + ((f.tools || []).join(", ") || "none recorded"),
      "Tool-result receipts: " + (f.toolResultReceipts ?? 0) +
        " (marked ok " + (f.successfulToolResults ?? 0) + ", marked failed " + (f.failedToolResults ?? 0) + ")",
      ...((f.toolReceipts || []).slice(-8).flatMap(t => [
        "- Tool output: " + t.tool + " (ok=" + t.ok + ")",
        redact(t.output || "(no safe textual output recorded)", 1000)
      ])),
      "",
      f.ok ? redact(f.answer || "(no answer text)", 2400) : "Error: " + redact(f.error || "unknown", 500), ""]),
    "### S-mode lead conclusion", "", redact(snapshot.grokSquad?.answer || "No lead answer returned.", 3000),
    "", "## AVRONE agent communication", "",
    "Forward bridge run ID: " + (snapshot.avroneSquadTrace?.runId || "unavailable"),
    "AVRONE CodeX events: " + (snapshot.avroneSquadTrace?.eventCount ?? "unavailable"),
    "AVRONE cross-agent bridge posts: " + (snapshot.avroneSquadTrace?.bridge?.count ?? "unavailable"),
    ...((snapshot.avroneSquadTrace?.bridge?.posts || []).slice(-12).flatMap(p => [
      "### " + p.agent + (p.role ? " (" + p.role + ")" : "") + " — " + p.kind,
      "", redact(p.text, 1200), ""
    ])),
    "Reverse bridge run ID: " + (snapshot.avroneReverseTrace?.runId || "unavailable"),
    "Reverse trace events: " + (snapshot.avroneReverseTrace?.eventCount ?? "unavailable"),
    "", "## Bridge conclusions", "",
    "- Grok Bot → AVRONE: " + (snapshot.grokToAvrone?.ok ? "tool returned a nonempty squad answer" :
      snapshot.grokToAvrone?.configured ? "failed or unverified" : "not configured"),
    snapshot.grokToAvrone?.answer ? redact(snapshot.grokToAvrone.answer, 2400) : (snapshot.grokToAvrone?.error || ""),
    "", "- AVRONE → Grok Bot: " + (snapshot.avroneToGrok?.ok ? "successful bridge receipt confirmed" :
      snapshot.avroneToGrok?.configured ? "failed or unverified" : "not configured"),
    snapshot.avroneToGrok?.receipt ? "Receipt: " + JSON.stringify(snapshot.avroneToGrok.receipt) :
      (snapshot.avroneToGrok?.answer ? redact(snapshot.avroneToGrok.answer, 1400) : ""),
    "", "## Evidence-based conclusions", "",
    ...(snapshot.conclusions.length ? snapshot.conclusions.map(c => "- " + c) : ["- No conclusions established."]),
    "", "## Gaps and failures", "",
    ...(failures.length ? failures.map(f => "- " + redact(f, 600)) : ["- No probe failures recorded."]),
    "", "## Learning-loop contract", "",
    "This report records observations, worker findings, bridge receipts, and proposed next actions. It does not autonomously alter source code; source changes remain test-gated."
  ].filter(Boolean).join("\n");
  writeFileSync(mdPath, lines + "\n");
  console.log("Observation report written: " + mdPath);
  console.log("Observation JSON written: " + jsonPath);
  console.log(lines);
}

async function main() {
  snapshot.nodeRuntime = inspectNodeRuntime();
  const grok = await probe("Grok Bot status", BASE + "/api/status");
  snapshot.grokBot = grok.ok ? { ok: true, httpStatus: grok.httpStatus, summary: safeGrokStatus(grok.body) } : grok;
  if (grok.ok && grok.body?.ready !== true) failures.push("Grok Bot /api/status did not report ready:true.");

  const governor = await probe("Grok Bot governor", BASE + "/api/governor");
  snapshot.governor = governor.ok ? { ok: true, httpStatus: governor.httpStatus, body: governor.body } : governor;
  const containers = await probe("Grok Bot container inventory", BASE + "/api/docker/containers");
  snapshot.containers = containers.ok ? { ok: true, httpStatus: containers.httpStatus, summary: summarizeContainers(containers.body) } : containers;

  if (AVRONE) {
    const avr = await probe("AVRONE status", AVRONE + "/api/status");
    snapshot.avrone = avr.ok ? { ok: true, httpStatus: avr.httpStatus, summary: safeAvroneStatus(avr.body) } :
      { configured: true, ...avr };
    if (avr.ok && (!avr.body?.runner || !avr.body?.provider)) failures.push("AVRONE status omitted runner/provider evidence.");
  } else {
    snapshot.avrone = { configured: false, ok: false, error: "AVRONE_URL is not configured." };
    failures.push("AVRONE_URL is not configured; the required integrated-stack bridge checks were skipped.");
  }

  const prompt = [
    "Read-only dual-parallel runtime observation. Correlation marker: " + marker + ".",
    "Use exactly two independent parallel workers, then a lead synthesis.",
    "Worker 1: use the terminal tool and independently inspect the assigned terminal sandbox with read-only commands: uname -a, hostname, date -u, node --version, python3 --version, uptime, df -h ., cat /etc/os-release, ps -p 1 -o pid=,comm=, and pwd. Include exact commands, concise outputs, and command failures. Do not dump environment variables or secrets. Do not assume the sandbox is the Grok Bot server container; distinguish its identity from the separately collected Node-container runtime snapshot.",
    "Worker 2: use the terminal tool to make read-only HTTP probes from the assigned sandbox. Run curl -fsS --max-time 8 http://grok-bot:3000/api/status, curl -fsS --max-time 8 http://grok-bot:3000/api/governor, and curl -fsS --max-time 8 http://avrone:8710/api/status. Report exact HTTP/status output or DNS/network errors. Do not dump environment variables or call any mutating endpoint. Also compare your probe results with the separately collected server-side status data.",
    "Never dump the full environment or print secret values, tokens, cookies, credentials, private data, or full config files. For environment variables, report only safe variable names and present/missing. Separate observed facts from inferences and list unavailable probes as gaps.",
    "Lead: compare reports, identify agreements and contradictions, conclude what the node/server/environment actually reveal, and state whether worker execution intervals overlapped. Do not claim a bridge without a concrete response or receipt."
  ].join("\n");
  const squad = await probe("Grok Bot S-mode run", BASE + "/api/chat", {
    method: "POST", body: JSON.stringify({ agentId: "grok-main", mode: "squad", message: prompt, session: "observation-" + marker })
  }, 240000);
  if (!squad.ok) {
    snapshot.grokSquad = { ok: false, error: squad.error, spawned: 0, successfulFindings: 0, overlappingPairs: 0, findings: [] };
    failures.push("Dual-parallel Grok Bot S-mode execution did not complete.");
  } else {
    const runsProbe = await probe("Grok Bot run traces", BASE + "/api/runs");
    const run = runsProbe.ok ? findMatchingRun(runsProbe.body, marker) : null;
    const events = run?.events || [];
    const spawned = events.filter(e => e.kind === "agent.spawn");
    const findings = events.filter(e => e.kind === "worker.finding").map(e => {
      const agent = e.agent || "unknown";
      return {
        agent, ok: e.ok === true, task: redact(e.task || "", 600),
        answer: redact(e.answer || "", 2400), error: redact(e.error || "", 500), answerChars: e.answer_chars || 0,
        tools: [...new Set(events.filter(t => t.kind === "tool.call" && t.agent === agent).map(t => String(t.tool || "unknown")))],
        toolResultReceipts: events.filter(t => t.kind === "tool.result" && t.agent === agent).length,
        successfulToolResults: events.filter(t => t.kind === "tool.result" && t.agent === agent && t.ok === true).length,
        failedToolResults: events.filter(t => t.kind === "tool.result" && t.agent === agent && t.ok === false).length,
        toolReceipts: events.filter(t => t.kind === "tool.result" && t.agent === agent).slice(-12).map(t => ({
          tool: String(t.tool || "unknown"), ok: typeof t.ok === "boolean" ? t.ok : null,
          output: redact(t.output_excerpt || t.output || t.error_excerpt || "", 1000)
        }))
      };
    });
    const overlappingPairs = countOverlappingPairs(intervalsFor(events));
    snapshot.grokSquad = { ok: true, httpStatus: squad.httpStatus, runId: run?.runId || null,
      spawned: spawned.length, successfulFindings: findings.filter(f => f.ok).length, overlappingPairs,
      notes: Array.isArray(squad.body?.notes) ? squad.body.notes.map(n => redact(n, 300)) : [],
      findings, answer: redact(squad.body?.answer || "", 3000) };
    if (!run) failures.push("Completed S-mode run could not be matched to CodeX evidence.");
    if (spawned.length !== EXPECTED_WORKERS) failures.push("S-mode spawned " + spawned.length + " workers; expected " + EXPECTED_WORKERS + ".");
    if (findings.filter(f => f.ok).length !== EXPECTED_WORKERS) failures.push("Successful worker findings: " +
      findings.filter(f => f.ok).length + "; expected " + EXPECTED_WORKERS + ".");
    for (const requiredAgent of ["worker-1", "worker-2"]) {
      const finding = findings.find(f => f.agent === requiredAgent);
      if (!finding?.tools?.includes("terminal")) {
        failures.push(requiredAgent + " did not invoke the real terminal tool; command-level environment observation is unverified.");
      }
    }
    if (overlappingPairs < 1) failures.push("No overlapping worker intervals were evidenced; parallel execution is unverified.");
  }

  if (AVRONE && snapshot.avrone?.ok) {
    const bridgePrompt = [
      "Read-only cross-system S-mode conclusion. Marker: " + marker + ".",
      "Use your real AVRONE squad to inspect your runner/provider/model/tool inventory and independently assess the Grok Bot telemetry below. Each parallel worker should use the shell tool for only read-only probes where supported: uname -a, hostname, date -u, python3 --version, ps -p 1 -o pid=,comm=, df -h /srv/workspace /srv/data, pwd, and ls -ld /srv/workspace /srv/data. Report exact outputs, observed tool names, and command failures. Do not dump environment variables or full config files.",
      "Do not reveal secrets or dump environment values. Separate status/tool evidence from assumptions; state inaccessible network paths.",
      "Grok Bot snapshot: ready=" + snapshot.grokBot?.summary?.ready + "; governor=" +
        (snapshot.governor?.body?.state || "unknown") + "; lanes=" +
        (snapshot.governor?.body?.target ?? "?") + "/" + (snapshot.governor?.body?.max ?? "?") +
        "; observed workers=" + (snapshot.grokSquad?.successfulFindings ?? 0) + "/" + EXPECTED_WORKERS + ".",
      "Return a concise evidence-based conclusion and the top two next checks. No source edits or destructive actions."
    ].join("\n");
    const forward = await probe("Grok Bot to AVRONE squad bridge", BASE + "/api/tools/avrone.squad/invoke", {
      method: "POST", body: JSON.stringify({ prompt: bridgePrompt, mode: "squad" })
    }, 240000);
    snapshot.grokToAvrone = forward.ok
      ? { configured: true, ok: !!forward.body?.ok && typeof forward.body?.answer === "string" &&
          !!forward.body.answer.trim() && typeof forward.body?.runId === "string" && !!forward.body.runId,
          runId: forward.body?.runId || null, answer: redact(forward.body?.answer || JSON.stringify(forward.body), 2400) }
      : { configured: true, ok: false, error: forward.error };
    if (!snapshot.grokToAvrone.ok) failures.push("Grok Bot → AVRONE did not return a nonempty squad answer with a correlatable AVRONE run ID.");

    if (forward.ok && forward.body?.runId) {
      const avrRunId = encodeURIComponent(forward.body.runId);
      const traceProbe = await probe("AVRONE squad CodeX replay", AVRONE + "/api/runs/" + avrRunId);
      const traceEvents = traceProbe.ok && Array.isArray(traceProbe.body) ? traceProbe.body : [];
      const bridgeProbe = await probe("AVRONE squad learning bridge", AVRONE + "/api/runs/" + avrRunId + "/bridge");
      const posts = bridgeProbe.ok && Array.isArray(bridgeProbe.body?.posts) ? bridgeProbe.body.posts : [];
      snapshot.avroneSquadTrace = {
        runId: forward.body.runId,
        eventCount: traceEvents.length,
        events: traceEvents.filter(e => ["agent.spawn", "agent.done", "tool.call", "tool.result", "bridge.post", "error", "run.done"].includes(e.kind))
          .slice(-80).map(e => ({
            kind: e.kind, agent: e.agent || null, tool: e.data?.tool || null,
            ok: typeof e.data?.ok === "boolean" ? e.data.ok : null,
            resultExcerpt: e.kind === "agent.done" ? redact(e.data?.result || "", 1000) :
              e.kind === "tool.result" ? redact(e.data?.output_excerpt || e.data?.output || e.data?.result || "", 1200) : null,
            message: e.kind === "error" ? redact(e.data?.message || "", 400) : null
          })),
        bridge: {
          count: Number.isFinite(bridgeProbe.body?.count) ? bridgeProbe.body.count : posts.length,
          posts: posts.slice(-16).map(p => ({
            agent: redact(p.agent || "unknown", 80), role: redact(p.role || "", 60),
            kind: p.kind || "finding", refs: Array.isArray(p.refs) ? p.refs.slice(0, 10) : [],
            originNode: redact(p.origin_node || "", 80), text: redact(p.text || "", 1200)
          }))
        }
      };
      if ((snapshot.avroneSquadTrace.bridge?.count ?? 0) < EXPECTED_WORKERS) {
        failures.push("AVRONE squad persisted fewer than " + EXPECTED_WORKERS +
          " inter-agent finding posts; cross-agent communication is not fully evidenced.");
      }
    } else {
      snapshot.avroneSquadTrace = { error: "The forward bridge did not return an AVRONE run ID; worker-level AVRONE trace unavailable." };
    }

    const toolsProbe = await probe("AVRONE tool inventory", AVRONE + "/api/tools");
    const toolEntries = toolsProbe.ok && Array.isArray(toolsProbe.body) ? toolsProbe.body : [];
    const grokToolPresent = toolEntries.some(t => t?.name === "grokbot.ask" || t?.id === "grokbot.ask");
    if (!toolsProbe.ok) failures.push("AVRONE tool inventory could not be read.");
    if (toolsProbe.ok && !grokToolPresent) failures.push("AVRONE tool inventory omitted grokbot.ask.");

    const reversePrompt = "Cross-bridge check " + marker + ". Use the dedicated grokbot.ask tool exactly once with this exact prompt: 'Reply with exactly AVRONE_TO_GROKBOT_BRIDGE_OK.' Report the actual returned tool result. Do not claim success unless the result confirms it. Never use an arbitrary URL or dump environment variables.";
    const reverse = await probe("AVRONE to Grok Bot bridge invocation", AVRONE + "/api/chat", {
      method: "POST", body: JSON.stringify({ mode: "chat", message: reversePrompt })
    }, 240000);
    const reverseAnswer = reverse.ok ? redact(reverse.body?.answer || JSON.stringify(reverse.body), 1800) : "";
    const receipts = await probe("AVRONE bridge run index", AVRONE + "/api/runs");
    let receipt = null;
    if (receipts.ok && Array.isArray(receipts.body)) {
      const recentRuns = receipts.body.slice(0, 12);
      const correlated = recentRuns.filter(r => String(r.prompt || "").includes(marker));
      // Never accept a receipt from an unrelated historical run as evidence for this marker.
      const candidates = correlated;
      for (const run of candidates) {
        const id = run.run_id || run.runId;
        if (!id) continue;
        const detail = await probe("AVRONE CodeX replay", AVRONE + "/api/runs/" + encodeURIComponent(id));
        if (!detail.ok || !Array.isArray(detail.body)) continue;
        const found = [...detail.body].reverse().find(e => e.kind === "grokbot.bridge" &&
          e.data?.ok === true);
        if (found) {
          receipt = { ...found, runId: id };
          snapshot.avroneReverseTrace = {
            runId: id,
            eventCount: detail.body.length,
            events: detail.body.filter(e => ["tool.call", "tool.result", "agent.spawn", "agent.done", "grokbot.bridge", "error", "run.done"].includes(e.kind))
              .slice(-60).map(e => ({
                kind: e.kind, agent: e.agent || null, tool: e.data?.tool || null,
                ok: typeof e.data?.ok === "boolean" ? e.data.ok : null,
                excerpt: e.kind === "agent.done" ? redact(e.data?.result || "", 800) :
                  e.kind === "tool.result" ? redact(e.data?.output || e.data?.result || "", 1000) : null
              }))
          };
          break;
        }
      }
    }
    snapshot.bridgeReceipts = receipt ? [{ runId: receipt.runId || null, kind: receipt.kind, ok: true,
      agent: receipt.data?.agent || receipt.agent || "grok-researcher",
      answerChars: receipt.data?.answer_chars || receipt.answer_chars || null }] : [];
    snapshot.avroneToGrok = { configured: true, ok: !!receipt, answer: reverseAnswer, receipt: snapshot.bridgeReceipts[0] || null };
    if (!reverse.ok) failures.push("AVRONE → Grok Bot chat request failed.");
    if (reverse.ok && !receipt) failures.push("AVRONE → Grok Bot had no successful grokbot.bridge CodeX receipt.");
    if (reverse.ok && !/AVRONE_TO_GROKBOT_BRIDGE_OK/.test(reverseAnswer)) {
      failures.push("AVRONE → Grok Bot did not echo the requested marker; the tool trace needs review.");
    }
  }

  if (snapshot.grokBot?.summary?.ready) snapshot.conclusions.push("Grok Bot reported ready=true with " +
    snapshot.grokBot.summary.selftest.filter(t => t.ok).length + "/" + snapshot.grokBot.summary.selftest.length + " boot self-tests passing.");
  if (snapshot.governor?.body) snapshot.conclusions.push("Governor measured " + snapshot.governor.body.state +
    " and selected " + snapshot.governor.body.target + "/" + snapshot.governor.body.max + " parallel lanes.");
  if (snapshot.containers?.summary) snapshot.conclusions.push("Container inventory returned " +
    snapshot.containers.summary.count + " records using names/images/IDs/states only.");
  if (snapshot.avrone?.ok) snapshot.conclusions.push("AVRONE responded on the configured path: runner=" +
    snapshot.avrone.summary.runner + ", provider=" + snapshot.avrone.summary.provider + ", model=" + snapshot.avrone.summary.model + ".");
  if (snapshot.grokSquad) snapshot.conclusions.push("Grok Bot trace recorded " + snapshot.grokSquad.spawned +
    " workers, " + snapshot.grokSquad.successfulFindings + " successful findings, and " +
    snapshot.grokSquad.overlappingPairs + " overlapping worker interval pairs.");
  if (snapshot.grokToAvrone?.ok) snapshot.conclusions.push("Grok Bot → AVRONE returned a real avrone.squad answer with " +
    (snapshot.avroneSquadTrace?.eventCount ?? 0) + " replayable AVRONE events and " +
    (snapshot.avroneSquadTrace?.bridge?.count ?? 0) + " inter-agent bridge posts.");
  if (snapshot.avroneToGrok?.ok) snapshot.conclusions.push("AVRONE → Grok Bot produced a successful grokbot.bridge CodeX receipt in run " +
    (snapshot.avroneReverseTrace?.runId || "unknown") + ".");
  if (failures.length) snapshot.conclusions.push("Verification remains partial: " + failures.length + " gap(s) require attention; no green status is claimed.");
  else snapshot.conclusions.push("Both bridge directions and dual-parallel S-mode produced runtime evidence; proposed evolution can be based on this observation.");

  await saveReport();
  if (failures.length) { console.error("SQUAD OBSERVATION INCOMPLETE: " + failures.length + " gap(s)."); process.exitCode = 1; }
  else console.log("SQUAD OBSERVATION PASS: two parallel workers and both bridge directions verified.");
}

main().catch(async error => {
  failures.push("fatal observer error: " + redact(error?.stack || error?.message || error, 1200));
  snapshot.conclusions.push("Observer terminated before all evidence could be collected.");
  await saveReport();
  console.error(failures.at(-1));
  process.exitCode = 1;
});
