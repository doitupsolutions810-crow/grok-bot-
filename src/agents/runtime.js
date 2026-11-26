// Agent loop — one REAL agent: native tool-calls, Auto Review gate, CodeX events.
// opts: { runId, agentName, spawnDepth, resume, maxSteps }
// ctx (2nd arg to every tool.run): { agent, run: { runId }, spawnDepth }
// A tool call that needs review pauses the thread (state saved via saveHeld)
// and returns { pendingApproval } — the approve route resumes it exactly once.

import { shortlist } from "./toolpick.js";
import { splitReasoning, mindContext } from "./mind.js";
import { chatRoute } from "../llm/router.js";
import { teamContext } from "./dialogue.js";
import { needsReview, createApproval, saveHeld } from "../middleware/approvals.js";
import { emit } from "./codex.js";
import * as lattice from "./lattice.js";

function parseArgs(call) {
  let a;
  try { a = JSON.parse(call?.function?.arguments || "{}"); } catch { a = { raw: call?.function?.arguments }; }
  // models sometimes emit "null", a bare string, or an array — tools always get an object
  return a && typeof a === "object" && !Array.isArray(a) ? a : { value: a };
}

async function execTool(available, name, args, ctx, runId) {
  const tool = available.find(t => t.name === name);
  let result;
  try { result = tool ? await tool.run(args, ctx) : { error: `unknown tool: ${name}` }; }
  catch (e) { result = { error: e.message }; }
  emit(runId, "tool.result", { agent: ctx?.agent, tool: name, ok: !result?.error });
  lattice.record("tool_result", { agent: ctx?.agent, runId, text: `${name}: ${result?.error ? "error: " + result.error : JSON.stringify(result ?? null)}`, data: { tool: name, ok: !result?.error } });
  return result;
}

// Runs a batch of tool calls; pauses on the first one that needs review, remembering the
// calls after it so the resumed thread answers every tool_call_id (OpenAI-compatible
// servers reject a history that leaves a call unanswered).
async function runCalls(agent, calls, available, messages, ctx, opts) {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const name = call?.function?.name || "";
    const args = parseArgs(call);
    emit(opts.runId, "tool.call", { agent: ctx?.agent, tool: name });
    lattice.record("tool_call", { agent: ctx?.agent, runId: opts.runId, text: name, data: { tool: name, args } });
    if (agent.review && needsReview(name, args)) {
      const id = createApproval(agent.id, name, args);
      saveHeld(id, { agent, call, rest: calls.slice(i + 1), messages, tools: available, ctx, maxSteps: opts.maxSteps });
      emit(opts.runId, "approval.pending", { agent: ctx?.agent, tool: name, id });
      return { pendingApproval: id };
    }
    const result = await execTool(available, name, args, ctx, opts.runId);
    messages.push({ role: "tool", tool_call_id: call?.id, content: JSON.stringify(result) });
  }
  return null;
}

// shell access always (owner, Nov 26): every agent gets the terminal and its own node
const ALWAYS = new Set(["team.say", "team.inbox", "team.knowledge", "skill.list", "skill.load", "terminal",
  "node.exec", "node.service", "node.info", "node.mcp",
  "harness.list", "harness.read", "harness.propose", "harness.proposals",
  "mind.think", "mind.journal", "mind.goals", "env.record", "env.state"]);   // own node + can improve its own harness
export const _always = ALWAYS;
function safeMind(id) { try { return mindContext(id); } catch { return ""; } }
function safeTeamContext() { try { return teamContext(); } catch { return ""; } }

// A tool call the model wrote into its text as JSON ({"name": "team.say", "arguments": {...}}),
// for a tool this agent is granted. Anything else is left as text.
export function inlineCall(content, available) {
  const text = String(content || "").trim();
  if (!text || text.length > 8000) return null;
  const m = text.match(/^(?:```(?:json)?\s*)?(\{[\s\S]*\})(?:\s*```)?$/);
  if (!m) return null;
  let o; try { o = JSON.parse(m[1]); } catch { return null; }
  const name = o?.name ?? o?.function?.name ?? o?.tool;
  let args = o?.arguments ?? o?.parameters ?? o?.function?.arguments ?? o?.args ?? {};
  if (typeof args === "string") { try { args = JSON.parse(args); } catch { return null; } }
  if (typeof name !== "string" || !args || typeof args !== "object" || Array.isArray(args)) return null;
  if (!available.some(t => t.name === name)) return null;
  return { id: `inline-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

// Offered tools the text says it is calling ("team.say: ...", "I'll use the team.ask function",
// "call web.search(...)") without a real call. Mentions in passing are not counted.
export function narratedTools(content, offered) {
  const text = String(content || "");
  if (!text) return [];
  const out = [];
  for (const t of offered) {
    const n = t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(\\b${n}\\s*[:(]|\\b(use|call|invoke|run)\\s+(the\\s+)?\`?${n}\`?(\\s+(function|tool))?\\b)`, "i");
    if (re.test(text)) out.push(t.name);
  }
  return out;
}

