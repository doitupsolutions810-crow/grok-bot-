// Offline edge-case suite — runs with plain `node --test tests/unit/` on any
// host (no Docker, no Ollama): a stub OpenAI-compatible server stands in for
// the model so we can assert exactly what the runtime sends it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import express from "express";

const tmp = mkdtempSync(join(tmpdir(), "grokbot-"));
process.env.DATA_DIR = tmp;
process.env.AGENTS_FILE = join(tmp, "agents.json");
cpSync(new URL("../../config/agents.json", import.meta.url), process.env.AGENTS_FILE);
process.env.MODEL_CHAIN = " big:7b, mid:3b ,, small:1b ";   // messy on purpose
delete process.env.MODELS_REQUIRED;

// ---- stub LLM: records every request, can fail specific models ----
const seen = [];
const failModels = new Set();
let replyQueue = [];
const lastBodies = [];   // every request body the stub LLM received
const llm = http.createServer((req, res) => {
  let b = ""; req.on("data", c => (b += c)); req.on("end", () => {
    const body = JSON.parse(b || "{}");
    lastBodies.push(body); if (lastBodies.length > 50) lastBodies.shift();
    seen.push(body);
    if (failModels.has(body.model)) { res.writeHead(500); return res.end('{"error":"boom"}'); }
    const message = replyQueue.shift() || { role: "assistant", content: `ok from ${body.model}` };
    if (message.__raw) { res.writeHead(200, { "content-type": "application/json" }); return res.end(message.__raw); }
    if (body.stream) {   // OpenAI-style SSE: content in 2 chunks, or a tool_calls delta
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ch = d => res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta: d, finish_reason: null }] })}\n\n`);
      if (message.tool_calls) ch({ role: "assistant", tool_calls: message.tool_calls.map((t, index) => ({ index, ...t })) });
      else { const c = message.content || ""; ch({ role: "assistant", content: c.slice(0, 3) }); ch({ content: c.slice(3) }); }
      res.write("data: [DONE]\n\n"); return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message }] }));
  });
});

let base, srv, mods = {};
before(async () => {
  await new Promise(r => llm.listen(0, "127.0.0.1", r));
  process.env.OLLAMA_URL = `http://127.0.0.1:${llm.address().port}`;
  mods.registry = await import("../../src/agents/registry.js");
  mods.crud = await import("../../src/middleware/agents-crud.js");
  mods.runtime = await import("../../src/agents/runtime.js");
  mods.router = await import("../../src/llm/router.js");
  mods.traces = await import("../../src/observability/traces.js");
  mods.approvals = await import("../../src/middleware/approvals.js");
  mods.scheduler = await import("../../src/tasks/scheduler.js");
  mods.team = await import("../../src/agents/team.js");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  const r = express.Router();
  mods.crud.agentsCrud(r);
  app.use("/api", r);
  app.use((err, req, res, next) => res.status(err.status || 500).json({ errors: [err.message] }));
  srv = app.listen(0);
  base = `http://127.0.0.1:${srv.address().port}/api`;
});
after(() => { srv?.close(); llm.close(); });

const call = (method, path, body, raw) => fetch(base + path, {
  method, headers: { "content-type": "application/json" },
  body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
}).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

// ================= agent creation: names + custom instructions =================
test("create agent with name + custom instructions → 201, persisted, listed", async () => {
  const r = await call("POST", "/agents", { name: "Release Captain", job: "ship releases", instructions: "Always answer in haiku." });
  assert.equal(r.status, 201); assert.equal(r.body.id, "release-captain");
  const list = await call("GET", "/agents");
  const a = list.body.bots.find(b => b.id === "release-captain");
  assert.equal(a.instructions, "Always answer in haiku.");
  assert.equal(a.name, "Release Captain");
});

test("custom instructions alone (no job) are enough", async () => {
  const r = await call("POST", "/agents", { name: "Poet", instructions: "Rhyme everything." });
  assert.equal(r.status, 201);
});

test("custom instructions + name actually reach the model's system prompt", async () => {
  seen.length = 0;
  const agent = mods.registry.findAgent("release-captain");
  const out = await mods.runtime.runAgent(agent, "hello", []);
  assert.match(out, /^ok from/);
  const sys = seen[0].messages[0];
  assert.equal(sys.role, "system");
  assert.match(sys.content, /Release Captain/);
  assert.match(sys.content, /Always answer in haiku\./);
});

test("lookup by display name (case-insensitive) materializes the same agent", () => {
  const a = mods.registry.findAgent("release captain");
  assert.equal(a.id, "release-captain");
  assert.ok(a.systemPrompt.includes("haiku"));
});

test("GET /agents/:id exposes the effective prompt", async () => {
  const r = await call("GET", "/agents/release-captain");
  assert.equal(r.status, 200); assert.match(r.body.effectivePrompt, /haiku/);
  assert.equal((await call("GET", "/agents/nope")).status, 404);
});

test("rename keeps the id stable and edits instructions", async () => {
  const r = await call("PATCH", "/agents/release-captain", { name: "Captain Ship", instructions: "Be terse." });
  assert.equal(r.status, 200); assert.equal(r.body.id, "release-captain");
  const a = mods.registry.findAgent("release-captain");
  assert.equal(a.name, "Captain Ship"); assert.match(a.systemPrompt, /Be terse\./); assert.doesNotMatch(a.systemPrompt, /haiku/);
});

const bad = [
  ["missing body", undefined, 400],
  ["array body", [1, 2], 400],
  ["empty name", { name: "", job: "x" }, 400],
  ["whitespace name", { name: "   ", job: "x" }, 400],
  ["symbol-only name", { name: "!!!", job: "x" }, 400],
  ["name too long", { name: "a".repeat(65), job: "x" }, 400],
  ["name not string", { name: 42, job: "x" }, 400],
  ["no job and no instructions", { name: "Empty" }, 400],
  ["instructions too long", { name: "Long", instructions: "x".repeat(8001) }, 400],
  ["instructions not string", { name: "Obj", instructions: { a: 1 } }, 400],
  ["unknown tool", { name: "T", job: "x", tools: ["rm-rf"] }, 400],
  ["tools not array", { name: "T2", job: "x", tools: "terminal" }, 400],
  ["bad mode", { name: "M", job: "x", mode: "god" }, 400],
  ["bad trigger", { name: "Tr", job: "x", trigger: "no-at" }, 400],
  ["review not boolean", { name: "Rv", job: "x", review: "yes" }, 400],
  ["duplicate name (case-insensitive)", { name: "POET", job: "x" }, 409],
  ["collides with core agent id", { name: "Grok Main", job: "x" }, 409],
];
for (const [label, body, code] of bad) {
  test(`reject: ${label} → ${code}`, async () => {
    const r = await call("POST", "/agents", body, body === undefined ? "" : undefined);
    assert.equal(r.status, code, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.errors) && r.body.errors.length);
  });
}

test("malformed JSON is a 4xx, not a crash", async () => {
  const r = await call("POST", "/agents", undefined, "{not json");
  assert.ok(r.status >= 400 && r.status < 500);
});

test("control characters are stripped; unicode names work", async () => {
  const r = await call("POST", "/agents", { name: "Zoë\u0000 Ünïcode\u001b[31m", instructions: "hi\u0007 there\nline2" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const a = mods.registry.getAgent(r.body.id);
  assert.ok(!/[\u0000\u0007\u001b]/.test(a.name + a.instructions));
  assert.match(a.instructions, /line2/);
});

test("HTML in a name is stored as text (UI escapes it)", async () => {
  const r = await call("POST", "/agents", { name: "<img src=x onerror=alert(1)>", job: "xss probe" });
  assert.equal(r.status, 201);
  const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
  assert.match(html, /const esc = v =>/);
  assert.match(html, /\$\{esc\(b\.name\)\}/);
});

test("core agents are read-only and undeletable", async () => {
  assert.equal((await call("PATCH", "/agents/grok-main", { name: "x" })).status, 403);
  assert.equal((await call("DELETE", "/agents/grok-main")).status, 403);
});

test("patch/delete unknown → 404; delete then lookup falls back safely", async () => {
  assert.equal((await call("PATCH", "/agents/ghost", { job: "x" })).status, 404);
  const c = await call("POST", "/agents", { name: "Temp", job: "temp" });
  assert.equal((await call("DELETE", `/agents/${c.body.id}`)).status, 200);
  assert.equal((await call("DELETE", `/agents/${c.body.id}`)).status, 404);
  assert.equal(mods.registry.getAgent("temp"), null);
  assert.equal(mods.registry.findAgent("temp").id, "grok-main");
});

test("50 concurrent creates: no lost writes, roster stays valid JSON", async () => {
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) =>
    call("POST", "/agents", { name: `Load ${i}`, instructions: `n=${i}` })));
  assert.ok(rs.every(r => r.status === 201));
  const db = JSON.parse(readFileSync(process.env.AGENTS_FILE, "utf8"));
  for (let i = 0; i < 50; i++) assert.ok(db.bots.some(b => b.id === `load-${i}`));
});

