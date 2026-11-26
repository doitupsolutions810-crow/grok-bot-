// Agent nodes: every agent (and every spawned subagent) gets its OWN machine.
//
// A node is a dedicated container (default image ubuntu:24.04) created on first use:
//   - its own hostname, process table, filesystem and environment variables
//   - its own resource limits (CPU, memory, process count) from the agent's config
//   - its own network attachment ("bridge" by default, "none" for an air-gapped agent)
//   - a terminal (node.exec) that runs there, never in a teammate's node
//   - a service manager (node.service): start/stop/restart/status/logs/list of long-running
//     processes with pid files and log files, the job systemd does on a normal host
//     (a container's PID 1 is not systemd, so this is a supervisor, not systemd itself)
//   - its own MCP servers (node.mcp): stdio servers from the agent's config run INSIDE
//     its node through `docker exec -i`, so each agent's tools live on its own machine
// Spawned subagents get an ephemeral node of their own, removed when they finish.
//
// Enabled with AGENT_NODES=true. Needs the socket proxy's CONTAINERS + POST + EXEC.

import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

export const enabled = () => process.env.AGENT_NODES === "true";
const IMAGE = () => process.env.AGENT_NODE_IMAGE || "ubuntu:24.04";
const PREFIX = "grok-node-";

export const nodeName = key => PREFIX + (String(key || "main").toLowerCase()
  .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "main");

// ---------- config validation (used by the agents API too) ----------
export function validateNodeConfig(a = {}) {
  const errs = [];
  const r = a.resources;
  if (r !== undefined) {
    if (!r || typeof r !== "object" || Array.isArray(r)) errs.push("resources must be an object {cpus, memoryMb, pids}");
    else {
      if (r.cpus !== undefined && !(Number(r.cpus) >= 0.1 && Number(r.cpus) <= 16)) errs.push("resources.cpus must be 0.1..16");
      if (r.memoryMb !== undefined && !(Number.isInteger(r.memoryMb) && r.memoryMb >= 64 && r.memoryMb <= 65536)) errs.push("resources.memoryMb must be an integer 64..65536");
      if (r.pids !== undefined && !(Number.isInteger(r.pids) && r.pids >= 16 && r.pids <= 8192)) errs.push("resources.pids must be an integer 16..8192");
    }
  }
  if (a.env !== undefined) {
    if (!a.env || typeof a.env !== "object" || Array.isArray(a.env)) errs.push("env must be an object of NAME: value");
    else {
      const keys = Object.keys(a.env);
      if (keys.length > 50) errs.push("env: at most 50 variables");
      for (const k of keys) {
        if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(k)) errs.push(`env: bad variable name ${JSON.stringify(k)}`);
        else if (typeof a.env[k] !== "string" || a.env[k].length > 2000 || a.env[k].includes("\0")) errs.push(`env.${k} must be a string ≤2000 chars`);
      }
    }
  }
  if (a.network !== undefined && !["bridge", "none"].includes(a.network)) errs.push("network must be bridge or none");
  if (a.mcp !== undefined) {
    if (!a.mcp || typeof a.mcp !== "object" || Array.isArray(a.mcp)) errs.push("mcp must be an object {id: {command, args}}");
    else {
      const ids = Object.keys(a.mcp);
      if (ids.length > 5) errs.push("mcp: at most 5 servers per agent");
      for (const id of ids) {
        const c = a.mcp[id];
        if (!/^[a-z0-9_-]{1,32}$/.test(id)) errs.push(`mcp: bad server id ${JSON.stringify(id)}`);
        else if (!c || typeof c.command !== "string" || !c.command.trim() || (c.args !== undefined && (!Array.isArray(c.args) || c.args.some(x => typeof x !== "string"))))
          errs.push(`mcp.${id} needs {command: string, args?: string[]}`);
      }
    }
  }
  return errs;
}

