// Offline edge-case suite — runs with plain `node --test tests/unit/` on any
// host (no Docker, no Ollama): a stub OpenAI-compatible server stands in for
// the model so we can assert exactly what the runtime sends it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, cpSync } from "node:fs";
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
const llm = http.createServer((req, res) => {
  let b = ""; req.on("data", c => (b += c)); req.on("end", () => {
    const body = JSON.parse(b || "{}");
    seen.push(body);
    if (failModels.has(body.model)) { res.writeHead(500); return res.end('{"error":"boom"}'); }
    const message = replyQueue.shift() || { role: "assistant", content: `ok from ${body.model}` };
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