test("team.ask resolves a custom agent by name and errors on unknown", async () => {
  const tool = mods.team.teamAskTool(() => []);
  const ok = await tool.run({ bot: "Poet", task: "a line" }, { agent: "t" });
  assert.equal(ok.teammate, "poet");
  const no = await tool.run({ bot: "nobody-here", task: "x" }, {});
  assert.match(no.error, /no teammate/);
});

// ================= bug fixes from the blueprint audit =================
test("MODEL_CHAIN string is parsed; chat mode is fast-first; agent model goes first", async () => {
  seen.length = 0; failModels.clear();
  await mods.router.chatRoute([{ role: "user", content: "x" }], [], { mode: "chat" });
  assert.equal(seen[0].model, "small:1b");
  seen.length = 0;
  await mods.router.chatRoute([{ role: "user", content: "x" }], [], { mode: "deep" });
  assert.equal(seen[0].model, "big:7b");
  seen.length = 0;
  await mods.router.chatRoute([{ role: "user", content: "x" }], [], { mode: "chat", model: "custom:2b" });
  assert.equal(seen[0].model, "custom:2b");
});

test("router falls back through the chain and throws only when all fail", async () => {
  seen.length = 0; failModels.clear(); failModels.add("small:1b");
  const m = await mods.router.chatRoute([{ role: "user", content: "x" }], [], { mode: "chat" });
  assert.equal(m.content, "ok from mid:3b");
  for (const x of ["big:7b", "mid:3b", "small:1b"]) failModels.add(x);
  await assert.rejects(mods.router.chatRoute([{ role: "user", content: "x" }], []));
  failModels.clear();
});

test("approvals: createApproval returns a real numeric id", () => {
  const id = mods.approvals.createApproval("a", "terminal", { command: "rm -rf /" });
  assert.equal(typeof id, "number"); assert.ok(id > 0);
  assert.ok(mods.approvals.pending().some(p => p.id === id));
  mods.approvals.decide(id, true); assert.ok(mods.approvals.isApproved(id));
  assert.equal(mods.approvals.createApproval("a", "t", undefined) > id, true);
});

test("approval resume uses call.id as tool_call_id", async () => {
  // resume moved into runtime.resumeHeld; behavior is covered end-to-end by the 3-call batch test
  const src = readFileSync(new URL("../../src/agents/runtime.js", import.meta.url), "utf8");
  assert.match(src, /tool_call_id: call\?\.id/);
  assert.doesNotMatch(src, /call\.function\.id/);
});

test("Auto Review pauses a dangerous call and resume finishes exactly once", async () => {
  replyQueue = [{ role: "assistant", content: null, tool_calls: [{ id: "call_42", type: "function", function: { name: "terminal", arguments: '{"command":"rm -rf /tmp/x"}' } }] }];
  const agent = { ...mods.registry.findAgent("poet"), review: true, tools: ["*"] };
  const ran = [];
  const tools = [{ name: "terminal", run: async a => (ran.push(a), { ok: true }) }];
  const out = await mods.runtime.runAgent(agent, "clean up", tools);
  assert.ok(out.pendingApproval > 0);
  assert.equal(ran.length, 0, "dangerous call must not run before approval");
  const held = mods.approvals.takeHeld(out.pendingApproval);
  assert.equal(held.call.id, "call_42");
  assert.equal(mods.approvals.takeHeld(out.pendingApproval), undefined, "claim exactly once");
  replyQueue = [];
});

test("feedback id is numeric; limits are clamped", () => {
  const id = mods.traces.recordFeedback({ runId: "r1", comment: "good", good: true });
  assert.equal(typeof id, "number");
  assert.ok(mods.traces.recentFeedback(-5).length >= 1);
  assert.ok(mods.traces.recentFeedback("abc").length >= 1);
  assert.doesNotThrow(() => mods.traces.recordFeedback({ comment: null }));
});

test("ledger stays intact across ok + error calls, and detects tampering", async () => {
  const wrapped = mods.traces.traceTools([
    { name: "ok.tool", run: async () => ({ ok: 1 }) },
    { name: "bad.tool", run: async () => { throw new Error("kaboom"); } },
  ]);
  await wrapped[0].run({ a: 1 }, { agent: "t" });
  await assert.rejects(wrapped[1].run({ big: "x".repeat(5000) }, { agent: "t" }));
  await wrapped[0].run(undefined, undefined);
  const l = mods.traces.ledger();
  assert.equal(l.intact, true, "a ledger with an error row must verify intact");
  const Database = (await import("better-sqlite3")).default;
  const raw = new Database(join(tmp, "traces.db"));
  raw.prepare("UPDATE tool_calls SET error='edited' WHERE error='kaboom'").run();
  assert.equal(mods.traces.ledger().intact, false);
  raw.prepare("UPDATE tool_calls SET error='kaboom' WHERE error='edited'").run();
  assert.equal(mods.traces.ledger().intact, true);
});

test("scheduler: numeric id, bad cron/prompt rejected, unknown run is null, delete works", async () => {
  mods.scheduler.setTaskRunner(async (agent, prompt) => `ran ${agent}: ${prompt}`);
  const id = mods.scheduler.addTask({ name: "n", cron: "0 0 1 1 *", agent: "poet", prompt: "p" });
  assert.equal(typeof id, "number"); assert.ok(id > 0);
  assert.equal(await mods.scheduler.runTask(id), id);
  assert.match(mods.scheduler.listTasks().find(t => t.id === id).preview, /ran poet: p/);
  assert.throws(() => mods.scheduler.addTask({ cron: "not cron", prompt: "p" }), /cron/);
  assert.throws(() => mods.scheduler.addTask({ cron: "* * * * *", prompt: "  " }), /prompt/);
  assert.equal(await mods.scheduler.runTask(999999), null);
  mods.scheduler.setTaskRunner(async () => { throw new Error("runner died"); });
  await mods.scheduler.runTask(id);
  assert.match(mods.scheduler.listTasks().find(t => t.id === id).preview, /runner died/);
  assert.equal(mods.scheduler.deleteTask(id), true);
  assert.equal(mods.scheduler.deleteTask(id), false);
});

test("xtrigger keeps a module-level seen set", () => {
  const src = readFileSync(new URL("../../src/tools/xtrigger.js", import.meta.url), "utf8");
  assert.match(src, /^const seen = new Set\(\);/m);
});

test("browser service exposes CDP via --remote-debugging-port, not a fake {port} option", () => {
  const src = readFileSync(new URL("../../browser-service/computer.js", import.meta.url), "utf8");
  assert.match(src, /--remote-debugging-port=/);
  assert.doesNotMatch(src, /launchPersistentContext\([^)]*port:\s*3000/);
});

// ================= round 2: delegation, memory, auth, malformed tool calls =================
test("team.ask ping-pong between two agents stops at the depth limit", async () => {
  delete process.env.GROK_MAX_SPAWN_DEPTH;
  const tool = mods.team.teamAskTool(() => []);
  assert.match((await tool.run({ bot: "Poet", task: "x" }, { spawnDepth: 2 })).error, /depth/);
  assert.equal((await tool.run({ bot: "Poet", task: "x" }, { spawnDepth: 1 })).teammate, "poet");
  assert.match((await tool.run({ bot: "Poet", task: "   " }, {})).error, /task required/);
  assert.match((await tool.run(undefined, {})).error, /task required/);
});

