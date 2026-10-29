// Agent loop — one REAL agent: native tool-calls, Auto Review gate, CodeX events.
// opts: { runId, agentName, spawnDepth, resume, maxSteps }
// ctx (2nd arg to every tool.run): { agent, run: { runId }, spawnDepth }
// A tool call that needs review pauses the thread (state saved via saveHeld)
// and returns { pendingApproval } — the approve route resumes it exactly once.

import { chatRoute } from "../llm/router.js";
import { needsReview, createApproval, saveHeld } from "../middleware/approvals.js";
import { emit } from "./codex.js";
import { summarizeToolResult } from "./tool-trace.js";
export async function runAgent(agent, userMessage, tools, opts = {}) {
  const { maxSteps = 8, resume = null } = opts;
  const ctx = {
    agent: opts.agentName || agent.id,
    run: { runId: opts.runId },
    spawnDepth: opts.spawnDepth ?? 0
  };
  const messages = resume || [
    { role: "system", content: agent.systemPrompt },
    { role: "user", content: userMessage }
  ];
  // tools: ["*"] grants the full live toolset
  const available = agent.tools?.includes("*")
    ? tools
    : tools.filter(t => agent.tools?.includes(t.name) || agent.tools?.includes(t.name.split(".")[0]));

  for (let step = 0; step < maxSteps; step++) {
    const reply = await chatRoute(messages, available, { mode: agent.mode || "chat" });

    if (!reply.tool_calls?.length) return reply.content;   // final answer

    messages.push(reply);
    emit(opts.runId, "agent.message", { agent: ctx.agent, calls: reply.tool_calls.length });

    for (const call of reply.tool_calls) {
      const name = call.function.name;
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(call.function.arguments || "{}"); } catch { parsedArgs = { raw: call.function.arguments }; }
      emit(opts.runId, "tool.call", { agent: ctx.agent, tool: name });

      // Auto Review: dangerous calls pause the thread for a human decision
      if (agent.review && needsReview(name, parsedArgs)) {
        const id = createApproval(agent.id, name, parsedArgs);
        saveHeld(id, { agent, call, messages, tools, ctx });
        emit(opts.runId, "approval.pending", { agent: ctx.agent, tool: name, id });
        return { pendingApproval: id };
      }

      const tool = available.find(t => t.name === name);
      let result;
      try {
        result = tool ? await tool.run(parsedArgs, ctx) : { error: `unknown tool: ${name}` };
      } catch (e) {
        result = { error: e.message };
      }
      emit(opts.runId, "tool.result", { agent: ctx.agent, tool: name, ...summarizeToolResult(result) });
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return "Reached max tool steps without a final answer.";
}
