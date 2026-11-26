// Live integration harness — runs INSIDE the grok-bot container against the
// real stack (Ollama inference, docker exec, browser, SQLite). No mocks.
// CI runs this after boot: docker compose exec grok-bot node tests/live.test.js

const BASE = process.env.GROKBOT_URL || "http://localhost:3000";
const j = (r) => r.json();
// POST over node:http with no client timeout. Global fetch (undici) gives up after 300 s
// without response headers, and a CPU-only squad run takes longer than that: live run
// 45775974761 failed "squad mode" with a bare "fetch failed" at exactly five minutes.
import http from "node:http";
const post = (path, body) => new Promise((resolve, reject) => {
  const data = JSON.stringify(body || {});
  const req = http.request(`${BASE}/api${path}`, { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, res => {
    let buf = ""; res.setEncoding("utf8");
    res.on("data", c => { buf += c; });
    res.on("end", () => resolve({ status: res.statusCode, ok: res.statusCode < 400, json: async () => JSON.parse(buf), text: async () => buf }));
  });
  req.setTimeout(0);
  req.on("error", reject);
  req.end(data);
});

async function test(name, fn) {
  try { const detail = await fn(); console.log(`PASS ${name} — ${detail}`); return true; }
  catch (e) { console.error(`FAIL ${name} — ${e.message}`); return false; }
}

const r = await fetch(`${BASE}/api/status`).then(j);
if (!r.ready) throw new Error("boot self-test did not pass");
if (!Array.isArray(r.selftest) || r.selftest.length === 0) {
  throw new Error("boot status did not include a non-empty self-test result list");
}
const failedSelfTests = r.selftest.filter(t => !t.ok);
if (failedSelfTests.length) {
  throw new Error("boot self-test reported failures: " + failedSelfTests.map(t => t.name + ": " + t.error).join("; "));
}

const results = [
  await test("boot self-test green", () =>
    `${r.selftest.length}/${r.selftest.length} subsystems live`),

  await test("LLM live tool-call: terminal", async () => {
    const res = await post("/chat", {
      agentId: "grok-main", message: "Run `uname -a` in the sandbox and tell me the kernel version."
    }).then(j);
    if (!/linux/i.test(res.answer)) throw new Error(res.answer);
    return "agent really executed the command";
  }),

  await test("teammate CRUD round-trip", async () => {
    const name = `qa-${Date.now().toString(36)}`;
    const created = await post("/agents", {
      name, job: "run the live test suite and report flakiness",
      tools: ["terminal"], model: r.models?.[0] || process.env.LLM_MODEL || "llama3.1:8b",
      mode: "chat", review: false, emoji: "🧪"
    }).then(j);
    if (!created.ok) throw new Error(JSON.stringify(created));
    const patched = await fetch(`${BASE}/api/agents/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ job: "verify live tests and mark flaky ones" })
    }).then(j);
    if (!patched.ok) throw new Error(JSON.stringify(patched));
    const instr = await fetch(`${BASE}/api/agents/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ instructions: "Always end with the word VERIFIED." })
    }).then(j);
    if (!instr.ok) throw new Error(JSON.stringify(instr));
    const got = await fetch(`${BASE}/api/agents/${created.id}`).then(j);
    if (!/VERIFIED/.test(got.effectivePrompt || "")) throw new Error("custom instructions missing from effective prompt");
    const deleted = await fetch(`${BASE}/api/agents/${created.id}`, { method: "DELETE" }).then(j);
    if (!deleted.ok) throw new Error(JSON.stringify(deleted));
    return `created → patched → deleted ${created.id}`;
  }),

  await test("squad mode: real parallel workers", async () => {
    const res = await post("/chat", {
      mode: "squad",
      message: "From the sandbox: run `uname -s`, check what `df -h /workspace` says, and report the current time — merge all three into one answer."
    }).then(j);
    if (!res.answer || res.answer.length < 30) throw new Error(JSON.stringify(res).slice(0, 300));
    if (!Array.isArray(res.notes)) throw new Error("no orchestration notes returned");
    return `${res.notes.length} notes, answer merged (${res.answer.length} chars)`;
  }),

  await test("CodeX replay: run lifecycle logged", async () => {
    // The newest run can still be in flight (an earlier test may have given up on it), so
    // look for a finished run among the recent ones instead of assuming runs[0] is done.
    const runs = await fetch(`${BASE}/api/runs`).then(j);
    if (!runs.length) throw new Error("no runs recorded");
    let seen = [];
    for (const r0 of runs.slice(0, 10)) {
      const run = await fetch(`${BASE}/api/runs/${r0.runId}`).then(j);
      const kinds = run.events.map(e => e.kind);
      seen.push(`${r0.runId}: ${[...new Set(kinds)].join(",")}`);
      if (kinds.includes("run.start") && kinds.includes("run.done")) return `${r0.runId}: ${run.events.length} events, full lifecycle`;
    }
    throw new Error(`no finished run; ${seen.join(" | ").slice(0, 400)}`);
  }),

  await test("governor: health-gated parallelism", async () => {
    const g = await fetch(`${BASE}/api/governor`).then(j);
    if (!["healthy", "throttled", "critical"].includes(g.state)) throw new Error(`state: ${g.state}`);
    if (!(g.target >= 1 && g.target <= g.max)) throw new Error(`target ${g.target} out of [1, ${g.max}]`);
    return `state ${g.state}, target ${g.target}/${g.max} lanes`;
  }),

  await test("ledger: hash chain intact", async () => {
    const l = await fetch(`${BASE}/api/ledger`).then(j);
    if (!l.intact) throw new Error("tamper detected — chain broken");
    return `${l.entries.length} entries, chain intact`;
  }),

  await test("feedback recorded and replayable", async () => {
    const comment = `live-test feedback ${Date.now()}`;
    const fb = await post("/feedback", { comment, good: true }).then(j);
    if (!fb.ok) throw new Error(JSON.stringify(fb));
    const recent = await fetch(`${BASE}/api/feedback`).then(j);
    if (!recent.some(f => f.comment === comment)) throw new Error("feedback not listed");
    return `stored id ${fb.id} and listed`;
  })
];

const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} live tests passed`);
process.exit(passed === results.length ? 0 : 1);
