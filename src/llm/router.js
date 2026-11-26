import OpenAI from "openai";

const PARSED = String(process.env.MODEL_CHAIN || "").split(",").map(s => s.trim()).filter(Boolean);
// MODEL_CHAIN=" , " used to leave an empty chain and chatRoute threw `undefined`
const CHAIN = PARSED.length
  ? PARSED
  : [
      process.env.LLM_MODEL || "llama3.1:8b",   // primary
      "llama3.2:3b",                             // fallback 1 (smaller, always loadable)
      "llama3.2:1b"                              // last resort
    ];

// A model the backend says it doesn't have is skipped for a while instead of being retried
// on every call. Seen live: each chat turn first tried llama3.2:1b and llama3.2:3b (both 404)
// before reaching the configured model.
const MISSING_MS = Number(process.env.MODEL_MISSING_TTL_MS) || 10 * 60_000;
const missing = new Map();
export const _missing = missing;
const isMissing = m => { const t = missing.get(m); if (t && Date.now() - t < MISSING_MS) return true; missing.delete(m); return false; };
const notFound = e => e?.status === 404 || /model .{0,80}not found|404/i.test(String(e?.message));

const RETRIES = Math.max(0, Number(process.env.MODEL_TRANSIENT_RETRIES ?? 2) || 0);
const RETRY_MS = Math.max(0, Number(process.env.MODEL_RETRY_MS ?? 2000));
export const transient = e => {
  const st = Number(e?.status);
  if (st === 404 || (st >= 400 && st < 500 && st !== 408 && st !== 429)) return false;
  return st >= 500 || st === 408 || st === 429 ||
    /terminated|signal: killed|ECONNRESET|ECONNREFUSED|socket hang up|EPIPE|timed? ?out|Connection error/i.test(String(e?.message));
};

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
export async function chatRoute(messages, tools = [], { mode = "chat", stream = false, model: preferred = "" } = {}) {
  const base = mode === "chat" ? CHAIN.slice().reverse() : CHAIN.slice(); // chat = fast-first; heavy = big-first
  // An agent's own model goes first; the chain stays as fallback. De-duplicated.
  const all = [...new Set([preferred, ...base].filter(Boolean))];
  const order = all.filter(m => !isMissing(m));
  if (!order.length) order.push(...all);   // everything marked missing: try again rather than fail blind
  let lastErr, realErr;
  for (const model of order) {
   for (let attempt = 0; ; attempt++) {
    try {
      const params = { model, messages, stream, temperature: mode === "chat" ? 0.4 : 0.2 };
      if (tools.length) params.tools = tools.map(t => ({
        type: "function", function: { name: t.name, description: t.description, parameters: t.parameters }
      }));
      const res = await client(model).chat.completions.create(params);
      if (stream) return res;
      const msg = res?.choices?.[0]?.message;
      // an empty/garbled completion is a failure of this model — try the next one
      if (!msg) throw new Error("empty completion (no choices)");
      return msg;
    } catch (e) {
      lastErr = e;
      if (notFound(e)) missing.set(model, Date.now()); else realErr ??= e;
      // the backend's model runner died (OOM kill, crash) or the connection dropped: Ollama
      // restarts the runner on the next request, so retry this model before moving on
      if (!stream && attempt < RETRIES && transient(e)) {
        console.warn(`[llm-router] ${model} transient failure (${e.message}), retry ${attempt + 1}/${RETRIES}`);
        await new Promise(r => setTimeout(r, RETRY_MS * (attempt + 1)));
        continue;
      }
      console.warn(`[llm-router] ${model} failed (${e.message}), falling back`);
    }
    break;
   }
  }
  // report the failure that matters: a model that exists and broke, not the last fallback's 404
  throw realErr || lastErr || new Error("no models configured");
}