export async function runAgent(agent, userMessage, tools, opts = {}) {
  const { maxSteps = 8, resume = null } = opts;
  const ctx = opts.ctx || {
    agent: opts.agentName || agent.id,
    run: { runId: opts.runId },
    spawnDepth: opts.spawnDepth ?? 0,
    nodeKey: opts.nodeKey || undefined,       // spawned subagents run on their own ephemeral node
    envId: opts.envId || undefined            // long-horizon research environment this run works in
  };
  const messages = resume || [
    // every agent gets the plain-English team style + the newest team discoveries
    { role: "system", content: [agent.systemPrompt || "You are a helpful AI teammate.", safeTeamContext(), safeMind(opts.agentName || agent.id)].filter(Boolean).join("\n\n") },
    { role: "user", content: String(userMessage ?? "") }
  ];
  // tools: ["*"] grants the full live toolset
  // the team channel and skill playbooks are every agent's birthright, whatever its whitelist
  const available = agent.tools?.includes("*")
    ? tools
    : tools.filter(t => ALWAYS.has(t.name) || agent.tools?.includes(t.name) || agent.tools?.includes(t.name.split(".")[0]));

  // offer a small model only the tools that fit this request (all granted tools stay executable)
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content;
  const offered = shortlist(available, typeof lastUser === "string" ? lastUser : String(userMessage ?? ""));

  // the Lattice follows every agent: what it was asked, what it thinks, what it does
  if (!resume) lattice.record("prompt", { agent: ctx.agent, runId: opts.runId, text: String(userMessage ?? ""),
    data: { system: String(agent.systemPrompt || "").slice(0, 300), tools: offered.map(t => t.name), granted: available.length } });

  let nudged = false;
  for (let step = 0; step < maxSteps; step++) {
    let reply;
    try { reply = await chatRoute(messages, offered, { mode: agent.mode || "chat", model: agent.model || "" }); }
    catch (e) { lattice.record("error", { agent: ctx.agent, runId: opts.runId, text: `model call failed: ${e.message}` }); throw e; }

    // reasoning models (<think>, reasoning_content, …): show their thinking, keep it out of the answer
    const { reasoning } = splitReasoning(reply);
    if (reasoning) lattice.record("reasoning", { agent: ctx.agent, runId: opts.runId, text: reasoning });

    if (!reply.tool_calls?.length) {
      // small models often WRITE a tool call instead of making it: a JSON call in the text is
      // salvaged into a real call; a call narrated in prose gets one nudge to actually make it
      const salvaged = inlineCall(reply.content, available);
      if (salvaged) {
        reply = { ...reply, content: "", tool_calls: [salvaged] };
        lattice.record("thought", { agent: ctx.agent, runId: opts.runId, text: `(tool call written as text, run as ${salvaged.function.name})` });
      } else {
        const named = narratedTools(reply.content, offered);
        if (named.length && !nudged && step < maxSteps - 1) {
          nudged = true;
          messages.push({ role: "assistant", content: String(reply.content) },
            { role: "user", content: `You described using ${named.join(", ")} but did not call it. If you need it, call the tool now; otherwise give your final answer without describing tool calls.` });
          lattice.record("thought", { agent: ctx.agent, runId: opts.runId, text: `(nudged: described ${named.join(", ")} without calling it)` });
          continue;
        }
      }
    }
    if (!reply.tool_calls?.length) {                         // final answer
      lattice.record("answer", { agent: ctx.agent, runId: opts.runId, text: reply.content ?? "" });
      return reply.content;
    }
    if (typeof reply.content === "string" && reply.content.trim())
      lattice.record("thought", { agent: ctx.agent, runId: opts.runId, text: reply.content });

    messages.push(reply);
    emit(opts.runId, "agent.message", { agent: ctx.agent, calls: reply.tool_calls.length });
    const paused = await runCalls(agent, reply.tool_calls, available, messages, ctx, { ...opts, maxSteps });
    if (paused) return paused;
  }
  return "Reached max tool steps without a final answer.";
}

// Resume a thread paused by Auto Review. approve=false tells the agent the human said no,
// so it can adapt instead of the thread silently dying.
export async function resumeHeld(held, tools, approve) {
  const { agent, call, rest = [], messages, ctx } = held;
  const available = held.tools || tools;
  const name = call?.function?.name || "";
  const result = approve
    ? await execTool(available, name, parseArgs(call), ctx, ctx?.run?.runId)
    : { error: "rejected by human reviewer (Auto Review). Do not retry this call; choose a safer approach or explain." };
  messages.push({ role: "tool", tool_call_id: call?.id, content: JSON.stringify(result) });
  const paused = await runCalls(agent, rest, available, messages, ctx, { runId: ctx?.run?.runId, maxSteps: held.maxSteps });
  if (paused) return paused;
  return runAgent(agent, "", available, { resume: messages, ctx, runId: ctx?.run?.runId, maxSteps: held.maxSteps || 8 });
}
