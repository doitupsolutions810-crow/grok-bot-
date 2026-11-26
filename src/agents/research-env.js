// Long-horizon research environments.
//
// A research environment is a goal the team works on for hours, not one chat turn. It keeps
// its own state on disk (plan, findings with sources, open questions, a step log), survives a
// restart, and advances one step at a time: each step one agent from the roster reads the
// environment's state, works with its tools, and writes back through env.record. The
// environment ends when an agent records "done", the step budget runs out, or the horizon passes.
//
// API (router): POST /research/envs, GET /research/envs[/:id], GET /research/envs/:id/report,
//               POST /research/envs/:id/{pause|resume|stop}
// MCP (mcp-server): research_start / research_status / research_report
import fs from "node:fs";
import { join } from "node:path";
import { dataDir } from "../paths.js";
import * as lattice from "./lattice.js";

const ID_RE = /^env-[a-z0-9]{6,20}$/;
const LIMITS = { maxSteps: 500, horizonHours: 72, findings: 400, questions: 100, log: 300, text: 4000 };
const maxActive = () => Math.max(1, Number(process.env.RESEARCH_MAX_ACTIVE) || 2);
const dir = () => join(dataDir(), "research");
const file = id => join(dir(), `${id}.json`);

const loops = new Map();       // id -> { stop, wake }
let deps = null;               // { runAgent, tools, getAgent } wired at boot

const clip = (s, n = LIMITS.text) => String(s ?? "").replace(/\u0000/g, "").slice(0, n);

function save(env) {
  fs.mkdirSync(dir(), { recursive: true });
  const tmp = `${file(env.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(env, null, 2));
  fs.renameSync(tmp, file(env.id));                 // atomic: a crash mid-write never corrupts an env
  return env;
}
export function get(id) {
  if (!ID_RE.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(file(id), "utf8")); } catch { return null; }
}
export function list({ limit = 50 } = {}) {
  let names = [];
  try { names = fs.readdirSync(dir()).filter(f => /^env-[a-z0-9]+\.json$/.test(f)); } catch {}
  return names.map(f => get(f.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, Math.min(Math.max(1, Number(limit) || 50), 200))
    .map(summary);
}
const summary = e => ({ id: e.id, goal: e.goal, status: e.status, step: e.step, maxSteps: e.maxSteps,
  findings: e.findings.length, questions: e.questions.filter(q => !q.closed).length, agents: e.agents,
  createdAt: e.createdAt, deadline: e.deadline, endedReason: e.endedReason || "" });

export function validate(body) {
  const errs = [];
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : null;
  if (!b) return ["body must be a JSON object"];
  if (typeof b.goal !== "string" || b.goal.trim().length < 8) errs.push("goal must be a sentence (8+ characters)");
  else if (b.goal.length > 2000) errs.push("goal is too long (2000 characters max)");
  if (b.agents !== undefined && (!Array.isArray(b.agents) || !b.agents.length || b.agents.length > 6 || b.agents.some(a => typeof a !== "string" || !/^[\w.-]{1,80}$/.test(a))))
    errs.push("agents must be 1-6 agent ids");
  for (const [k, lo, hi] of [["maxSteps", 1, LIMITS.maxSteps], ["horizonHours", 0.01, LIMITS.horizonHours], ["stepIntervalSec", 0, 3600]])
    if (b[k] !== undefined && !(typeof b[k] === "number" && Number.isFinite(b[k]) && b[k] >= lo && b[k] <= hi)) errs.push(`${k} must be a number from ${lo} to ${hi}`);
  return errs;
}

export function create(body, { getAgent } = deps || {}) {
  const errs = validate(body);
  if (errs.length) return { error: errs.join("; ") };
  const agents = [...new Set(body.agents || ["grok-researcher", "grok-scout"])];
  if (getAgent) {
    const ghost = agents.filter(a => !getAgent(a));
    if (ghost.length) return { error: `unknown agent(s): ${ghost.join(", ")}` };
  }
  const active = list({ limit: 200 }).filter(e => e.status === "running").length;
  if (active >= maxActive()) return { error: `${active} research environments are already running (RESEARCH_MAX_ACTIVE=${maxActive()}); pause or stop one first`, busy: true };
  const now = Date.now();
  const env = {
    id: `env-${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    goal: body.goal.trim(), agents, status: "running", step: 0,
    maxSteps: Math.floor(body.maxSteps ?? 40), stepIntervalSec: body.stepIntervalSec ?? 5,
    createdAt: new Date(now).toISOString(), deadline: new Date(now + (body.horizonHours ?? 6) * 3_600_000).toISOString(),
    plan: "", findings: [], questions: [], log: [], failures: 0, endedReason: ""
  };
  save(env);
  lattice.record("cycle", { agent: "research", runId: env.id, text: `research environment ${env.id} opened: ${env.goal}`, data: { agents } });
  start(env.id);
  return { env: summary(env) };
}

