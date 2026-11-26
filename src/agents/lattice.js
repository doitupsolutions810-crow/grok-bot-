// The Lattice: an observability + autonomy layer laid over the agent orchestration.
//
// Every agent run is already wired to report into it (runtime.js / dialogue.js), so the
// SAME agents, with their SAME system prompts, become followable:
//   prompt       what an agent was asked (and the first part of its system prompt)
//   thought      the text a model wrote alongside its tool calls (its stated reasoning)
//   tool_call    which tool it reached for, with arguments (secrets redacted)
//   tool_result  whether that tool worked, and a short preview of what came back
//   say          a message one agent sent another (team.say / council turns)
//   eureka       a discovery filed on the team knowledge board
//   answer       the agent's final answer
//   error        a model or tool failure
// Events live in a bounded in-memory ring and an append-only JSONL file (rotated), and
// stream live over SSE. /lattice/graph shows who talks to whom.
//
// Autonomous growth (LATTICE_AUTONOMY=true): every LATTICE_INTERVAL_MIN minutes the lattice
// reads what the team discovered, then convenes a council that builds on it. Bounded by
// LATTICE_MAX_CYCLES_PER_DAY and never overlapping itself. Off by default: it spends compute.

import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

export const KINDS = ["prompt", "thought", "tool_call", "tool_result", "say", "eureka", "answer", "error", "cycle"];
const RING = 5000;
const MAX_FILE = 5 * 1024 * 1024;
const bus = new EventEmitter();
bus.setMaxListeners(200);
let ring = [];
let seq = 0;

const dir = () => process.env.DATA_DIR || "/data";
const file = () => path.join(dir(), "lattice.jsonl");
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|auth|cookie|credential|private/i;

