// Observability: hash-chained tool-call ledger, real token streaming,
// run feedback, and SSE helpers for orchestrated (squad/deep) progress notes.
// The ledger chain makes the trace log tamper-evident: each entry's hash covers
// the previous entry's hash, and the args are sliced BEFORE hashing (verify()
// re-reads exactly what was stored).

import Database from "better-sqlite3";
import { dataPath } from "../paths.js";
import { createHash } from "node:crypto";
import { chatRoute } from "../llm/router.js";

const db = new Database(dataPath("traces.db"));
db.exec(`CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY, ts TEXT, agent TEXT, tool TEXT, args TEXT,
  duration_ms INTEGER, ok INTEGER, error TEXT, prev_hash TEXT, hash TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY, ts TEXT, run_id TEXT, comment TEXT, good INTEGER
)`);

function lastHash() {
  return db.prepare("SELECT hash FROM tool_calls ORDER BY id DESC LIMIT 1").get()?.hash || "GENESIS";
}

function log(agent, tool, args, ms, ok, error) {
  const prev = lastHash();
  const argsStr = String(JSON.stringify(args ?? {}) ?? "").slice(0, 2000);
  agent = String(agent ?? "system");
  error = error == null ? null : String(error);    // slice BEFORE hashing — ledger() re-reads the stored (sliced) value
  const body = JSON.stringify({ agent, tool, args: argsStr, ms, ok, error, prev });
  const hash = createHash("sha256").update(prev + body).digest("hex");
  db.prepare("INSERT INTO tool_calls (ts, agent, tool, args, duration_ms, ok, error, prev_hash, hash) VALUES (datetime('now'),?,?,?,?,?,?,?,?)")
    .run(agent, tool, argsStr, ms, ok, error, prev, hash);
}

// Wrap every tool at boot so all calls are logged automatically.
// ctx (2nd tool arg: { agent, run, spawnDepth }) passes straight through.
export function traceTools(tools, agent = "system") {
  return tools.map(t => ({
    ...t,
    async run(args, ctx) {
      const start = Date.now();
      try {
        const out = await t.run(args, ctx);
        log(ctx?.agent || agent, t.name, args, Date.now() - start, 1, null);
        return out;
      } catch (e) {
        log(ctx?.agent || agent, t.name, args, Date.now() - start, 0, e.message);
        throw e;
      }
    }
  }));
}

export function ledger() {
  const rows = db.prepare("SELECT id seq, ts, agent, tool, duration_ms, ok, error, hash, prev_hash, args FROM tool_calls ORDER BY id").all();
  let intact = true;
  rows.forEach(r => {
    const body = JSON.stringify({ agent: r.agent, tool: r.tool, args: r.args, ms: r.duration_ms, ok: r.ok, error: r.error, prev: r.prev_hash });
    const expect = createHash("sha256").update(r.prev_hash + body).digest("hex");
    if (expect !== r.hash) intact = false;
  });
  return { intact, entries: rows.slice(-100).reverse() };
}

export function queryTraces(limit = 50) {
  limit = Math.min(Math.max(1, Number(limit) || 50), 1000);
  return db.prepare(
    "SELECT ts, agent, tool, args, duration_ms, ok, error FROM tool_calls ORDER BY id DESC LIMIT ?"
  ).all(limit);
}

// Run feedback: thumbs up/down + free-text, replayable and injected into context
export function recordFeedback({ runId = "", comment = "", good = true } = {}) {
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO feedback (ts, run_id, comment, good) VALUES (datetime('now'),?,?,?)"
  ).run(String(runId ?? ""), String(comment ?? "").slice(0, 2000), good ? 1 : 0);
  return Number(lastInsertRowid);
}
export function recentFeedback(limit = 5) {
  limit = Math.min(Math.max(1, Number(limit) || 5), 100);
  return db.prepare("SELECT id, ts, run_id, comment, good FROM feedback ORDER BY id DESC LIMIT ?").all(limit);
}

// SSE plumbing for orchestrated modes (squad/deep stream {note} progress lines)
export function sseStart(res) {
  // idempotent: /chat/stream opens the stream before picking a mode, and streamChat opens it
  // again — the second writeHead threw ERR_HTTP_HEADERS_SENT and killed plain streaming chat
  if (res.headersSent) return;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}
export function sseNote(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
}
export function sseDone(res) {
  try { res.write("data: [DONE]\n\n"); } catch {}
  res.end();
}

// Real streaming: pipe Ollama's token stream straight to the client
export async function streamChat(res, agent, message, tools, { fallback } = {}) {
  sseStart(res);
  let text = "", sawToolCalls = false, gone = false;
  res.on?.("close", () => { if (!res.writableEnded) gone = true; });   // client hung up
  try {
    const stream = await chatRoute([
      { role: "system", content: agent.systemPrompt || "You are a helpful AI teammate." },
      { role: "user", content: message }
    ], tools, { mode: agent.mode || "chat", stream: true, model: agent.model || "" });
    for await (const chunk of stream) {
      if (gone) break;                       // stop generating for nobody
      const d = chunk?.choices?.[0]?.delta;
      if (d?.tool_calls?.length) sawToolCalls = true;
      if (d?.content) { text += d.content; sseNote(res, { delta: d.content }); }
    }
    // the model chose tools instead of talking: run the real agent loop and send its answer
    if (!gone && !text && sawToolCalls && fallback) {
      const answer = await fallback();
      text = typeof answer === "string" ? answer : JSON.stringify(answer);
      sseNote(res, { delta: text });
    }
  } catch (e) {
    // headers are already sent, so errors must travel inside the stream (never a hung socket)
    sseNote(res, { error: e.message, delta: `stream failed: ${e.message}` });
  }
  if (!res.writableEnded) sseDone(res);
  return text;
}
