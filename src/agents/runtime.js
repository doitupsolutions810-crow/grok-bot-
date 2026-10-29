// Agent loop — one REAL agent: native tool-calls, Auto Review gate, CodeX events.
// opts: { runId, agentName, spawnDepth, resume, maxSteps }
// ctx (2nd arg to every tool.run): { agent, run: { runId }, spawnDepth }
// A tool call that needs review pauses the thread (state saved via saveHeld)
// and returns { pendingApproval } — the approve route resumes it exactly once.

import { chatRoute } from "../llm/router.js";
import { needsReview, createApproval, saveHeld } from "../middleware/approvals.js";
import { emit } from "./codex.js";
function safeToolTraceText(value, cap = 1200) {
  return String(value ?? "")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|password|secret|authorization|cookie|private[_ -]?key)(\s*[:=]\s*)(["']?)[^\s"',;]+/gi, "$1$2[REDACTED]")
    .slice(0, cap);
}

function summarizeToolResult(result) {
  if (result && typeof result === "object") {
    const ok = typeof result.ok === "boolean" ? result.ok : !result.error;
    const output = [result.stdout, result.stderr, result.output]
      .filter(value => typeof value === "string" && value.length)
      .join("\n");
    return {
      ok,
      output_excerpt: safeToolTraceText(output, 1200),
      output_chars: output.length,
      error_excerpt: result.error ? safeToolTraceText(result.error, 500) : null
    };
  }
  if (typeof result === "string") {
    const failed = /^\s*ERROR:/i.test(result);
    return {
      ok: !failed,
      output_excerpt: failed ? safeToolTraceText(result, 500) : "",
      output_chars: result.length,
      error_excerpt: failed ? safeToolTraceText(result, 500) : null
    };
  }
  return { ok: true, output_excerpt: "", output_chars: 0, error_excerpt: null };
}


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
