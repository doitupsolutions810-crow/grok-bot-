export const visionTool = {
  name: "vision",
  description: "Analyze an image (base64) and answer questions about it.",
  parameters: {
    type: "object",
    properties: { imageBase64: { type: "string" }, question: { type: "string" } },
    required: ["imageBase64"]
  },
  async run({ imageBase64, question = "Describe this image." } = {}) {
    if (typeof imageBase64 !== "string" || !imageBase64.trim()) return { error: "imageBase64 required" };
    // accept data URLs from browsers/clipboards: Ollama wants the bare base64
    imageBase64 = imageBase64.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(imageBase64)) return { error: "imageBase64 is not valid base64" };
    if (typeof question !== "string" || !question.trim()) question = "Describe this image.";
    const resp = await fetch(`${process.env.OLLAMA_URL || "http://ollama:11434"}/api/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: process.env.VISION_MODEL || "llava:7b",
        prompt: question,
        images: [imageBase64],
        stream: false
      }),
      signal: AbortSignal.timeout(180_000)
    });
    const r = await resp.json().catch(() => ({}));
    if (!resp.ok || typeof r.response !== "string") return { error: `vision model failed (${resp.status}): ${r.error || "no response"}` };
    return r.response;
  }
};
