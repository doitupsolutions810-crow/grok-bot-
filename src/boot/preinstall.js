import Docker from "dockerode";

const REQUIRED_IMAGES = [
  "ollama/ollama:latest",
  "mcr.microsoft.com/playwright:v1.64.1-jammy",
  "ubuntu:24.04"
];
// Env-driven model set: MODELS_REQUIRED drives both preinstall and teammate
// validation, so CI (qwen2.5:3b) and prod (your GPU models) diverge cleanly.
const REQUIRED_MODELS = (process.env.MODELS_REQUIRED || `${process.env.LLM_MODEL || "llama3.1:8b"},nomic-embed-text`)
  .split(",").map(s => s.trim()).filter(Boolean);
if (process.env.ENABLE_VISION === "true") REQUIRED_MODELS.push("llava:7b");

// A slow first model pull (qwen2.5:3b is ~1.9 GB) must not race the LLM
// self-test — the boot waits until Ollama genuinely lists every model.
const MODEL_PULL_TIMEOUT_MS = 15 * 60_000;

export async function preinstall(docker, { log = console.log } = {}) {
  // 1. Pull required images — SKIP any image already present locally, so a
  //    flaky registry round-trip can never block a boot that has what it needs.
  for (const image of REQUIRED_IMAGES) {
    await pullImage(docker, image, log);
  }

  // 2. Pull required models and WAIT until each is listed in /api/tags.
  const ollama = process.env.OLLAMA_URL || "http://ollama:11434";
  for (const model of REQUIRED_MODELS) {
    await pullModel(ollama, model, log);
  }

  // 3. Wait for every sidecar to be genuinely reachable
  await waitForHttp(`${ollama}/api/tags`, log, "ollama");
  await waitForHttp(process.env.COMFYUI_URL || "http://comfyui:8188", log, "comfyui", { optional: true });
  return true;
}

function pullImage(docker, image, log) {
  return docker.getImage(image).inspect()
    .then(() => { log(`[boot] image present: ${image}`); return true; })
    .catch(() => new Promise((resolve, reject) => {
      docker.pull(image, (err, stream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, err2 => {
          log(`[boot] image ready: ${image}`);
          err2 ? reject(err2) : resolve(true);
        });
      });
    }));
}

async function modelPresent(ollama, model) {
  const tags = await fetch(`${ollama}/api/tags`).then(r => r.json()).catch(() => ({ models: [] }));
  return !!tags.models?.some(m => m.name === model);
}

async function pullModel(ollama, model, log) {
  if (await modelPresent(ollama, model)) { log(`[boot] model present: ${model}`); return true; }
  log(`[boot] pulling model ${model}...`);
  await fetch(`${ollama}/api/pull`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false })
  }).catch(() => { /* the poll below is the source of truth, not the POST */ });
  const deadline = Date.now() + MODEL_PULL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await modelPresent(ollama, model)) { log(`[boot] model ready: ${model}`); return true; }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error(`model ${model} did not become ready within ${MODEL_PULL_TIMEOUT_MS / 60000} min — check ollama storage or network`);
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