function createSpec(name, agent, { ephemeral = false } = {}) {
  const r = agent?.resources || {};
  const cpus = Number(r.cpus) || Number(process.env.AGENT_NODE_CPUS) || 1;
  const memMb = Number(r.memoryMb) || Number(process.env.AGENT_NODE_MEMORY_MB) || 1024;
  const env = Object.entries(agent?.env || {}).map(([k, v]) => `${k}=${v}`);
  return {
    name,
    Image: IMAGE(),
    Hostname: name.slice(PREFIX.length, PREFIX.length + 63) || "node",
    Cmd: ["sleep", "infinity"],
    WorkingDir: "/root",
    Env: [`AGENT_ID=${agent?.id || "main"}`, `AGENT_NODE=${name}`, ...env],
    Labels: { "grok.node": "1", "grok.agent": String(agent?.id || "main"), "grok.ephemeral": ephemeral ? "1" : "0" },
    HostConfig: {
      NanoCpus: Math.round(cpus * 1e9),
      Memory: memMb * 1024 * 1024,
      PidsLimit: Number(r.pids) || 512,
      NetworkMode: agent?.network || process.env.AGENT_NODE_NETWORK || "bridge",
      RestartPolicy: { Name: ephemeral ? "no" : "unless-stopped" },
      SecurityOpt: ["no-new-privileges"],
      Init: true                                   // reaps zombies left by services
    }
  };
}

const inflight = new Map();   // one create per node, even when parallel calls race

export async function ensureNode(docker, agent, { key, ephemeral = false } = {}) {
  if (!enabled()) throw new Error("agent nodes are disabled (set AGENT_NODES=true)");
  if (!docker) throw new Error("docker is not connected");
  const name = nodeName(key || agent?.id);
  if (inflight.has(name)) return inflight.get(name);
  const p = (async () => {
    const c = docker.getContainer(name);
    try {
      const info = await c.inspect();
      if (!info?.State?.Running) await c.start().catch(e => { if (e?.statusCode !== 304) throw e; });
      return { name, created: false };
    } catch (e) {
      if (e?.statusCode !== 404) throw e;
    }
    const created = await docker.createContainer(createSpec(name, agent, { ephemeral }));
    await created.start();
    return { name, created: true };
  })().finally(() => inflight.delete(name));
  inflight.set(name, p);
  return p;
}

export async function removeNode(docker, key) {
  try { await docker.getContainer(nodeName(key)).remove({ force: true }); return true; }
  catch (e) { if (e?.statusCode === 404) return false; throw e; }
}