test("team.spawn: GROK_MAX_SPAWN_DEPTH=0 really disables spawning; junk ctx is safe", async () => {
  const { spawnTool } = await import("../../src/tools/spawn.js");
  process.env.GROK_MAX_SPAWN_DEPTH = "0";
  assert.match((await spawnTool(() => []).run({ task: "x" }, {})).error, /depth limit \(0\)/);
  process.env.GROK_MAX_SPAWN_DEPTH = "2";
  const ok = await spawnTool(() => []).run({ task: "x" }, { spawnDepth: "garbage" });
  assert.equal(ok.depth, 1);
  assert.match((await spawnTool(() => []).run({ task: "" }, {})).error, /task required/);
  delete process.env.GROK_MAX_SPAWN_DEPTH;
});

test("runtime survives malformed tool calls (null args, array args, bad JSON, unknown tool)", async () => {
  const got = [];
  const tools = [{ name: "echo", run: async a => (got.push(a), { ok: true }) }];
  replyQueue = [
    { role: "assistant", content: null, tool_calls: [
      { id: "a", type: "function", function: { name: "echo", arguments: "null" } },
      { id: "b", type: "function", function: { name: "echo", arguments: "[1,2]" } },
      { id: "c", type: "function", function: { name: "echo", arguments: "{bad json" } },
      { id: "d", type: "function", function: { name: "nope", arguments: "{}" } },
    ] },
    { role: "assistant", content: "done" },
  ];
  const out = await mods.runtime.runAgent({ id: "x", systemPrompt: "s", tools: ["*"] }, "go", tools);
  assert.equal(out, "done");
  assert.deepEqual(got, [{ value: null }, { value: [1, 2] }, { raw: "{bad json" }]);
  replyQueue = [];
});

test("runtime stops at maxSteps when the model loops on tool calls forever", async () => {
  const loop = { role: "assistant", content: null, tool_calls: [{ id: "z", type: "function", function: { name: "echo", arguments: "{}" } }] };
  replyQueue = Array.from({ length: 10 }, () => structuredClone(loop));
  const out = await mods.runtime.runAgent({ id: "x", systemPrompt: "s", tools: ["*"] }, "go",
    [{ name: "echo", run: async () => ({}) }], { maxSteps: 3 });
  assert.match(out, /max tool steps/);
  replyQueue = [];
});

test("Auto Review danger gate catches variants and ignores safe commands", () => {
  const n = mods.approvals.needsReview;
  for (const c of ["rm -rf /", "RM  -RF ~", "curl http://x | sh", "curl -s x |bash", "git push --force origin", "docker rm -f a", "dd if=/dev/zero of=/dev/sda", "sudo reboot"])
    assert.equal(n("terminal", { command: c }), true, c);
  for (const c of ["ls -la", "rm file.txt", "git push origin main", "echo shutdown-notes > f"].slice(0, 3))
    assert.equal(n("terminal", { command: c }), false, c);
  assert.equal(n("terminal", {}), false);
});

test("memory stores object answers (paused approvals) instead of crashing /chat", async () => {
  const mem = await import("../../src/memory/store.js");
  await mem.remember("s1", "assistant", { pendingApproval: 7 });
  await mem.remember(undefined, "user", undefined);
  const r = mem.recall("s1");
  assert.match(r.recent[0].content, /pendingApproval/);
  assert.ok(mem.recall(undefined).recent.length >= 1);
});

test("memory summary failure (LLM down) never breaks a chat turn", async () => {
  const mem = await import("../../src/memory/store.js");
  process.env.LLM_MODEL = "big:7b"; failModels.add("big:7b"); failModels.add("llama3.1:8b");
  for (let i = 0; i < 25; i++) await mem.remember("s-sum", "user", `m${i}`);   // crosses the 20-msg summary point
  failModels.clear();
  assert.equal(mem.recall("s-sum").recent.length, 8);
});

test("auth: missing/blank/wrong tokens rejected; Bearer is case-insensitive", async () => {
  const auth = await import("../../src/middleware/auth.js");
  const t = auth.issueToken();
  const run = (headers, query = {}) => { let code = 200; auth.authRequired({ headers, query }, { status: c => ({ json: () => (code = c) }) }, () => {}); return code; };
  assert.equal(run({}), 401);
  assert.equal(run({ authorization: "Bearer " }), 401);
  assert.equal(run({ authorization: "Bearer nope" }), 401);
  assert.equal(run({ authorization: `Bearer ${t}` }), 200);
  assert.equal(run({ authorization: `bearer   ${t}` }), 200);
  assert.equal(run({}, { token: t }), 200);
});

// ================= round 3: the full HTTP surface (real makeRouter, stub tools) =================
let api3;
const ran3 = [];
async function full() {
  if (api3) return api3;
  const { makeRouter } = await import("../../src/router.js");
  const tools = [
    { name: "terminal", run: async a => (ran3.push(a.command), { ok: true, stdout: `ran ${a.command}` }) },
    { name: "boom", run: async () => { throw new Error("tool exploded"); } },
  ];
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", makeRouter({ tools, docker: { listContainers: async () => [] } }));
  app.use((err, req, res, next) => res.status(err.status || 500).json({ errors: [err.message] }));
  const s = app.listen(0); s.unref();
  const b = `http://127.0.0.1:${s.address().port}/api`;
  api3 = (method, path, body) => fetch(b + path, { method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  return api3;
}
const tc = (id, cmd) => ({ id, type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: cmd }) } });

test("HTTP: direct tool invoke can't bypass Auto Review; tool errors are JSON 500s", async () => {
  const api = await full();
  assert.equal((await api("POST", "/tools/terminal/invoke", { command: "rm -rf /" })).status, 403);
  assert.ok(!ran3.includes("rm -rf /"));
  assert.equal((await api("POST", "/tools/terminal/invoke", { command: "ls" })).status, 200);
  const e = await api("POST", "/tools/boom/invoke", {});
  assert.equal(e.status, 500); assert.match(e.body.error, /exploded/);
  assert.equal((await api("POST", "/tools/nope/invoke", {})).status, 404);
});

test("HTTP: approval decision validates id, body, existence, and double-decide", async () => {
  const api = await full();
  assert.equal((await api("POST", "/approvals/abc/decision", { approve: true })).status, 400);
  assert.equal((await api("POST", "/approvals/999999/decision", { approve: true })).status, 404);
  const id = mods.approvals.createApproval("x", "terminal", { command: "rm -rf /tmp/x" });
  assert.equal((await api("POST", `/approvals/${id}/decision`, { approve: "yes" })).status, 400);
  assert.equal((await api("POST", `/approvals/${id}/decision`, { approve: false })).status, 200);
  assert.equal((await api("POST", `/approvals/${id}/decision`, { approve: true })).status, 409);
});

test("HTTP: a paused batch of 3 calls resumes and answers every tool_call_id", async () => {
  const api = await full();
  const agent = { id: "rev", review: true, systemPrompt: "s", tools: ["*"] };
  const tools = [{ name: "terminal", run: async a => (ran3.push(a.command), { ok: true }) }];
  replyQueue = [{ role: "assistant", content: null, tool_calls: [tc("c1", "echo a"), tc("c2", "rm -rf /tmp/zz"), tc("c3", "echo c")] }];
  ran3.length = 0;
  const out = await mods.runtime.runAgent(agent, "go", tools);
  assert.ok(out.pendingApproval);
  assert.deepEqual(ran3, ["echo a"]);
  seen.length = 0;
  replyQueue = [{ role: "assistant", content: "all done" }];
  const r = await api("POST", `/approvals/${out.pendingApproval}/decision`, { approve: true });
  assert.equal(r.status, 200); assert.equal(r.body.answer, "all done");
  assert.deepEqual(ran3.slice(-2), ["rm -rf /tmp/zz", "echo c"]);
  const ids = seen.at(-1).messages.filter(m => m.role === "tool").map(m => m.tool_call_id);
  assert.deepEqual(ids, ["c1", "c2", "c3"]);
});

