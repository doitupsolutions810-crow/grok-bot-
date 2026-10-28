import Docker from "dockerode";

// Connects to the real Docker daemon at boot — directly via socket, or through
// the socket proxy when DOCKER_HOST is set (the hardened deployment path).
function dockerOpts() {
  const h = process.env.DOCKER_HOST;
  if (h && h.startsWith("tcp://")) {
    const u = new URL(h);
    // Docker Engine exposes its API over HTTP even when DOCKER_HOST uses the tcp:// scheme.
    // dockerode expects "http" here; "tcp" is not a valid URL protocol for its request layer.
    return { protocol: "http", host: u.hostname, port: Number(u.port || 2375) };
  }
  if (h && h.startsWith("http")) {
    const u = new URL(h);
    return { protocol: "http", host: u.hostname, port: Number(u.port || 2375) };
  }
  return { socketPath: "/var/run/docker.sock" };
}

export async function bootDocker({ log = console.log } = {}) {
  const docker = new Docker(dockerOpts());

  // 1. Verify the daemon is reachable — a cold socket-proxy gets a grace
  //    window instead of a one-shot connection error that kills the boot.
  const info = await connectDaemon(docker, log);
  log(`[boot] Docker connected: ${info.Name}, ${info.Containers} containers, v${info.ServerVersion}`);

  // 2. Ensure the LLM backend is up and the model exists
  await ensureModel(process.env.LLM_MODEL || "llama3.1:8b", log);

  // 3. Ensure the sandbox terminal container exists (personal terminal tool)
  await ensureSandbox(docker, log);

  // 4. Launch agent plugin containers declared in config (MCP sidecars)
  await ensurePlugins(docker, log);

  return docker;
}

async function connectDaemon(docker, log, { timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await docker.info();
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`Docker daemon unreachable after ${timeout / 1000} s: ${e.message}`);
      log(`[boot] daemon not ready yet (${e.message}) — retrying in 2 s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Pull an image only when it is not already present locally — a flaky registry
// must never block a boot that already has what it needs.
async function ensureImage(docker, image, log) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch { /* not local yet */ }
  log(`[boot] pulling image ${image}...`);
  await new Promise((resolve, reject) => {
    docker.pull(image, (err, stream) => {
      if (err) return reject(err);
      docker.modem.followProgress(stream, err2 => err2 ? reject(err2) : resolve(true));
    });
  });
}

async function ollamaUp(base) {
  try { return (await fetch(`${base}/api/tags`)).ok; } catch { return false; }
}

async function ensureModel(model, log) {
  const base = process.env.OLLAMA_URL || "http://ollama:11434";
  // Wait for Ollama to genuinely answer — a slow-starting sidecar must not
  // crash the boot with a connection error.
  const deadline = Date.now() + 180_000;
  while (!(await ollamaUp(base))) {
    if (Date.now() > deadline) throw new Error(`ollama did not become reachable at ${base} within 3 min`);
    await new Promise(r => setTimeout(r, 2000));
  }
  const present = async () => {
    const list = await fetch(`${base}/api/tags`).then(r => r.json()).catch(() => ({ models: [] }));
    return !!list.models?.some(m => m.name === model);
  };
  if (await present()) { log(`[boot] Model ready: ${model}`); return; }
  log(`[boot] Pulling model ${model} (one-time, may take a while)...`);
  await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false })
  }).catch(() => { /* readiness is gated by preinstall's pullModel */ });
  log(`[boot] Model pull requested: ${model}`);
}

async function ensureSandbox(docker, log) {
  const name = "grok-sandbox";
  const containers = await docker.listContainers({ all: true });
  const existing = containers.find(c => c.Names.includes(`/${name}`));
  if (!existing) {
    // First boot: the sandbox image may not be on the host yet — pull-on-demand
    // instead of failing the boot with a 404.
    await ensureImage(docker, "ubuntu:24.04", log);
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
    await ensureImage(docker, p.image, log);
    await docker.createContainer({
      name: p.name,
      Image: p.image,
      Env: p.env || [],
      Cmd: p.cmd || []
    }).then(c => c.start());
    log(`[boot] Launched agent plugin container: ${p.name} (${p.image})`);
  }
}
