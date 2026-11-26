import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const HANDSHAKE_TIMEOUT_MS = 20_000;

// One flaky MCP server must not take down the whole tool registry: each
// server is isolated behind its own timeout + try/catch, and a failure only
// degrades that server. (server.js logs a warning; the boot self-test still
// gates on at least one live MCP tool being registered, so strictness holds.)
export async function loadMCPTools(serverConfigs) {
  const tools = [];
  for (const [id, cfg] of Object.entries(serverConfigs || {})) {
    const http = cfg?.transport === "http" && typeof cfg.url === "string";
    if (!http && (cfg?.transport !== "stdio" || typeof cfg.command !== "string")) continue;
    try {
      const serverTools = await withTimeout(connectServer(id, cfg), HANDSHAKE_TIMEOUT_MS);
      tools.push(...serverTools);
    } catch (e) {
      console.warn(`[boot] MCP server "${id}" failed to handshake (degraded, continuing): ${e.message}`);
    }
  }
  return tools;
}

async function connectServer(id, cfg) {
  // http servers come from the owner's own config, so they may be private (a sidecar); the
  // bearer token is read from the env var the config names, never written into the config.
  const transport = cfg.transport === "http"
    ? new StreamableHTTPClientTransport(new URL(cfg.url), cfg.tokenEnv && process.env[cfg.tokenEnv]
        ? { requestInit: { headers: { Authorization: `Bearer ${process.env[cfg.tokenEnv]}` } } } : {})
    : new StdioClientTransport({ command: cfg.command, args: cfg.args });
  const client = new Client({ name: `grok-bot-${id}`, version: "1.0.0" });
  await client.connect(transport);
  const { tools: mcpTools } = await client.listTools();
  return mcpTools.map(t => ({
    name: `mcp.${id}.${t.name}`,
    description: t.description || `MCP tool ${t.name} from ${id}`,
    parameters: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
    async run(args) {
      const res = await client.callTool({ name: t.name, arguments: args && typeof args === "object" && !Array.isArray(args) ? args : {} });
      // MCP reports tool failures in-band (isError); surface them as errors to the agent
      return res?.isError ? { error: res.content?.map(c => c.text).filter(Boolean).join("\n") || "MCP tool error", content: res.content } : res?.content;
    }
  }));
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`handshake timeout after ${ms} ms`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