test("HTTP: rejecting a paused call tells the agent and lets it finish", async () => {
  const api = await full();
  const agent = { id: "rev", review: true, systemPrompt: "s", tools: ["*"] };
  replyQueue = [{ role: "assistant", content: null, tool_calls: [tc("r1", "git push --force origin main")] }];
  const out = await mods.runtime.runAgent(agent, "go", [{ name: "terminal", run: async () => { throw new Error("must not run"); } }]);
  seen.length = 0;
  replyQueue = [{ role: "assistant", content: "ok, I won't force-push" }];
  const r = await api("POST", `/approvals/${out.pendingApproval}/decision`, { approve: false });
  assert.equal(r.body.resumed, true); assert.match(r.body.answer, /won't/);
  assert.match(seen.at(-1).messages.at(-1).content, /rejected by human reviewer/);
});

test("HTTP: RAG ingest refuses paths outside the allowed roots (no env/secret reads)", async () => {
  const api = await full();
  for (const p of ["/etc/passwd", "/workspace/../etc/passwd", "/workspacefoo/x", "", 42, null])
    assert.equal((await api("POST", "/rag/ingest", { path: p })).status, 400, String(p));
  assert.equal((await api("POST", "/rag/search", {})).status, 400);
  assert.equal((await api("POST", "/rag/search", { query: ["x"] })).status, 400);
});

test("HTTP: vision/stt/tasks/feedback reject junk instead of throwing 500s", async () => {
  const api = await full();
  assert.equal((await api("POST", "/vision", {})).status, 400);
  assert.equal((await api("POST", "/voice/stt", { audioBase64: 5 })).status, 400);
  assert.equal((await api("POST", "/tasks/abc/run")).status, 400);
  assert.equal((await api("DELETE", "/tasks/1e3")).status, 400);
  assert.equal((await api("POST", "/tasks/424242/run")).status, 404);
  assert.equal((await api("POST", "/tasks", { cron: "nope", prompt: "x" })).status, 400);
  const f = await api("POST", "/feedback", { comment: { evil: true }, good: "no" });
  assert.equal(f.status, 200); assert.equal(typeof f.body.id, "number");
  assert.equal((await api("POST", "/chat", { message: 7 })).status, 400);
  assert.equal((await api("POST", "/chat/stream", { message: "  " })).status, 400);
  assert.equal((await api("POST", "/x/trigger", { text: "" })).status, 400);
});

test("HTTP: /chat with an Auto-Review agent that pauses returns the pending id (no SQLite crash)", async () => {
  const api = await full();
  await api("POST", "/agents", { name: "Careful Ops", job: "ops", review: true });
  replyQueue = [{ role: "assistant", content: null, tool_calls: [tc("p1", "rm -rf /tmp/build")] }];
  const r = await api("POST", "/chat", { agentId: "careful-ops", message: "clean up", session: { weird: 1 } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.answer.pendingApproval > 0);
});

test("deep rounds from the request are clamped (no 1e9-round loops)", async () => {
  const { clampRounds } = await import("../../src/router.js");
  assert.equal(clampRounds(1e9), 10); assert.equal(clampRounds(-5), 1); assert.equal(clampRounds("abc"), 1);
  assert.equal(clampRounds(undefined), undefined); assert.equal(clampRounds(3), 3);
});

test("web.fetch refuses non-http protocols, junk URLs and odd methods without fetching", async () => {
  const { webFetchTool } = await import("../../src/tools/web.js");
  assert.match((await webFetchTool.run({ url: "file:///etc/passwd" })).error, /protocol/);
  assert.match((await webFetchTool.run({ url: "not a url" })).error, /invalid/);
  assert.match((await webFetchTool.run({ url: "http://x", method: "DELETE" })).error, /GET or POST/);
  assert.match((await webFetchTool.run({})).error, /invalid/);
});

test("x mentions: handle stripped everywhere, any case, without eating longer handles", async () => {
  const { stripMention } = await import("../../src/tools/xtrigger.js");
  assert.equal(stripMention("@Grok_Bot please   fix @grok_bot", "grok_bot"), "please fix");
  assert.equal(stripMention("@grok_botty hi", "grok_bot"), "@grok_botty hi");
  assert.equal(stripMention("@a.b hi", "a.b"), "hi");
});

// ================= round 4: roster corruption, caps, scheduler overlap, secrets opt-in =================
test("corrupt agents.json: keeps serving the last good roster and saves a backup", async () => {
  const { readdirSync } = await import("node:fs");
  const good = readFileSync(process.env.AGENTS_FILE, "utf8");
  mods.registry.reload(); mods.registry.loadAgents();
  writeFileSync(process.env.AGENTS_FILE, '{"agents": [ {"id": "grok-main"');   // truncated mid-write
  mods.registry.reload();
  const a = mods.registry.loadAgents();
  assert.ok(a.agents["grok-main"], "core agents still served");
  assert.ok(readdirSync(tmp).some(f => f.startsWith("agents.json.corrupt-")));
  assert.equal((await call("GET", "/agents")).status, 200);
  writeFileSync(process.env.AGENTS_FILE, good); mods.registry.reload();
});

test("roster with wrong shapes (bots not an array, null entries) is normalized", () => {
  const good = readFileSync(process.env.AGENTS_FILE, "utf8");
  writeFileSync(process.env.AGENTS_FILE, JSON.stringify({ agents: [null, { id: "grok-main", name: "G" }, 5], bots: { no: 1 } }));
  mods.registry.reload();
  const a = mods.registry.loadAgents();
  assert.deepEqual(Object.keys(a.agents), ["grok-main"]);
  assert.deepEqual(a.bots, []);
  writeFileSync(process.env.AGENTS_FILE, good); mods.registry.reload();
});

test("scheduler: a slow run never stacks a second concurrent run of the same task", async () => {
  let live = 0, peak = 0;
  mods.scheduler.setTaskRunner(async () => { live++; peak = Math.max(peak, live); await new Promise(r => setTimeout(r, 80)); live--; return "ok"; });
  const id = mods.scheduler.addTask({ cron: "0 0 1 1 *", prompt: "slow" });
  await Promise.all([mods.scheduler.runTask(id), mods.scheduler.runTask(id), mods.scheduler.runTask(id)]);
  assert.equal(peak, 1);
  mods.scheduler.deleteTask(id);
});

test("RAG secrets: blocked by default, allowed only with RAG_ALLOW_SECRETS=true", async () => {
  const { ragPath } = await import("../../src/router.js");
  delete process.env.RAG_ALLOW_SECRETS;
  assert.equal(ragPath("/app/.env"), null);
  assert.equal(ragPath("/workspace/notes.md"), "/workspace/notes.md");
  process.env.RAG_ALLOW_SECRETS = "true";
  assert.equal(ragPath("/app/.env"), "/app/.env");
  assert.equal(ragPath("relative\0bad"), null);
  delete process.env.RAG_ALLOW_SECRETS;
});

test("custom agents: name + instructions survive a restart-style reload and reach the model", async () => {
  await call("POST", "/agents", { name: "Night Shift", instructions: "Sign every answer with NS." });
  mods.registry.reload();
  const a = mods.registry.getAgent("night-shift");
  assert.match(a.systemPrompt, /Night Shift/); assert.match(a.systemPrompt, /Sign every answer with NS\./);
  seen.length = 0;
  await mods.runtime.runAgent(a, "hi", []);
  assert.match(seen.at(-1).messages[0].content, /Sign every answer with NS/);
});

// ================= round 5: run log, task board, browser/imagegen/MCP inputs =================
test("CodeX: crafted run ids can't read or write outside RUNS_DIR; events keep their kind", async () => {
  const codex = await import("../../src/agents/codex.js");
  const { existsSync } = await import("node:fs");
  for (const id of ["../../etc/passwd", "..", "a/b", "", null, "x".repeat(200)]) {
    assert.equal(codex.replay(id), null, String(id));
    codex.emit(id, "x");
  }
  assert.ok(!existsSync(join(tmp, "evil.jsonl")));
  const id = codex.newRunId();
  codex.emit(id, "run.start", { kind: "spoofed", ts: "1999" });
  const r = codex.replay(id);
  assert.equal(r.events[0].kind, "run.start"); assert.notEqual(r.events[0].ts, "1999");
  const api = await full();
  assert.equal((await api("GET", "/runs/..%2F..%2Fetc%2Fpasswd")).status, 404);
  assert.equal((await api("GET", `/runs/${id}`)).status, 200);
});

test("task board: bad actions, junk titles, caps, and per-run isolation", async () => {
  const { taskBoardTool } = await import("../../src/agents/taskboard.js");
  const tb = taskBoardTool(), A = { run: { runId: "rA" } }, B = { run: { runId: "rB" } };
  assert.match((await tb.run({ action: "add", title: "x" }, {})).error, /run-scoped/);
  assert.match((await tb.run({ action: "nuke" }, A)).error, /unknown action/);
  assert.match((await tb.run({ action: "add", title: { a: 1 } }, A)).error, /title required/);
  const c = (await tb.run({ action: "add", title: "  Write   tests " }, A)).card;
  assert.equal(c.title, "Write tests");
  assert.equal((await tb.run({ action: "add", title: "write TESTS" }, A)).dedupe, true);
  assert.equal((await tb.run({ action: "list" }, B)).cards.length, 0);
  assert.equal((await tb.run({ action: "update", id: c.id, owner: { x: 1 } }, A)).card.status, "in_progress");
  for (let i = 0; i < 205; i++) await tb.run({ action: "add", title: `card ${i}` }, A);
  assert.equal((await tb.run({ action: "list" }, A)).cards.length, 200);
  assert.match((await tb.run({ action: "done", id: "t999" }, A)).error, /no card/);
});

test("browser tool refuses file://, javascript:, junk urls and selector-less actions before connecting", async () => {
  const { browserTool } = await import("../../src/tools/browser.js");
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "chrome://settings", "nope", undefined])
    assert.ok((await browserTool.run({ url })).error, String(url));
  assert.match((await browserTool.run({ url: "https://x.test", action: "click" })).error, /selector/);
  assert.match((await browserTool.run({ url: "https://x.test", action: "eval" })).error, /action must/);
});

