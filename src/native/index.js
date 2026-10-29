// Native mode (GROK_NATIVE=true): run Grok Bot on a plain host with NO Docker.
// The Docker path is untouched and remains the default. Native mode swaps the
// three Docker-bound subsystems for honest local equivalents:
//   - terminal sandbox : a per-agent directory under GROK_NATIVE_WORKSPACE, commands run with `sh -lc`
//   - shared browser   : a local headless Chromium launched via Playwright (persistent profile)
//   - docker handle    : a minimal stub so /api/docker/containers and self-tests report truthfully
// It is NOT isolated like the container sandbox, so the boot log says so loudly.
import path from "node:path";
import fs from "node:fs";

export const isNative = () => String(process.env.GROK_NATIVE || "").toLowerCase() === "true";

export const nativeWorkspace = () =>
  path.resolve(process.env.GROK_NATIVE_WORKSPACE || "./data/native-workspace");

export const nativeProfileDir = () =>
  path.resolve(process.env.GROK_NATIVE_BROWSER_PROFILE || "./data/browser-profile");

export function nativeDocker() {
  return {
    native: true,
    async listContainers() { return []; },
    async info() { return { Name: "native-host", Containers: 0, ServerVersion: "n/a" }; }
  };
}

export async function ollamaUp(base) {
  try { return (await fetch(`${base}/api/tags`)).ok; } catch { return false; }
}

// Native boot: no daemon, no images. Verify Ollama and create the workspace.
export async function bootNative({ log = console.log } = {}) {
  log("[boot] GROK_NATIVE=true — running WITHOUT Docker. The terminal runs directly on this host (not container-isolated).");
  fs.mkdirSync(path.join(nativeWorkspace(), "agents"), { recursive: true });
  const base = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const deadline = Date.now() + 120_000;
  while (!(await ollamaUp(base))) {
    if (Date.now() > deadline) throw new Error(`ollama did not become reachable at ${base} within 2 min`);
    await new Promise(r => setTimeout(r, 2000));
  }
  log(`[boot] ollama reachable at ${base}; workspace ${nativeWorkspace()}`);
  return nativeDocker();
}
