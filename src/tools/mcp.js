import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HANDSHAKE_TIMEOUT_MS = 20_000;

// One flaky MCP server must not take down the whole tool registry: each
// server is isolated behind its own timeout + try/catch, and a failure only
// degrades that server. (server.js logs a warning; the boot self-test still
// gates on at least one live MCP tool being registered, so strictness holds.)
export async function loadMCPTools(serverConfigs) {
  const tools = [];
  for (const [id, cfg] of Object.entries(serverConfigs)) {
    if (cfg.transport !== "stdio") continue;
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
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args });
  const client = new Client({ name: `grok-bot-${id}`, version: "1.0.0" });
  await client.connect(transport);
  const { tools: mcpTools } = await client.listTools();
  return mcpTools.map(t => ({
    name: `mcp.${id}.${t.name}`,
    description: t.description || `MCP tool ${t.name} from ${id}`,
    parameters: t.inputSchema,
    async run(args) {
      const res = await client.callTool({ name: t.name, arguments: args });
      return res.content;
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