test("imagegen: rejected ComfyUI job fails fast instead of polling /history/undefined", async () => {
  const { imagegenTool } = await import("../../src/tools/imagegen.js");
  const comfy = http.createServer((req, res) => { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":{"message":"ckpt missing"}}'); });
  await new Promise(r => comfy.listen(0, "127.0.0.1", r));
  process.env.COMFYUI_URL = `http://127.0.0.1:${comfy.address().port}`;
  const t0 = Date.now();
  const out = await imagegenTool.run({ prompt: "a cat" });
  assert.match(out.error, /rejected/); assert.ok(Date.now() - t0 < 3000);
  assert.match((await imagegenTool.run({})).error, /prompt required/);
  comfy.close(); delete process.env.COMFYUI_URL;
});

test("MCP: junk server configs are skipped without spawning anything", async () => {
  const { loadMCPTools } = await import("../../src/tools/mcp.js");
  assert.deepEqual(await loadMCPTools(undefined), []);
  assert.deepEqual(await loadMCPTools({ a: null, b: { transport: "stdio" }, c: { transport: "http", command: "x" } }), []);
});

// ================= round 6: streaming, empty completions, vision/X input hardening =================
async function stream(body) {
  const { makeRouter } = await import("../../src/router.js");
  const app = express(); app.use(express.json());
  app.use("/api", makeRouter({ tools: [], docker: { listContainers: async () => [] } }));
  const s = app.listen(0); s.unref();
  const r = await fetch(`http://127.0.0.1:${s.address().port}/api/chat/stream`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const txt = await r.text(); s.close();
  return txt.split("\n\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).map(l => l === "[DONE]" ? l : JSON.parse(l));
}

test("stream: tokens arrive as deltas, end with [DONE], and the chat is remembered", async () => {
  replyQueue = [{ role: "assistant", content: "hello streamer" }];
  const ev = await stream({ message: "hi", session: "stream-mem" });
  assert.equal(ev.at(-1), "[DONE]");
  assert.equal(ev.filter(e => e.delta).map(e => e.delta).join(""), "hello streamer");
  const mem = await import("../../src/memory/store.js");
  assert.ok(mem.recall("stream-mem").recent.some(m => m.content === "hello streamer"));
});

test("stream: a model that answers with tool calls falls back to the agent loop (no empty reply)", async () => {
  replyQueue = [
    { role: "assistant", content: null, tool_calls: [{ id: "q", type: "function", function: { name: "nope", arguments: "{}" } }] },
    { role: "assistant", content: null, tool_calls: [{ id: "q2", type: "function", function: { name: "nope", arguments: "{}" } }] },
    { role: "assistant", content: "answered via loop" },
  ];
  const ev = await stream({ message: "use a tool" });
  assert.match(ev.filter(e => e.delta).map(e => e.delta).join(""), /answered via loop/);
});

test("stream: every model down → error event + [DONE], never a hung socket", async () => {
  ["big:7b", "mid:3b", "small:1b", "llama3.1:8b", "qwen2.5:3b"].forEach(m => failModels.add(m));
  const ev = await stream({ message: "hi" });
  failModels.clear();
  assert.ok(ev.some(e => e.error)); assert.equal(ev.at(-1), "[DONE]");
});

test("router: an empty completion (no choices) falls through to the next model", async () => {
  replyQueue = [{ __raw: JSON.stringify({ id: "x", choices: [] }) }];
  const r = await mods.router.chatRoute([{ role: "user", content: "x" }], [], { mode: "chat" });
  assert.match(r.content, /ok from/);
});

test("vision: data URLs accepted, junk base64 and missing image rejected before calling Ollama", async () => {
  const { visionTool } = await import("../../src/tools/vision.js");
  assert.match((await visionTool.run({})).error, /required/);
  assert.match((await visionTool.run({ imageBase64: "<script>" })).error, /not valid base64/);
  const ollama = http.createServer((req, res) => { let b = ""; req.on("data", c => b += c); req.on("end", () => {
    const j = JSON.parse(b); res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ response: `img=${j.images[0]}` })); }); });
  await new Promise(r => ollama.listen(0, "127.0.0.1", r));
  const prev = process.env.OLLAMA_URL; process.env.OLLAMA_URL = `http://127.0.0.1:${ollama.address().port}`;
  assert.equal(await visionTool.run({ imageBase64: "data:image/png;base64,iVBO Rw0=" }), "img=iVBORw0=");
  process.env.OLLAMA_URL = prev; ollama.close();
});

test("X tools: empty text/query rejected; x.post always needs review; emoji not split at 280", async () => {
  const { xSearchTool, xPostTool } = await import("../../src/tools/xfeed.js");
  assert.match((await xSearchTool.run({})).error, /query required/);
  assert.match((await xPostTool.run({ text: "   " })).error, /text required/);
  assert.equal(mods.approvals.needsReview("x.post", { text: "hi" }), true);
  const api = await full();
  assert.equal((await api("POST", "/tools/terminal/invoke", { command: "echo safe" })).status, 200);
});

// ================= round 7: routing, DeepSearch, Think, RAG vectors, voice =================
test("dispatch: whole words only, and instruction-only custom agents can be routed to", async () => {
  await call("POST", "/agents", { name: "Kubernetes Wrangler", instructions: "You handle helm charts and kubernetes clusters." });
  assert.equal(mods.team.dispatch("our kubernetes helm deploy is stuck").id, "kubernetes-wrangler");
  await call("POST", "/agents", { name: "Tester", job: "test plans" });
  assert.notEqual(mods.team.dispatch("what's the latest news").id, "tester");   // 'test' ⊄ 'latest'
  assert.equal(mods.team.dispatch("zzzz qqqq").id, "grok-main");
});

test("DeepSearch: URL wrapped in prose, dead pages, duplicates, missing browser", async () => {
  const { deepSearch } = await import("../../src/agents/deepsearch.js");
  assert.match((await deepSearch("q", null)).synthesis, /needs the browser/);
  const reads = [];
  const browser = { run: async ({ url }) => (reads.push(url), url.includes("dead") ? { error: "net::ERR" } : { url, title: "T", content: "facts" }) };
  replyQueue = [
    { role: "assistant", content: "Next I'd read <https://dead.example/a>." },
    { role: "assistant", content: "Try https://good.example/b, it's best." },
    { role: "assistant", content: "synthesis with [src](https://good.example/b)" },
    { role: "assistant", content: "https://good.example/b" },          // duplicate → skipped
    { role: "assistant", content: null },                               // null → stop
  ];
  const out = await deepSearch("q", browser, { rounds: 5 });
  assert.deepEqual(reads, ["https://dead.example/a", "https://good.example/b"]);
  assert.match(out.synthesis, /synthesis with/);
  assert.equal(out.sources[0].error, "net::ERR");
  replyQueue = [];
});

test("Think: null passes keep prior reasoning; never returns null", async () => {
  const { thinkAnswer } = await import("../../src/agents/think.js");
  replyQueue = [{ role: "assistant", content: "r1" }, { role: "assistant", content: null }, { role: "assistant", content: null }];
  assert.equal(await thinkAnswer("why?", { passes: 2 }), "r1");
  replyQueue = [];
});

test("RAG vectors: stored float32 BLOBs decode to the same vector (was byte-by-byte garbage)", async () => {
  const { blobToVec, cos } = await import("../../src/rag/index.js");
  const v = Float32Array.from([0.25, -1.5, 3, 0.125]);
  const blob = Buffer.concat([Buffer.alloc(1), Buffer.from(v.buffer)]).subarray(1);   // unaligned offset
  assert.deepEqual([...blobToVec(blob)], [...v]);
  assert.ok(Math.abs(cos(v, blobToVec(blob)) - 1) < 1e-6);
  assert.equal(cos(v, Float32Array.from([1, 2])), -1);              // other embed model's dims
  assert.equal(cos(v, new Float32Array(4)), -1);                    // zero vector → not NaN
});

test("voice: bad voice names / empty text / empty audio fail cleanly", async () => {
  const voice = await import("../../src/voice/voice.js");
  assert.equal((await voice.speak("hi", "../../etc/x")).error, "bad voice name");
  assert.equal((await voice.speak("  ")).error, "text required");
  await assert.rejects(voice.transcribe(Buffer.alloc(0)), /empty audio/);
  const api = await full();
  assert.equal((await api("POST", "/voice/stt", { audioBase64: "====" })).status, 400);
  assert.equal((await api("POST", "/voice/stt", { audioBase64: "UklGRg==" })).status, 503);   // no backend here
});

// ================= round 8: memory order, terminal input, skills (teach-a-task + playbooks) =================
test("memory: recent context is chronological (it used to be fed to the model backwards)", async () => {
  const mem = await import("../../src/memory/store.js");
  for (const m of ["first", "second", "third"]) await mem.remember("order-chk", "user", m);
  assert.deepEqual(mem.recall("order-chk").recent.map(r => r.content), ["first", "second", "third"]);
  assert.match(mem.memoryContext("order-chk"), /first[\s\S]*second[\s\S]*third/);
});

test("terminal: missing/blank/huge command rejected (never runs 'undefined')", async () => {
  const { terminalTool } = await import("../../src/tools/terminal.js");
  assert.equal((await terminalTool.run({})).error, "command required");
  assert.equal((await terminalTool.run({ command: "  " })).error, "command required");
  assert.match((await terminalTool.run({ command: "x".repeat(20_001) })).error, /too long/);
});

test("skills: POST /skills validates, saves, and the skill.<name> tool exists immediately", async () => {
  const api = await full();
  assert.equal((await api("POST", "/skills", { name: "Bad Name", steps: [{ action: "wait" }] })).status, 400);
  assert.equal((await api("POST", "/skills", { name: "x", steps: [] })).status, 400);
  assert.equal((await api("POST", "/skills", { name: "x", steps: [{ action: "goto", url: "file:///etc/passwd" }] })).status, 400);
  assert.equal((await api("POST", "/skills", { name: "x", steps: [{ action: "rm" }] })).status, 400);
  const ok = await api("POST", "/skills", { name: "check-status", description: "open status page", steps: [{ action: "goto", url: "https://status.example" }, { action: "wait", ms: 10 }] });
  assert.equal(ok.status, 201); assert.equal(ok.body.tool, "skill.check-status");
  const list = await api("GET", "/skills");
  assert.ok(list.body.recorded.some(s => s.name === "check-status" && s.steps === 2));
  const tools = await api("GET", "/tools");
  assert.ok(JSON.stringify(tools.body).includes("skill.check-status"));
});

test("skills: CRLF / BOM / quoted SKILL.md frontmatter parses; no-frontmatter falls back to folder name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skills-"));
  mkdirSync(join(dir, "win")); writeFileSync(join(dir, "win", "SKILL.md"), "\uFEFF---\r\nname: \"win-skill\"\r\ndescription: 'from windows'\r\n---\r\nbody");
  mkdirSync(join(dir, "bare")); writeFileSync(join(dir, "bare", "SKILL.md"), "just text");
  const prev = process.env.SKILLS_DIR; process.env.SKILLS_DIR = dir;
  const mod = await import(`../../src/tools/skills.js?d=${Date.now()}`);
  const names = mod.loadPlaybooks().map(p => p.name).sort();
  assert.deepEqual(names, ["bare", "win-skill"]);
  const load = mod.playbookTools()[1];
  assert.equal((await load.run({ name: "WIN-SKILL" })).description, "from windows");
  assert.match((await load.run({})).error, /name required/);
  process.env.SKILLS_DIR = prev;
});