export function redact(v, depth = 0) {
  if (depth > 4) return "…";
  if (Array.isArray(v)) return v.slice(0, 20).map(x => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v).slice(0, 40)) o[k] = SECRET_KEY.test(k) ? "***" : redact(x, depth + 1);
    return o;
  }
  if (typeof v === "string") return v.length > 600 ? v.slice(0, 600) + "…" : v;
  return v;
}
const short = (s, n = 1200) => { s = typeof s === "string" ? s : JSON.stringify(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

export function record(kind, { agent = "", to = "", runId = "", text = "", data } = {}) {
  if (!KINDS.includes(kind)) return null;
  const ev = { id: ++seq, ts: new Date().toISOString(), kind, agent: String(agent || ""), to: String(to || ""),
    runId: String(runId || ""), text: short(text), ...(data !== undefined ? { data: redact(data) } : {}) };
  ring.push(ev);
  if (ring.length > RING) ring = ring.slice(-RING);
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const f = file();
    try { if (fs.statSync(f).size > MAX_FILE) fs.renameSync(f, f + ".1"); } catch {}
    fs.appendFileSync(f, JSON.stringify(ev) + "\n");
  } catch { /* observability must never break an agent */ }
  bus.emit("event", ev);
  return ev;
}

// Restore the ring from disk on boot so the history survives restarts.
export function load() {
  try {
    const lines = fs.readFileSync(file(), "utf8").split("\n").filter(Boolean).slice(-RING);
    ring = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(e => e && KINDS.includes(e.kind));
    seq = ring.reduce((m, e) => Math.max(m, Number(e.id) || 0), seq);
  } catch { ring = []; }
  return ring.length;
}

export function events({ agent, kind, runId, since = 0, q, limit = 200 } = {}) {
  const kinds = kind ? String(kind).split(",").filter(k => KINDS.includes(k)) : null;
  const n = Math.min(Math.max(1, Number(limit) || 200), 2000);
  const needle = q ? String(q).toLowerCase() : null;
  return ring.filter(e =>
    e.id > (Number(since) || 0) &&
    (!agent || e.agent === agent || e.to === agent) &&
    (!kinds || kinds.includes(e.kind)) &&
    (!runId || e.runId === runId) &&
    (!needle || e.text.toLowerCase().includes(needle))
  ).slice(-n);
}

// Who talks to whom, how busy each agent is, and what each one discovered.
export function graph() {
  const nodes = {}, edges = {};
  const node = a => (nodes[a] ||= { id: a, prompts: 0, thoughts: 0, tools: 0, toolErrors: 0, said: 0, eurekas: 0, answers: 0, errors: 0 });
  for (const e of ring) {
    if (!e.agent) continue;
    const n = node(e.agent);
    if (e.kind === "prompt") n.prompts++;
    else if (e.kind === "thought") n.thoughts++;
    else if (e.kind === "tool_call") n.tools++;
    else if (e.kind === "tool_result" && e.data?.ok === false) n.toolErrors++;
    else if (e.kind === "eureka") n.eurekas++;
    else if (e.kind === "answer") n.answers++;
    else if (e.kind === "error") n.errors++;
    else if (e.kind === "say") {
      n.said++;
      const key = `${e.agent}→${e.to || "*"}`;
      edges[key] = (edges[key] || 0) + 1;
    }
  }
  return { nodes: Object.values(nodes), edges: Object.entries(edges).map(([k, count]) => { const [from, to] = k.split("→"); return { from, to, count }; }) };
}

export function subscribe(fn) { bus.on("event", fn); return () => bus.off("event", fn); }
export function reset() { ring = []; seq = 0; try { fs.rmSync(file(), { force: true }); } catch {} }

// ---------- autonomous growth ----------
const state = { running: false, cycles: [], timer: null, day: "", today: 0 };
export const status = () => ({
  autonomy: process.env.LATTICE_AUTONOMY === "true", running: state.running, cyclesToday: state.today,
  maxPerDay: maxPerDay(), intervalMin: intervalMin(), recent: state.cycles.slice(-10)
});
const maxPerDay = () => Math.max(0, Number(process.env.LATTICE_MAX_CYCLES_PER_DAY ?? 24) || 0);
const intervalMin = () => Math.max(5, Number(process.env.LATTICE_INTERVAL_MIN) || 30);

// Build the next topic from what the team has learned and where it struggled.
export function nextTopic(knowledge = [], recentErrors = []) {
  const k = knowledge.slice(0, 5).map(e => `- ${e.text} (${e.agent})`).join("\n");
  const errs = recentErrors.slice(-3).map(e => `- ${e.agent}: ${e.text.slice(0, 200)}`).join("\n");
  return [
    "Autonomous growth cycle. Review what the team has discovered and where it has struggled, then choose ONE concrete improvement",
    "to test or build now with your tools, carry it out, and report the result.",
    k ? `Discoveries so far:\n${k}` : "The team has no recorded discoveries yet: start by testing one capability end to end and recording what you learn.",
    errs ? `Recent failures worth investigating:\n${errs}` : "",
    "Speak in clear, complete English sentences. Add an \"EUREKA:\" line only for a genuinely new finding."
  ].filter(Boolean).join("\n\n");
}

export async function growOnce({ council, runAgent, tools, getAgent, knowledge, agents }) {
  const today = new Date().toISOString().slice(0, 10);
  if (state.day !== today) { state.day = today; state.today = 0; }
  if (state.running) return { skipped: "a growth cycle is already running" };
  if (state.today >= maxPerDay()) return { skipped: `daily limit reached (${maxPerDay()})` };
  state.running = true; state.today++;
  const startedAt = new Date().toISOString();
  const roster = (agents && agents.length >= 2 ? agents : ["grok-main", "grok-researcher"]).slice(0, 4);
  try {
    const topic = nextTopic(knowledge({ limit: 5 }), events({ kind: "error", limit: 20 }));
    record("cycle", { agent: "lattice", text: `growth cycle started with ${roster.join(", ")}`, data: { roster } });
    const out = await council({ topic, agents: roster, rounds: 1, runAgent, tools, getAgent, runId: `lattice-${Date.now().toString(36)}` });
    const c = { startedAt, endedAt: new Date().toISOString(), runId: out.runId, turns: out.dialogue?.length || 0, ok: true };
    state.cycles.push(c);
    record("cycle", { agent: "lattice", runId: out.runId, text: `growth cycle finished: ${c.turns} messages`, data: c });
    return c;
  } catch (e) {
    const c = { startedAt, endedAt: new Date().toISOString(), ok: false, error: e.message };
    state.cycles.push(c);
    record("error", { agent: "lattice", text: `growth cycle failed: ${e.message}` });
    return c;
  } finally {
    state.running = false;
    if (state.cycles.length > 100) state.cycles = state.cycles.slice(-100);
  }
}

export function startAutonomy(deps) {
  if (process.env.LATTICE_AUTONOMY !== "true" || state.timer) return false;
  state.timer = setInterval(() => { growOnce(deps).catch(() => {}); }, intervalMin() * 60_000);
  state.timer.unref?.();
  return true;
}
export function stopAutonomy() { if (state.timer) clearInterval(state.timer); state.timer = null; }
export const _state = state;   // tests
