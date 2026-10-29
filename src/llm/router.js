import OpenAI from "openai";
import { resolveModelChain } from "./model-chain.js";

const CHAIN = resolveModelChain();

const clients = {};
function client(model) {
  clients[model] ??= new OpenAI({
    baseURL: `${process.env.OLLAMA_URL || "http://ollama:11434"}/v1`,
    apiKey: "ollama"
  });
  return clients[model];
}

// Non-stream calls return the MESSAGE (choices[0].message) directly — that's
// what the agent loop reads (.content, .tool_calls). Streaming returns the raw
// stream for piping.
export async function chatRoute(messages, tools = [], { mode = "chat", stream = false } = {}) {
  const order = mode === "chat" ? CHAIN.slice().reverse().concat(CHAIN[0]) : CHAIN; // chat = fast-first; heavy = big-first
  let lastErr;
  for (const model of order) {
    try {
      const params = { model, messages, stream, temperature: mode === "chat" ? 0.4 : 0.2 };
      if (tools.length) params.tools = tools.map(t => ({
        type: "function", function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
      const res = await client(model).chat.completions.create(params);
      return stream ? res : res.choices[0].message;
    } catch (e) { lastErr = e; console.warn(`[llm-router] ${model} failed (${e.message}), falling back`); }
  }
  throw lastErr;
}