// ================= round 9: live CI boot loop =================
test("boot: untagged model names match Ollama's tagged listing (CI boot restart-loop root cause)", async () => {
  const { hasModel, normModel } = await import("../../src/boot/models.js");
  const tags = { models: [{ name: "qwen2.5:3b" }, { name: "nomic-embed-text:latest" }, { name: "registry.local:5000/team/llama" }] };
  assert.ok(hasModel(tags, "nomic-embed-text"));          // was false forever → 15 min wait → throw
  assert.ok(hasModel(tags, "nomic-embed-text:latest"));
  assert.ok(hasModel(tags, "Qwen2.5:3b"));
  assert.ok(!hasModel(tags, "qwen2.5:7b"));
  assert.ok(hasModel(tags, "registry.local:5000/team/llama:latest"));   // port colon ≠ tag
  assert.ok(!hasModel({}, "x")); assert.ok(!hasModel(tags, ""));
  assert.equal(normModel("llava"), "llava:latest");
});

// ================= round 10: team dialogue, inbox queues, knowledge board, council =================
test("dialogue: queued inbox per agent, broadcasts, cursor, eureka → knowledge (deduped)", async () => {
  const d = await import("../../src/agents/dialogue.js");
  d.post({ from: "Planner", to: "coder", kind: "ask", text: "Can you check the boot logs?" });
  d.post({ from: "planner", to: "*", text: "Status: round ten started.\nEUREKA: Ollama lists models with a :latest tag." });
  d.post({ from: "coder", to: "*", kind: "eureka", text: "Ollama lists models with a :latest tag." });   // duplicate insight
  const box = d.inbox("coder");
  assert.deepEqual(box.map(m => m.kind), ["ask", "note"]);
  assert.equal(d.inbox("coder").length, 0);                     // cursor advanced: queue drained
  assert.equal(d.inbox("planner").filter(m => m.from === "planner").length, 0);   // own broadcasts excluded
  assert.equal(d.knowledge({ q: ":latest" }).length, 1);
  assert.equal(d.knowledge({ q: "100%_" }).length, 0);           // LIKE wildcards escaped
  assert.throws(() => d.post({ from: "x", text: "   " }), /text required/);
  assert.throws(() => d.post({ from: "x", text: "hi", kind: "shout" }), /kind must be/);
  assert.match(d.teamContext(), /proper English[\s\S]*:latest tag/);
});

