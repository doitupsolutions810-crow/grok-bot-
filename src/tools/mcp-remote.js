// mcp.remote: an agent's reach into the wider MCP ecosystem. Any public MCP server that speaks
// Streamable HTTP can be listed and called at runtime, without a restart or a config change.
// Every request (and every redirect hop) goes through netguard, so an agent can't use an
// "MCP server" URL to reach ollama, the browser's CDP port, Docker, the LAN or cloud metadata.
// Clients are cached per URL (MCP_REMOTE_MAX, default 8) and dropped on error.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { assertPublicUrl, guardedFetch } from "./netguard.js";

const clients = new Map();                    // url -> { client, at }
const TIMEOUT_MS = () => Number(process.env.MCP_REMOTE_TIMEOUT_MS) || 20_000;
const MAX = () => Math.max(1, Number(process.env.MCP_REMOTE_MAX) || 8);

const guardedFetchLike = async (u, init = {}) => (await guardedFetch(String(u), init)).res;

function timeout(p, ms, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
}

export async function connect(raw, { fetchImpl = guardedFetchLike, check = assertPublicUrl } = {}) {
  const url = (await check(raw)).toString();
  const hit = clients.get(url);
  if (hit) { hit.at = Date.now(); return hit.client; }
  if (clients.size >= MAX()) {                  // evict the least recently used
    const [old] = [...clients.entries()].sort((a, b) => a[1].at - b[1].at);
    clients.delete(old[0]); old[1].client.close?.().catch?.(() => {});
  }
  const client = new Client({ name: "grok-bot-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: fetchImpl });
  await timeout(client.connect(transport), TIMEOUT_MS(), "MCP handshake");
  clients.set(url, { client, at: Date.now() });
  return client;
}

const textOf = content => (Array.isArray(content) ? content : []).map(c => c?.text ?? (c?.type ? `[${c.type}]` : "")).filter(Boolean).join("\n").slice(0, 20_000);

export function mcpRemoteTool(opts = {}) {
  return {
    name: "mcp.remote",
    description: "Reach any public MCP server over HTTP: action \"tools\" lists what a server offers, action \"call\" runs one of its tools with arguments.",
    parameters: { type: "object", properties: {
      url: { type: "string", description: "the MCP server's https endpoint, e.g. https://example.com/mcp" },
      action: { type: "string", enum: ["tools", "call"] },
      tool: { type: "string" }, arguments: { type: "object" } }, required: ["url", "action"] },
    async run(args = {}) {
      const { url, action } = args;
      if (typeof url !== "string" || !url) return { error: "url is required" };
      if (action !== "tools" && action !== "call") return { error: "action must be tools or call" };
      if (action === "call" && (typeof args.tool !== "string" || !args.tool)) return { error: "tool is required for call" };
      let client;
      try { client = await connect(url, opts); }
      catch (e) { return { error: `could not reach MCP server: ${e.message}` }; }
      try {
        if (action === "tools") {
          const { tools = [] } = await timeout(client.listTools(), TIMEOUT_MS(), "tools/list");
          return { server: url, tools: tools.slice(0, 100).map(t => ({ name: t.name, description: String(t.description || "").slice(0, 300), parameters: t.inputSchema })) };
        }
        const a = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? args.arguments : {};
        const res = await timeout(client.callTool({ name: args.tool, arguments: a }), TIMEOUT_MS(), "tools/call");
        return res?.isError ? { error: textOf(res.content) || "remote tool error" } : { text: textOf(res?.content), structured: res?.structuredContent };
      } catch (e) {
        clients.delete(new URL(url).toString());              // a broken session is reconnected next time
        return { error: e.message };
      }
    }
  };
}
export const _clients = clients;
