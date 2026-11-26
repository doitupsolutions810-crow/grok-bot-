// Grok Imagine/Aurora equivalent: local image generation via a ComfyUI
// container running Stable Diffusion / SDXL / Flux weights.
export const imagegenTool = {
  name: "imagegen",
  description: "Generate an image from a text prompt using the local Stable Diffusion (ComfyUI) container.",
  parameters: {
    type: "object",
    properties: { prompt: { type: "string" }, negative: { type: "string" } },
    required: ["prompt"]
  },
  async run({ prompt, negative = "" } = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) return { error: "prompt required" };
    prompt = prompt.slice(0, 2000);
    negative = typeof negative === "string" ? negative.slice(0, 2000) : "";
    const base = process.env.COMFYUI_URL || "http://comfyui:8188";
    // Queue a minimal txt2img workflow (ComfyUI API format)
    const workflow = {
      "3": { class_type: "KSampler", inputs: { seed: Math.floor(Math.random() * 1e9), steps: 25, cfg: 7, sampler_name: "euler_ancestral", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["6", 0], negative: ["7", 0], latent_image: ["5", 0] } },
      "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: process.env.SD_CHECKPOINT || "sd_xl_base_1.0.safetensors" } },
      "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["4", 1] } },
      "7": { class_type: "CLIPTextEncode", inputs: { text: negative || "low quality, watermark", clip: ["4", 1] } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
      "9": { class_type: "SaveImage", inputs: { filename_prefix: "grokbot", images: ["8", 0] } }
    };
    const queued = await fetch(`${base}/prompt`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: workflow }), signal: AbortSignal.timeout(15_000)
    });
    const body = await queued.json().catch(() => ({}));
    const prompt_id = body?.prompt_id;
    // a rejected workflow (missing checkpoint, bad node) used to poll /history/undefined for 2 min
    if (!queued.ok || !prompt_id) return { error: `ComfyUI rejected the job (${queued.status}): ${JSON.stringify(body?.error || body).slice(0, 300)}` };

    // Poll history for the output image
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const hist = await fetch(`${base}/history/${encodeURIComponent(prompt_id)}`).then(r => r.json()).catch(() => ({}));
      const entry = hist?.[prompt_id];
      if (entry?.outputs) {
        const img = Object.values(entry.outputs).flatMap(o => o.images || [])[0];
        if (img) return { image: `/api/images/${img.filename}`, subfolder: img.subfolder, prompt_id };
      }
    }
    return { error: "generation timed out" };
  }
};
