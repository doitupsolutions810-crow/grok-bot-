export const visionTool = {
  name: "vision",
  description: "Analyze an image (base64) and answer questions about it.",
  parameters: {
    type: "object",
    properties: { imageBase64: { type: "string" }, question: { type: "string" } },
    required: ["imageBase64"]
  },
  async run({ imageBase64, question = "Describe this image." }) {
    const r = await fetch(`${process.env.OLLAMA_URL || "http://ollama:11434"}/api/generate`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "llava:7b",
        prompt: question,
        images: [imageBase64],
        stream: false
      })
    }).then(r => r.json());
    return r.response;
  }
};
