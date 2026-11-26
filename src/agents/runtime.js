// Agent loop — one REAL agent: native tool-calls, Auto Review gate, CodeX events.
// opts: { runId, agentName, spawnDepth, resume, maxSteps }
// ctx (2nd arg to every tool.run): { agent, run: { runId }, spawnDepth }
// A tool call that needs review pauses the thread (state saved via saveHeld)
// and returns { pendingApproval } — the approve route resumes it exactly once.

import { chatRoute } from "../llm/router.js";
import { teamContext } from "./dialogue.js";
import { needsReview, createApproval, saveHeld } from "../middleware/approvals.js";
import { emit } from "./codex.js";

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

const ALWAYS = new Set(["team.say", "team.inbox", "team.knowledge", "skill.list", "skill.load",
  "node.exec", "node.service", "node.info", "node.mcp"]);   // every agent has its own node
function safeTeamContext() { try { return teamContext(); } catch { return ""; } }

export async function runAgent(agent, userMessage, tools, opts = {}) {
  const { maxSteps = 8, resume = null } = opts;
  const ctx = opts.ctx || {
    agent: opts.agentName || agent.id,
    run: { runId: opts.runId },
    spawnDepth: opts.spawnDepth ?? 0,
    nodeKey: opts.nodeKey || undefined        // spawned subagents run on their own ephemeral node
  };
  const messages = resume || [
    // every agent gets the plain-English team style + the newest team discoveries
    { role: "system", content: `${agent.systemPrompt || "You are a helpful AI teammate."}\n\n${safeTeamContext()}` },
    { role: "user", content: String(userMessage ?? "") }
  ];
  // tools: ["*"] grants the full live toolset
  // the team channel and skill playbooks are every agent's birthright, whatever its whitelist
  const available = agent.tools?.includes("*")
    ? tools
    : tools.filter(t => ALWAYS.has(t.name) || agent.tools?.includes(t.name) || agent.tools?.includes(t.name.split(".")[0]));

  for (let step = 0; step < maxSteps; step++) {
    const reply = await chatRoute(messages, available, { mode: agent.mode || "chat", model: agent.model || "" });

    if (!reply.tool_calls?.length) return reply.content;   // final answer

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
