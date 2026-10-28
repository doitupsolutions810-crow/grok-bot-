import Docker from "dockerode";

const REQUIRED_IMAGES = [
  "ollama/ollama:latest",
  "mcr.microsoft.com/playwright:v1.47.0-jammy",
  "ubuntu:24.04"
];
// Env-driven model set: MODELS_REQUIRED drives both preinstall and teammate
// validation, so CI (llama3.2:1b) and prod (your GPU models) diverge cleanly.
const REQUIRED_MODELS = (process.env.MODELS_REQUIRED || `${process.env.LLM_MODEL || "llama3.1:8b"},nomic-embed-text`)
  .split(",").map(s => s.trim()).filter(Boolean);
if (process.env.ENABLE_VISION === "true") REQUIRED_MODELS.push("llava:7b");

export async function preinstall(docker, { log = console.log } = {}) {
  // 1. Pull required images (idempotent — no-op if already present)
  for (const image of REQUIRED_IMAGES) {
    await pullImage(docker, image, log);
  }

  // 2. Pull required models into Ollama (idempotent)
  const ollama = process.env.OLLAMA_URL || "http://ollama:11434";
  for (const model of REQUIRED_MODELS) {
    const tags = await fetch(`${ollama}/api/tags`).then(r => r.json()).catch(() => ({ models: [] }));
    if (tags.models?.some(m => m.name === model)) { log(`[boot] model present: ${model}`); continue; }
    log(`[boot] pulling model ${model}...`);
    await fetch(`${ollama}/api/pull`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false })
    });
    log(`[boot] model ready: ${model}`);
  }

  // 3. Wait for every sidecar to be genuinely reachable
  await waitForHttp(`${ollama}/api/tags`, log, "ollama");
  await waitForHttp(process.env.COMFYUI_URL || "http://comfyui:8188", log, "comfyui", { optional: true });
  return true;
}

function pullImage(docker, image, log) {
  return new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, err2 => {
        log(`[boot] image ready: ${image}`);
        err2 ? reject(err2) : resolve(true);
      });
    });
  });
}

async function waitForHttp(url, log, name, { timeout = 120_000, optional = false } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status < 500) { log(`[boot] ${name} reachable`); return true; }
    } catch {}
    await new Promise(r => setTimeout(r, 2000));
  }
  if (optional) { log(`[boot] ${name} not reachable — feature degraded, continuing`); return false; }
  throw new Error(`${name} did not become reachable at ${url}`);
}
