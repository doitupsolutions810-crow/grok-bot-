import { mkdirSync, writeFileSync } from "node:fs";
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
  grokBot: null, governor: null, containers: null, avrone: null, grokSquad: null,
  grokToAvrone: null, avroneToGrok: null, bridgeReceipts: [], conclusions: [] };

function redact(value, cap = 3000) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|password|secret|authorization|cookie|private[_ -]?key)(\s*[:=]\s*)(["']?)[^\s"',;]+/gi, "$1$2[REDACTED]")
    .slice(0, cap);
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
      "Task: " + redact(f.task || "not recorded", 600), "",
      f.ok ? redact(f.answer || "(no answer text)", 2400) : "Error: " + redact(f.error || "unknown", 500), ""]),
    "### S-mode lead conclusion", "", redact(snapshot.grokSquad?.answer || "No lead answer returned.", 3000),
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
  } else snapshot.avrone = { configured: false, ok: false, error: "AVRONE_URL is not configured." };

  const prompt = [
    "Read-only dual-parallel runtime observation. Correlation marker: " + marker + ".",
    "Use exactly two independent parallel workers, then a lead synthesis.",
    "Worker 1: inspect the Node/server runtime and sandbox environment with real, read-only tool calls. Where supported, gather uname -a, hostname, UTC time, node --version, python3 --version, uptime, df -h /workspace, /etc/os-release, process 1, and working directory. Include exact commands and concise outputs.",
    "Worker 2: inspect service/bridge wiring and health with real tools. Check readiness, agent/tool availability, governor state, and whether AVRONE is reachable at the configured endpoint. Use read-only GET/status probes only.",
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
    const findings = events.filter(e => e.kind === "worker.finding").map(e => ({
      agent: e.agent || "unknown", ok: e.ok === true, task: redact(e.task || "", 600),
      answer: redact(e.answer || "", 2400), error: redact(e.error || "", 500), answerChars: e.answer_chars || 0
    }));
    const overlappingPairs = countOverlappingPairs(intervalsFor(events));
    snapshot.grokSquad = { ok: true, httpStatus: squad.httpStatus, runId: run?.runId || null,
      spawned: spawned.length, successfulFindings: findings.filter(f => f.ok).length, overlappingPairs,
      notes: Array.isArray(squad.body?.notes) ? squad.body.notes.map(n => redact(n, 300)) : [],
      findings, answer: redact(squad.body?.answer || "", 3000) };
    if (!run) failures.push("Completed S-mode run could not be matched to CodeX evidence.");
    if (spawned.length !== EXPECTED_WORKERS) failures.push("S-mode spawned " + spawned.length + " workers; expected " + EXPECTED_WORKERS + ".");
    if (findings.filter(f => f.ok).length !== EXPECTED_WORKERS) failures.push("Successful worker findings: " +
      findings.filter(f => f.ok).length + "; expected " + EXPECTED_WORKERS + ".");
    if (overlappingPairs < 1) failures.push("No overlapping worker intervals were evidenced; parallel execution is unverified.");
  }

  if (AVRONE && snapshot.avrone?.ok) {
    const bridgePrompt = [
      "Read-only cross-system S-mode conclusion. Marker: " + marker + ".",
      "Use your real AVRONE squad to inspect your runner/provider/model/tool inventory and independently assess the Grok Bot telemetry below.",
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
      ? { configured: true, ok: !!forward.body?.ok && typeof forward.body?.answer === "string" && !!forward.body.answer.trim(),
          runId: forward.body?.runId || null, answer: redact(forward.body?.answer || JSON.stringify(forward.body), 2400) }
      : { configured: true, ok: false, error: forward.error };
    if (!snapshot.grokToAvrone.ok) failures.push("Grok Bot → AVRONE did not return a nonempty successful squad answer.");

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
    const receipts = await probe("AVRONE bridge receipts", AVRONE + "/api/runs");
    const events = receipts.ok && Array.isArray(receipts.body) ?
      receipts.body.flatMap(r => (r.events || []).map(e => ({ runId: r.runId, ...e }))) : [];
    const receipt = [...events].reverse().find(e => e.kind === "grokbot.bridge" &&
      (e.data?.ok === true || e.ok === true));
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
  if (snapshot.grokToAvrone?.ok) snapshot.conclusions.push("Grok Bot → AVRONE returned a real avrone.squad answer.");
  if (snapshot.avroneToGrok?.ok) snapshot.conclusions.push("AVRONE → Grok Bot produced a successful grokbot.bridge CodeX receipt.");
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