// env.record: the one door through which agents change an environment's state.
export function recordEntry(id, { kind, text, sources, questionId } = {}, agent = "agent") {
  const env = get(id);
  if (!env) return { error: `no research environment ${id}` };
  if (env.status === "done" || env.status === "stopped") return { error: `environment is ${env.status}` };
  const t = clip(text).trim();
  if (!t && kind !== "close_question") return { error: "text is required" };
  const src = (Array.isArray(sources) ? sources : []).filter(s => typeof s === "string" && /^https?:\/\//.test(s)).slice(0, 10).map(s => clip(s, 500));
  switch (kind) {
    case "finding": {
      if (env.findings.some(f => f.text.toLowerCase() === t.toLowerCase())) return { ok: true, duplicate: true };
      env.findings.push({ n: env.findings.length + 1, text: t, sources: src, agent, step: env.step, at: new Date().toISOString() });
      if (env.findings.length > LIMITS.findings) env.findings = env.findings.slice(-LIMITS.findings);
      lattice.record("eureka", { agent, runId: id, text: `Research finding: ${t}`, data: { sources: src } });
      break;
    }
    case "question":
      if (env.questions.filter(q => !q.closed).length >= LIMITS.questions) return { error: "too many open questions; close some first" };
      env.questions.push({ id: env.questions.length + 1, text: t, agent, closed: false });
      break;
    case "close_question": {
      const q = env.questions.find(q => q.id === Number(questionId));
      if (!q) return { error: `no question ${questionId}` };
      q.closed = true; q.answer = t;
      break;
    }
    case "plan": env.plan = t; break;
    case "done": env.status = "done"; env.endedReason = `concluded by ${agent}: ${t}`; break;
    default: return { error: "kind must be finding, question, close_question, plan, or done" };
  }
  save(env);
  return { ok: true, findings: env.findings.length, openQuestions: env.questions.filter(q => !q.closed).length, status: env.status };
}

export function brief(env) {
  const open = env.questions.filter(q => !q.closed);
  return [
    `You are working inside long-horizon research environment ${env.id} (step ${env.step + 1} of at most ${env.maxSteps}).`,
    `Goal: ${env.goal}`,
    env.plan ? `Current plan:\n${env.plan}` : "There is no plan yet: write one with env.record kind \"plan\" first.",
    env.findings.length ? `Latest findings (${env.findings.length} total):\n${env.findings.slice(-8).map(f => `${f.n}. ${f.text}${f.sources.length ? ` [${f.sources.join(", ")}]` : ""}`).join("\n")}` : "No findings yet.",
    open.length ? `Open questions:\n${open.slice(0, 8).map(q => `#${q.id} ${q.text}`).join("\n")}` : "",
    "Do one focused piece of work toward the goal with your tools (search, scrape, read code on GitHub, run code).",
    "Record every verified fact with env.record kind \"finding\" and its source URLs, raise new questions with kind \"question\", and close answered ones with kind \"close_question\".",
    "When the goal is fully answered, record kind \"done\" with a one-paragraph conclusion. Write in clear, complete English sentences."
  ].filter(Boolean).join("\n\n");
}

export async function stepOnce(id) {
  const env = get(id);
  if (!env || env.status !== "running") return { skipped: true };
  if (env.step >= env.maxSteps) return finish(env, "step budget used up");
  if (Date.now() > Date.parse(env.deadline)) return finish(env, "horizon reached");
  const agentId = env.agents[env.step % env.agents.length];
  const agent = deps?.getAgent?.(agentId);
  const started = Date.now();
  let outcome;
  try {
    if (!agent) throw new Error(`agent ${agentId} no longer exists`);
    const answer = await deps.runAgent(agent, brief(env), deps.tools, { runId: `${env.id}-s${env.step + 1}`, agentName: agentId, envId: env.id, maxSteps: 10 });
    outcome = { ok: true, text: clip(typeof answer === "string" ? answer : JSON.stringify(answer), 600) };
  } catch (e) { outcome = { ok: false, text: clip(e.message, 600) }; }
  const fresh = get(id) || env;               // the agent may have written through env.record meanwhile
  fresh.step++;
  fresh.failures = outcome.ok ? 0 : (fresh.failures || 0) + 1;
  fresh.log.push({ step: fresh.step, agent: agentId, ok: outcome.ok, ms: Date.now() - started, summary: outcome.text });
  if (fresh.log.length > LIMITS.log) fresh.log = fresh.log.slice(-LIMITS.log);
  if (fresh.failures >= 3) { fresh.status = "paused"; fresh.endedReason = `paused after 3 failed steps in a row: ${outcome.text}`; }
  save(fresh);
  lattice.record("cycle", { agent: "research", runId: id, text: `${id} step ${fresh.step} by ${agentId}: ${outcome.ok ? "ok" : "failed"}` });
  return { step: fresh.step, ok: outcome.ok, status: fresh.status };
}

function finish(env, reason) {
  env.status = "done"; env.endedReason = env.endedReason || reason;
  save(env);
  lattice.record("cycle", { agent: "research", runId: env.id, text: `${env.id} finished: ${env.endedReason}` });
  return { done: true, reason: env.endedReason };
}

export function start(id) {
  if (!deps || loops.has(id)) return false;
  const loop = { stop: false, wake: null };
  loops.set(id, loop);
  (async () => {
    try {
      while (!loop.stop) {
        const r = await stepOnce(id);
        if (r.skipped || r.done || r.status !== "running") break;
        const env = get(id);
        await new Promise(res => { loop.wake = res; const t = setTimeout(res, (env?.stepIntervalSec ?? 5) * 1000); t.unref?.(); });
      }
    } catch (e) {
      lattice.record("error", { agent: "research", runId: id, text: `research loop crashed: ${e.message}` });
    } finally { loops.delete(id); }
  })();
  return true;
}

export function control(id, action) {
  const env = get(id);
  if (!env) return { error: `no research environment ${id}`, status: 404 };
  const loop = loops.get(id);
  if (action === "pause" || action === "stop") {
    if (env.status === "done" || env.status === "stopped") return { error: `environment is already ${env.status}`, status: 409 };
    env.status = action === "pause" ? "paused" : "stopped";
    if (action === "stop") env.endedReason = "stopped by owner";
    save(env);
    if (loop) { loop.stop = true; loop.wake?.(); }
    return { env: summary(env) };
  }
  if (action === "resume") {
    if (env.status !== "paused") return { error: `only a paused environment can resume (it is ${env.status})`, status: 409 };
    const active = list({ limit: 200 }).filter(e => e.status === "running").length;
    if (active >= maxActive()) return { error: `too many running environments (${active})`, status: 429 };
    env.status = "running"; env.failures = 0; env.endedReason = "";
    if (Date.now() > Date.parse(env.deadline)) env.deadline = new Date(Date.now() + 3_600_000).toISOString();   // a fresh hour
    save(env);
    start(id);
    return { env: summary(env) };
  }
  return { error: "action must be pause, resume, or stop", status: 400 };
}

export function report(id) {
  const env = get(id);
  if (!env) return null;
  const open = env.questions.filter(q => !q.closed), closed = env.questions.filter(q => q.closed);
  return [
    `# ${env.goal}`, "",
    `Environment ${env.id}: ${env.status}, ${env.step} of ${env.maxSteps} steps, agents ${env.agents.join(", ")}.${env.endedReason ? ` ${env.endedReason}.` : ""}`, "",
    env.plan ? `## Plan\n\n${env.plan}\n` : "",
    `## Findings (${env.findings.length})\n`, ...env.findings.map(f => `${f.n}. ${f.text} (${f.agent}, step ${f.step + 1})${f.sources.length ? `\n   Sources: ${f.sources.join(", ")}` : ""}`), "",
    closed.length ? `## Answered questions\n\n${closed.map(q => `- ${q.text}\n  ${q.answer}`).join("\n")}\n` : "",
    open.length ? `## Open questions\n\n${open.map(q => `- #${q.id} ${q.text}`).join("\n")}\n` : ""
  ].filter(s => s !== "").join("\n");
}

// Agents' tools. ctx.envId is set when the run belongs to an environment; otherwise they name one.
export function envTools() {
  return [
    {
      name: "env.record",
      description: "Write to a long-horizon research environment: kind finding (with source URLs), question, close_question (questionId + answer text), plan, or done (conclusion).",
      parameters: { type: "object", properties: {
        kind: { type: "string", enum: ["finding", "question", "close_question", "plan", "done"] },
        text: { type: "string" }, sources: { type: "array", items: { type: "string" } },
        questionId: { type: "number" }, env: { type: "string", description: "environment id (defaults to the one you are working in)" } },
        required: ["kind", "text"] },
      async run(args = {}, ctx = {}) {
        const id = ctx.envId || args.env;
        if (!id) return { error: "you are not inside a research environment; pass env" };
        return recordEntry(id, args, ctx.agent || "agent");
      }
    },
    {
      name: "env.state",
      description: "Read a research environment's goal, plan, findings and open questions.",
      parameters: { type: "object", properties: { env: { type: "string" } } },
      async run(args = {}, ctx = {}) {
        const env = get(ctx.envId || args.env);
        return env ? { ...summary(env), plan: env.plan, findings: env.findings.slice(-20), questions: env.questions.filter(q => !q.closed) } : { error: "no such environment" };
      }
    }
  ];
}

// Boot: wire dependencies and pick up environments that were running before a restart.
export function init(d) {
  deps = d;
  let resumed = 0;
  for (const e of list({ limit: 200 })) if (e.status === "running" && start(e.id)) resumed++;
  return resumed;
}
export function _reset() { for (const l of loops.values()) { l.stop = true; l.wake?.(); } loops.clear(); deps = null; }
export const _loops = loops;