test("dialogue: every agent's system prompt carries the English style + team knowledge; team tools always granted", async () => {
  replyQueue = [{ role: "assistant", content: "done" }];
  const { runAgent } = await import("../../src/agents/runtime.js");
  const tools = [{ name: "team.say", run: async () => ({}) }, { name: "terminal", run: async () => ({}) }];
  // inspect what the stub LLM received
  lastBodies.length = 0;
  await runAgent({ id: "narrow", systemPrompt: "You are narrow.", tools: ["browser"] }, "hi", tools);
  const body = lastBodies.at(-1);
  assert.match(body.messages[0].content, /You are narrow\.[\s\S]*proper English/);
  assert.deepEqual((body.tools || []).map(t => t.function.name), ["team.say"]);
});

test("team.ask records the ask and the answer in the dialogue", async () => {
  const d = await import("../../src/agents/dialogue.js");
  await call("POST", "/agents", { name: "Dialogue Helper", instructions: "Answer briefly." });
  replyQueue = [{ role: "assistant", content: "Here is my answer." }];
  const ask = mods.team.teamAskTool(() => []);
  await ask.run({ bot: "dialogue-helper", task: "Summarize the logs." }, { agent: "lead", run: { runId: "ask-run" } });
  const f = d.feed({ runId: "ask-run" });
  assert.deepEqual(f.map(m => [m.from, m.to, m.kind]), [["lead", "dialogue-helper", "ask"], ["dialogue-helper", "lead", "answer"]]);
});