export async function listNodes(docker) {
  const list = await docker.listContainers({ all: true, filters: JSON.stringify({ label: ["grok.node=1"] }) });
  return list.map(c => ({
    name: (c.Names?.[0] || "").replace(/^\//, ""), agent: c.Labels?.["grok.agent"], ephemeral: c.Labels?.["grok.ephemeral"] === "1",
    state: c.State, status: c.Status, image: c.Image
  }));
}

// Run a shell command inside a node; hard-killed after timeoutMs.
export async function execIn(docker, name, command, { timeoutMs = 30_000, workdir = "/root" } = {}) {
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  const exec = await docker.getContainer(name).exec({
    Cmd: ["timeout", "-s", "KILL", String(secs), "sh", "-lc", command],
    AttachStdout: true, AttachStderr: true, WorkingDir: workdir
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  let stdout = "", stderr = "";
  const sink = append => ({ write: d => { append(String(d)); return true; }, end() {}, on() {}, once() {}, emit() {} });
  await new Promise((resolve, reject) => {
    const guard = setTimeout(resolve, timeoutMs + 5000);    // never hang on a stuck stream
    docker.modem.demuxStream(stream, sink(d => { if (stdout.length < 65536) stdout += d; }), sink(d => { if (stderr.length < 32768) stderr += d; }));
    stream.on("end", () => { clearTimeout(guard); resolve(); });
    stream.on("close", () => { clearTimeout(guard); resolve(); });
    stream.on("error", e => { clearTimeout(guard); reject(e); });
  });
  const info = await exec.inspect().catch(() => ({}));
  const code = info?.ExitCode ?? null;
  return { ok: code === 0, exitCode: code, timedOut: code === 137, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 4000) };
}

const SVC = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;     // POSIX single-quote

// The service manager's shell for one action (exported for tests).
export function serviceScript(action, name, command = "") {
  const pid = `/var/run/agent-svc/${name}.pid`, log = `/var/log/agent-svc/${name}.log`, cmdf = `/var/run/agent-svc/${name}.cmd`;
  const alive = `[ -f ${pid} ] && kill -0 "$(cat ${pid})" 2>/dev/null`;
  // start: a new command replaces the unit's saved one; with none, the saved one is reused
  const start = `mkdir -p /var/run/agent-svc /var/log/agent-svc; if ${alive}; then echo "already running (pid $(cat ${pid}))"; else ` +
    (command ? `printf '%s' ${q(command)} > ${cmdf}; ` : "") +
    `[ -f ${cmdf} ] || { echo "no command saved for this service"; exit 1; }; ` +
    `nohup sh -c "$(cat ${cmdf})" >> ${log} 2>&1 & echo $! > ${pid}; sleep 0.3; ` +
    `if ${alive}; then echo "started (pid $(cat ${pid}))"; else echo "exited immediately; last log lines:"; tail -n 20 ${log}; exit 1; fi; fi`;
  const stop = `if ${alive}; then kill "$(cat ${pid})"; sleep 0.5; kill -9 "$(cat ${pid})" 2>/dev/null; rm -f ${pid}; echo stopped; else rm -f ${pid}; echo "not running"; fi`;
  switch (action) {
    case "start": return start;
    case "stop": return stop;
    case "restart": return `${stop}; ${start}`;
    case "status": return `if ${alive}; then echo "active (running) pid $(cat ${pid})"; else echo "inactive (dead)"; fi`;
    case "logs": return `tail -n 100 ${log} 2>/dev/null || echo "(no logs)"`;
    case "list": return `mkdir -p /var/run/agent-svc; for f in /var/run/agent-svc/*.cmd; do [ -e "$f" ] || continue; n=$(basename "$f" .cmd); ` +
      `p=/var/run/agent-svc/$n.pid; if [ -f "$p" ] && kill -0 "$(cat "$p")" 2>/dev/null; then echo "$n active"; else echo "$n inactive"; fi; done`;
    default: return null;
  }
}

// ---------- per-agent MCP servers, run inside the agent's own node ----------
const mcpClients = new Map();     // `${node}:${id}` -> Client
async function mcpClient(docker, nodeKey, agent, id) {
  const cfg = agent?.mcp?.[id];
  if (!cfg) throw new Error(`no MCP server "${id}" in this agent's config (configured: ${Object.keys(agent?.mcp || {}).join(", ") || "none"})`);
  const { name } = await ensureNode(docker, agent, { key: nodeKey });
  const k = `${name}:${id}`;
  if (mcpClients.has(k)) return mcpClients.get(k);
  const transport = new StdioClientTransport({
    command: "docker", args: ["exec", "-i", name, cfg.command, ...(cfg.args || [])],
    env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/root", ...(process.env.DOCKER_HOST ? { DOCKER_HOST: process.env.DOCKER_HOST } : {}) }
  });
  const client = new Client({ name: `grok-node-${id}`, version: "1.0.0" });
  await Promise.race([client.connect(transport), new Promise((_, rej) => setTimeout(() => rej(new Error("MCP handshake timed out")), 20_000))]);
  transport.onclose = () => mcpClients.delete(k);
  mcpClients.set(k, client);
  return client;
}

// ---------- tools ----------
export function nodeTools(getDocker, findAgentFn) {
  const who = ctx => {
    const id = ctx?.agent || "main";
    const agent = (findAgentFn && findAgentFn(String(id).split("~")[0])) || { id };
    return { agent, key: ctx?.nodeKey || id };
  };
  const guard = () => !enabled() ? { error: "agent nodes are disabled (set AGENT_NODES=true)" } : (!getDocker() ? { error: "docker is not connected" } : null);
  return [
    {
      name: "node.exec",
      description: "Run a shell command on YOUR OWN node (a private Linux machine: your own filesystem, processes, env, network and resource limits). Teammates have their own nodes.",
      parameters: { type: "object", properties: { command: { type: "string" }, timeoutSec: { type: "number" } }, required: ["command"] },
      async run({ command, timeoutSec } = {}, ctx) {
        const g = guard(); if (g) return g;
        if (typeof command !== "string" || !command.trim()) return { error: "command required" };
        if (command.length > 20_000) return { error: "command too long (max 20000 chars)" };
        const { agent, key } = who(ctx);
        const { name } = await ensureNode(getDocker(), agent, { key, ephemeral: !!ctx?.nodeKey });
        const t = Math.min(Math.max(1, Number(timeoutSec) || 30), 600) * 1000;
        return { node: name, ...(await execIn(getDocker(), name, command, { timeoutMs: t })) };
      }
    },
    {
      name: "node.service",
      description: "Manage long-running services on your own node, like systemctl: start (needs command), stop, restart, status, logs, list.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["start", "stop", "restart", "status", "logs", "list"] },
        name: { type: "string" }, command: { type: "string" } }, required: ["action"] },
      async run({ action, name, command } = {}, ctx) {
        const g = guard(); if (g) return g;
        if (!["start", "stop", "restart", "status", "logs", "list"].includes(action)) return { error: "action must be start|stop|restart|status|logs|list" };
        if (action !== "list" && (typeof name !== "string" || !SVC.test(name))) return { error: "name must be 1-32 chars of a-z 0-9 _ . -" };
        if (action === "start" && (typeof command !== "string" || !command.trim())) return { error: "start needs a command" };
        const { agent, key } = who(ctx);
        const node = (await ensureNode(getDocker(), agent, { key, ephemeral: !!ctx?.nodeKey })).name;
        return { node, service: name || null, ...(await execIn(getDocker(), node, serviceScript(action, name, command || ""), { timeoutMs: 20_000 })) };
      }
    },
    {
      name: "node.info",
      description: "Describe your own node: hostname, CPU and memory limits, network addresses, disk, running processes.",
      parameters: { type: "object", properties: {} },
      async run(_args, ctx) {
        const g = guard(); if (g) return g;
        const { agent, key } = who(ctx);
        const { name } = await ensureNode(getDocker(), agent, { key, ephemeral: !!ctx?.nodeKey });
        const info = await getDocker().getContainer(name).inspect();
        const probe = await execIn(getDocker(), name, "hostname; (hostname -I 2>/dev/null || true); df -h / | tail -1; ps -eo pid,comm --no-headers | head -20", { timeoutMs: 10_000 });
        return {
          node: name, image: info?.Config?.Image, network: info?.HostConfig?.NetworkMode,
          cpus: (info?.HostConfig?.NanoCpus || 0) / 1e9, memoryMb: Math.round((info?.HostConfig?.Memory || 0) / 1048576),
          pidsLimit: info?.HostConfig?.PidsLimit, ips: Object.values(info?.NetworkSettings?.Networks || {}).map(n => n.IPAddress).filter(Boolean),
          probe: probe.stdout
        };
      }
    },
    {
      name: "node.mcp",
      description: "Use the MCP servers configured for you, running on your own node: action list (their tools) or call (tool + arguments).",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["servers", "list", "call"] }, server: { type: "string" },
        tool: { type: "string" }, arguments: { type: "object" } }, required: ["action"] },
      async run({ action, server, tool, arguments: args } = {}, ctx) {
        const g = guard(); if (g) return g;
        const { agent, key } = who(ctx);
        if (action === "servers") return { servers: Object.keys(agent?.mcp || {}) };
        if (typeof server !== "string" || !server) return { error: "server required" };
        try {
          const client = await mcpClient(getDocker(), key, agent, server);
          if (action === "list") return { tools: (await client.listTools()).tools.map(t => ({ name: t.name, description: t.description })) };
          if (action !== "call") return { error: "action must be servers|list|call" };
          if (typeof tool !== "string" || !tool) return { error: "tool required" };
          const res = await client.callTool({ name: tool, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} });
          return res?.isError ? { error: res.content?.map(c => c.text).filter(Boolean).join("\n") || "MCP tool error" } : res?.content;
        } catch (e) { return { error: e.message }; }
      }
    }
  ];
}
