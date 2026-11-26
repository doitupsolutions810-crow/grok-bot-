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
  const src = readFileSync(new URL("../../src/router.js", import.meta.url), "utf8");
  assert.match(src, /tool_call_id: held\.call\.id/);
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
