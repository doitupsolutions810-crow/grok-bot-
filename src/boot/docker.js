import Docker from "dockerode";

// Connects to the real Docker daemon at boot — directly via socket, or through
// the socket proxy when DOCKER_HOST is set (the hardened deployment path).
function dockerOpts() {
  const h = process.env.DOCKER_HOST;
  if (h && h.startsWith("tcp://")) {
    const u = new URL(h);
    return { protocol: "tcp", host: u.hostname, port: Number(u.port || 2375) };
  }
  if (h && h.startsWith("http")) {
    const u = new URL(h);
    return { protocol: "http", host: u.hostname, port: Number(u.port || 2375) };
  }
  return { socketPath: "/var/run/docker.sock" };
}

export async function bootDocker({ log = console.log } = {}) {
  const docker = new Docker(dockerOpts());

  // 1. Verify the daemon is reachable
  const info = await docker.info();
  log(`[boot] Docker connected: ${info.Name}, ${info.Containers} containers, v${info.ServerVersion}`);

  // 2. Ensure the LLM backend is up and the model exists
  await ensureModel(process.env.LLM_MODEL || "llama3.1:8b", log);

  // 3. Ensure the sandbox terminal container exists (personal terminal tool)
  await ensureSandbox(docker, log);

  // 4. Launch agent plugin containers declared in config (MCP sidecars)
  await ensurePlugins(docker, log);

  return docker;
}

async function ensureModel(model, log) {
  const base = process.env.OLLAMA_URL || "http://ollama:11434";
  const list = await fetch(`${base}/api/tags`).then(r => r.json());
  if (!list.models?.some(m => m.name === model)) {
    log(`[boot] Pulling model ${model} (one-time, may take a while)...`);
    await fetch(`${base}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false })
    });
  }
  log(`[boot] Model ready: ${model}`);
}

async function ensureSandbox(docker, log) {
  const name = "grok-sandbox";
  const containers = await docker.listContainers({ all: true });
  const existing = containers.find(c => c.Names.includes(`/${name}`));
  if (!existing) {
    // Hardened sandbox: no caps, no new privileges, pids/tmp limits, and the
    // shared grok_workspace NAMED volume (container paths don't work in Binds —
    // they resolve on the HOST, so we use a named volume managed by Docker).
    await docker.createContainer({
      name,
      Image: "ubuntu:24.04",
      Cmd: ["sleep", "infinity"],
      HostConfig: {
        AutoRemove: false,
        CapDrop: ["ALL"],
        CapAdd: ["CHOWN", "SETUID", "SETGID"],
        SecurityOpt: ["no-new-privileges:true"],
        Memory: 512 * 1024 * 1024,
        PidsLimit: 256,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
        Binds: ["grok_workspace:/workspace:rw"]
      }
    }).then(c => c.start());
    log(`[boot] Created hardened terminal sandbox: ${name} (workspace: grok_workspace volume)`);
  } else if (existing.State !== "running") {
    await docker.getContainer(existing.Id).start().catch(() => {});
    log(`[boot] Resumed terminal sandbox: ${name}`);
  }
}

async function ensurePlugins(docker, log) {
  // Plugin containers let agents run MCP servers or extra tools in isolation.
  const plugins = JSON.parse(process.env.AGENT_PLUGINS || "[]");
  for (const p of plugins) {
    const containers = await docker.listContainers({ all: true });
    if (containers.some(c => c.Names.includes(`/${p.name}`))) continue;
    await docker.createContainer({
      name: p.name,
      Image: p.image,
      Env: p.env || [],
      Cmd: p.cmd || []
    }).then(c => c.start());
    log(`[boot] Launched agent plugin container: ${p.name} (${p.image})`);
  }
}
