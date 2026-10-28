// The concluding system bridge: Grok Bot agents delegate whole tasks to the
// AVRONE system. AVRONE runs its own squad (plan → parallel workers with real
// tools → lead merge; mode "deep" adds adversarial review waves) and returns
// one merged answer. No new code on the AVRONE side — this calls its plain
// /api/chat. Enable by pointing AVRONE_URL at the AVRONE server.
const AVRONE_URL = (process.env.AVRONE_URL || "").replace(/\/+$/, "");

export const avroneTool = {
  name: "avrone.squad",
  description:
    "Delegate a whole task to the AVRONE system — an independent agent squad " +
    "(plan, parallel workers with real tools, lead merge; deep mode adds " +
    "adversarial review waves). Use for heavy research or multi-step work that " +
    "benefits from a second team; returns their merged answer.",
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
    if (!AVRONE_URL) {
      return { error: "AVRONE_URL not set — point it at the AVRONE server " +
        "(e.g. http://host.docker.internal:8710) to enable the system bridge" };
    }
    const mode = args.mode === "deep" ? "deep" : "squad";
    try {
      const res = await fetch(`${AVRONE_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: prompt, mode })
      });
      if (!res.ok) return { error: `AVRONE ${mode} failed: HTTP ${res.status}` };
      const out = await res.json();
      return { ok: true, mode, runId: out.run_id, answer: out.answer ?? out };
    } catch (e) {
      return { error: `AVRONE unreachable at ${AVRONE_URL}: ${e.message}` };
    }
  }
};