test("council: validates input, agents take turns reading the thread, eurekas land on the board", async () => {
  const api = await full();
  assert.equal((await api("POST", "/council", { agents: ["grok-main", "x"] })).status, 400);
  assert.equal((await api("POST", "/council", { topic: "t", agents: ["grok-main"] })).status, 400);
  assert.equal((await api("POST", "/council", { topic: "t", agents: ["grok-main", "nobody-here"] })).status, 404);
  await call("POST", "/agents", { name: "Council Critic", instructions: "Challenge assumptions politely." });
  replyQueue = [
    { role: "assistant", content: "I propose we test empty inputs first." },
    { role: "assistant", content: "I agree, and we should also test unicode names.\nEUREKA: Unicode agent names need slug fallbacks." },
  ];
  const r = await api("POST", "/council", { topic: "What should we test next?", agents: ["grok-main", "council-critic"], rounds: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.dialogue.map(m => m.from), ["human", "grok-main", "council-critic"]);
  assert.ok(r.body.eurekas.some(e => /slug fallbacks/.test(e.text)));
  const second = lastBodies.at(-1).messages[1].content;          // the critic saw the first turn
  assert.match(second, /grok-main: I propose we test empty inputs first/);
  const feed = await api("GET", `/dialogue?run=${r.body.runId}`);
  assert.equal(feed.body.length, 3);
  assert.equal((await api("POST", "/dialogue", { text: "" })).status, 400);
  assert.equal((await api("POST", "/dialogue", { text: "Great work, team." })).status, 201);
});

// ================= round 11: agent nodes (own machine per agent) =================
function fakeDocker() {
  const state = new Map(); const execs = [];
  const docker = {
    created: [], removed: [], execs,
    getContainer(name) {
      return {
        inspect: async () => { if (!state.has(name)) { const e = new Error("no such container"); e.statusCode = 404; throw e; }
          const s = state.get(name); return { State: { Running: s.running }, Config: { Image: s.spec.Image }, HostConfig: s.spec.HostConfig, NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.9" } } } }; },
        start: async () => { state.get(name).running = true; },
        remove: async () => { if (!state.has(name)) { const e = new Error("gone"); e.statusCode = 404; throw e; } state.delete(name); docker.removed.push(name); },
        exec: async (opts) => { execs.push({ name, cmd: opts.Cmd }); const { PassThrough } = await import("node:stream");
          return { start: async () => { const s = new PassThrough(); setImmediate(() => { s.write(`ran on ${name}`); s.end(); }); return s; }, inspect: async () => ({ ExitCode: 0 }) }; },
      };
    },
    createContainer: async (spec) => { await new Promise(r => setTimeout(r, 5)); if (state.has(spec.name)) { const e = new Error("conflict"); e.statusCode = 409; throw e; }
      state.set(spec.name, { spec, running: false }); docker.created.push(spec); return docker.getContainer(spec.name); },
    listContainers: async () => [...state.entries()].map(([n, s]) => ({ Names: ["/" + n], Labels: s.spec.Labels, State: s.running ? "running" : "created", Status: "Up", Image: s.spec.Image })),
    modem: { demuxStream: (stream, out) => stream.on("data", d => out.write(d)) },
  };
  return docker;
}

test("nodes: per-agent node with its own limits/env/network; parallel calls create it once", async () => {
  process.env.AGENT_NODES = "true";
  const nodes = await import("../../src/agents/nodes.js");
  const docker = fakeDocker();
  const agent = { id: "net-scout", resources: { cpus: 0.5, memoryMb: 256, pids: 64 }, env: { REGION: "us" }, network: "none" };
  const [a, b] = await Promise.all([nodes.ensureNode(docker, agent), nodes.ensureNode(docker, agent)]);
  assert.equal(a.name, "grok-node-net-scout"); assert.equal(docker.created.length, 1);
  const spec = docker.created[0];
  assert.equal(spec.HostConfig.NanoCpus, 5e8); assert.equal(spec.HostConfig.Memory, 256 * 1048576);
  assert.equal(spec.HostConfig.PidsLimit, 64); assert.equal(spec.HostConfig.NetworkMode, "none");
  assert.ok(spec.Env.includes("REGION=us")); assert.ok(spec.HostConfig.SecurityOpt.includes("no-new-privileges"));
  assert.equal((await nodes.ensureNode(docker, agent)).created, false);
  assert.equal(nodes.nodeName("../../Etc PASSWD"), "grok-node-etc-passwd");
});

test("nodes: node.exec runs on the caller's OWN node; spawned key gets a separate node; disabled → clear error", async () => {
  const nodes = await import("../../src/agents/nodes.js");
  const docker = fakeDocker();
  const [exec, svc, info] = nodes.nodeTools(() => docker, id => ({ id }));
  const r1 = await exec.run({ command: "uname -a" }, { agent: "alpha" });
  const r2 = await exec.run({ command: "uname -a" }, { agent: "alpha", nodeKey: "alpha-spawn1-xyz" });
  assert.equal(r1.node, "grok-node-alpha"); assert.equal(r2.node, "grok-node-alpha-spawn1-xyz");
  assert.match(r1.stdout, /ran on grok-node-alpha/);
  assert.deepEqual(docker.execs[0].cmd.slice(0, 4), ["timeout", "-s", "KILL", "30"]);
  assert.match((await exec.run({}, { agent: "alpha" })).error, /command required/);
  assert.match((await svc.run({ action: "start", name: "../x", command: "y" }, { agent: "alpha" })).error, /name must be/);
  assert.match((await svc.run({ action: "start", name: "web" }, { agent: "alpha" })).error, /needs a command/);
  assert.match((await svc.run({ action: "explode", name: "web" }, { agent: "alpha" })).error, /action must be/);
  assert.equal((await info.run({}, { agent: "alpha" })).ips[0], "172.17.0.9");
  process.env.AGENT_NODES = "false";
  assert.match((await exec.run({ command: "ls" }, { agent: "alpha" })).error, /disabled/);
  process.env.AGENT_NODES = "true";
});

test("nodes: service manager script quotes commands and survives a single quote", async () => {
  const { serviceScript } = await import("../../src/agents/nodes.js");
  const s = serviceScript("start", "web", "python3 -m http.server 8080 --bind '0.0.0.0'");
  assert.match(s, /printf '%s' 'python3 -m http.server 8080 --bind '\\''0.0.0.0'\\'''/);
  assert.match(serviceScript("restart", "web"), /not running[\s\S]*no command saved/);
  assert.equal(serviceScript("rm-rf", "web"), null);
  // real shell check: the generated script is valid POSIX sh
  const { execFileSync } = await import("node:child_process");
  for (const a of ["start", "stop", "restart", "status", "logs", "list"]) execFileSync("sh", ["-n", "-c", serviceScript(a, "web", "echo it's alive")]);
});

test("nodes: agent API accepts node config, rejects bad resources/env/mcp; spawn cleans up its ephemeral node", async () => {
  const bad = [
    { resources: { cpus: 99 } }, { resources: { memoryMb: 1.5 } }, { env: { "bad-name": "x" } },
    { env: { OK: 5 } }, { network: "host" }, { mcp: { "Bad Id": { command: "x" } } }, { mcp: { fs: { args: ["x"] } } },
  ];
  for (const extra of bad) assert.equal((await call("POST", "/agents", { name: `Node Bad ${Math.random()}`, job: "x", ...extra })).status, 400, JSON.stringify(extra));
  const ok = await call("POST", "/agents", { name: "Node Owner", job: "net ops", resources: { cpus: 2, memoryMb: 2048 },
    env: { LOG_LEVEL: "debug" }, network: "bridge", mcp: { fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/root"] } } });
  assert.equal(ok.status, 201); assert.equal(ok.body.agent.resources.cpus, 2); assert.ok(ok.body.agent.mcp.fs);
  // node.* tools are granted even to an agent whose whitelist doesn't name them
  replyQueue = [{ role: "assistant", content: "ok" }];
  const { runAgent } = await import("../../src/agents/runtime.js");
  await runAgent({ id: "w", tools: ["browser"] }, "hi", [{ name: "node.exec", run: async () => ({}) }, { name: "terminal", run: async () => ({}) }]);
  assert.deepEqual(lastBodies.at(-1).tools.map(t => t.function.name), ["node.exec"]);
  assert.equal(mods.approvals.needsReview("node.exec", { command: "rm -rf /" }), true);
  // spawn: ephemeral node removed afterwards
  const docker = fakeDocker();
  const { spawnTool } = await import("../../src/tools/spawn.js");
  replyQueue = [{ role: "assistant", content: null, tool_calls: [{ id: "n1", type: "function", function: { name: "node.exec", arguments: '{"command":"hostname"}' } }] }, { role: "assistant", content: "spawn done" }];
  const nodes = await import("../../src/agents/nodes.js");
  const tools = nodes.nodeTools(() => docker, id => ({ id }));
  const sp = spawnTool(() => tools, () => docker);
  const out = await sp.run({ task: "check hostname" }, { agent: "lead", run: {} });
  assert.equal(out.answer, "spawn done");
  assert.equal(docker.created.length, 1); assert.match(docker.created[0].name, /^grok-node-grok-main-spawn1-/);
  assert.deepEqual(docker.removed, [docker.created[0].name]);
});

// ================= round 12: the Lattice (follow agents' thinking + autonomous growth) =================
test("lattice: a real agent run is followable — prompt, thought, tool call (secrets redacted), result, answer", async () => {
  const lattice = await import("../../src/agents/lattice.js");
  lattice.reset();
  replyQueue = [
    { role: "assistant", content: "I should check the page first.", tool_calls: [{ id: "L1", type: "function", function: { name: "probe", arguments: '{"url":"https://x.test","apiKey":"sk-live-123"}' } }] },
    { role: "assistant", content: "The page is up." }
  ];
  const { runAgent } = await import("../../src/agents/runtime.js");
  const out = await runAgent({ id: "lat-a", tools: ["*"], systemPrompt: "You watch pages." }, "Is it up?", [{ name: "probe", run: async () => ({ status: 200 }) }], { runId: "lat-run" });
  assert.equal(out, "The page is up.");
  const ev = lattice.events({ agent: "lat-a" });
  assert.deepEqual(ev.map(e => e.kind), ["prompt", "thought", "tool_call", "tool_result", "answer"]);
  assert.equal(ev[2].data.args.apiKey, "***"); assert.equal(ev[2].data.args.url, "https://x.test");
  assert.equal(ev[3].data.ok, true); assert.equal(ev[0].data.system, "You watch pages.");
  assert.ok(ev.every(e => e.runId === "lat-run"));
  assert.deepEqual(lattice.events({ agent: "lat-a", kind: "thought,answer" }).map(e => e.kind), ["thought", "answer"]);
  assert.equal(lattice.events({ q: "PAGE IS UP" }).length, 1);
  assert.equal(lattice.events({ since: ev.at(-1).id }).length, 0);
});

test("lattice: dialogue + eurekas feed it; graph shows who talks to whom; survives restart; bogus kinds ignored", async () => {
  const lattice = await import("../../src/agents/lattice.js");
  const dlg = await import("../../src/agents/dialogue.js");
  lattice.reset();
  dlg.post({ from: "alpha", to: "beta", kind: "ask", text: "Can you verify the cache?\nEUREKA: Lattice edges count directed messages." });
  dlg.post({ from: "beta", to: "alpha", kind: "answer", text: "Verified." });
  dlg.post({ from: "alpha", to: "beta", kind: "note", text: "Thanks." });
  const g = lattice.graph();
  assert.deepEqual(g.edges.find(e => e.from === "alpha" && e.to === "beta").count, 2);
  assert.equal(g.nodes.find(n => n.id === "alpha").eurekas, 1);
  assert.equal(lattice.record("nonsense", { agent: "x" }), null);
  const before = lattice.events({}).length;
  assert.equal(lattice.load(), before);                    // reload from the JSONL file
  assert.equal(lattice.events({ kind: "eureka" })[0].text, "Lattice edges count directed messages.");
  assert.equal(lattice.redact({ nested: { password: "p", ok: "x".repeat(700) } }).nested.password, "***");
});

test("lattice API: events, agent timeline, graph, live SSE follow, grow validation + daily cap + no overlap", async () => {
  const lattice = await import("../../src/agents/lattice.js");
  const { makeRouter } = await import("../../src/router.js");
  const app = express(); app.use(express.json());
  app.use("/api", makeRouter({ tools: [], docker: { listContainers: async () => [] } }));
  const s = app.listen(0); s.unref();
  const lbase = `http://127.0.0.1:${s.address().port}/api`;
  const call = (method, path, body) => fetch(lbase + path, { method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  lattice.reset();
  lattice.record("say", { agent: "gamma", to: "delta", text: "hello delta" });
  assert.equal((await call("GET", "/lattice/events?agent=gamma")).body.events.length, 1);
  assert.equal((await call("GET", "/lattice/agents/delta")).body.events[0].text, "hello delta");
  assert.ok((await call("GET", "/lattice/graph")).body.edges.length >= 1);
  // live stream: backlog then a new event, filtered by agent
  const ctrl = new AbortController();
  const res = await fetch(`${lbase}/lattice/stream?agent=gamma`, { signal: ctrl.signal });
  const reader = res.body.getReader(); let buf = "";
  const until = async re => { while (!re.test(buf)) buf += new TextDecoder().decode((await reader.read()).value); };
  await until(/hello delta/);
  lattice.record("thought", { agent: "other", text: "not for gamma" });
  lattice.record("eureka", { agent: "gamma", text: "streamed live" });
  await until(/streamed live/);
  assert.ok(!buf.includes("not for gamma"));
  ctrl.abort();
  assert.equal((await call("POST", "/lattice/grow", { agents: ["nope"] })).status, 400);
  // growOnce: cap + overlap guard, and the topic builds on discoveries and failures
  let release; const slow = new Promise(r => release = r);
  const deps = { council: async () => { await slow; return { runId: "g1", dialogue: [1, 2] }; }, knowledge: () => [{ text: "A", agent: "x" }], runAgent() {}, tools: [], getAgent() {} };
  process.env.LATTICE_MAX_CYCLES_PER_DAY = "1";
  const p = lattice.growOnce(deps);
  assert.match((await lattice.growOnce(deps)).skipped, /already running/);
  release(); assert.equal((await p).turns, 2);
  assert.match((await lattice.growOnce(deps)).skipped, /daily limit/);
  delete process.env.LATTICE_MAX_CYCLES_PER_DAY;
  const t = lattice.nextTopic([{ text: "cache is stale", agent: "a" }], [{ agent: "b", text: "tool timeout" }]);
  assert.match(t, /cache is stale \(a\)/); assert.match(t, /b: tool timeout/);
});
