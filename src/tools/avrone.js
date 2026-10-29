const MAX_PROMPT_CHARS = 8000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 180000;

function configuredOrigin(value) {
  const raw = String(value || "").trim();
  if (!raw) return { error: "AVRONE_URL not set — the system bridge is disabled." };
  let url;
  try { url = new URL(raw); }
  catch { return { error: "AVRONE_URL must be a valid HTTP(S) origin." }; }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname ||
      url.username || url.password || !["", "/"].includes(url.pathname) ||
      url.search || url.hash) {
    return { error: "AVRONE_URL must be an HTTP(S) origin without credentials, path, query, or fragment." };
  }
  return { origin: url.origin };
}

async function readBoundedText(response, limit = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error("AVRONE response exceeded the 64 KiB limit.");
  }
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        total += item.value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => {});
          throw new Error("AVRONE response exceeded the 64 KiB limit.");
        }
        chunks.push(Buffer.from(item.value));
      }
      return Buffer.concat(chunks, total).toString("utf8");
    } finally {
      reader.releaseLock?.();
    }
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > limit) {
    throw new Error("AVRONE response exceeded the 64 KiB limit.");
  }
  return text;
}

export function createAvroneTool({
  getBaseUrl = () => process.env.AVRONE_URL,
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  return {
    name: "avrone.squad",
    description:
      "Delegate a complete task to AVRONE's independent agent squad. Returns its merged answer and run receipt. Use for multi-step work that benefits from independent agents.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The complete, self-contained task for AVRONE's squad" },
        mode: { type: "string", enum: ["squad", "deep"], description: "squad (default) or deep (adds adversarial review waves)" }
      },
      required: ["prompt"]
    },
    async run(args = {}) {
      const prompt = String(args.prompt || "").trim();
      if (!prompt) return { error: "prompt required" };
      if (prompt.length > MAX_PROMPT_CHARS) {
        return { error: "prompt exceeds the 8000-character limit." };
      }

      const configured = configuredOrigin(getBaseUrl());
      if (configured.error) return { error: configured.error };
      const mode = args.mode === "deep" ? "deep" : "squad";
      const safeTimeout = Math.max(1000, Math.min(300000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
      let response;
      try {
        response = await fetchImpl(configured.origin + "/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ message: prompt, mode }),
          redirect: "manual",
          signal: AbortSignal.timeout(safeTimeout)
        });
      } catch (error) {
        const reason = error?.name === "TimeoutError" || error?.name === "AbortError"
          ? "request timed out"
          : "service unreachable";
        return { error: "AVRONE " + mode + " bridge " + reason + "." };
      }

      if (response.status >= 300 && response.status < 400) {
        return { error: "AVRONE " + mode + " bridge refused HTTP redirect (" + response.status + ")." };
      }
      if (!response.ok) {
        return { error: "AVRONE " + mode + " bridge failed: HTTP " + response.status + "." };
      }

      let raw;
      try { raw = await readBoundedText(response); }
      catch (error) {
        return { error: "AVRONE " + mode + " bridge response rejected: " + error.message };
      }

      let out;
      try { out = JSON.parse(raw); }
      catch { return { error: "AVRONE bridge returned invalid JSON." }; }

      const runId = out && typeof out.run_id === "string" ? out.run_id.trim() : "";
      const answer = out && typeof out.answer === "string" ? out.answer.trim() : "";
      if (!runId) return { error: "AVRONE bridge response omitted its run_id receipt." };
      if (!answer) return { error: "AVRONE bridge response omitted a textual answer." };

      return {
        ok: true,
        mode,
        runId,
        answer: answer.slice(0, 12000),
        truncated: answer.length > 12000
      };
    }
  };
}

export const avroneTool = createAvroneTool();
