// Grok Bot as an MCP server: the reach goes both ways. Any MCP client (Claude Desktop, Cursor,
// another agent stack, another Grok Bot) can talk to the team at POST /mcp (Streamable HTTP,
// stateless JSON). It is OFF unless MCP_TOKEN is set, and every request must carry
// "Authorization: Bearer <MCP_TOKEN>": this surface runs agents with real tools.
//
// Tools: agents_list, agent_ask, research_start, research_status, research_report,
//        lattice_highlights, knowledge_search
import { timingSafeEqual } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as research from "./agents/research-env.js";
import * as lattice from "./agents/lattice.js";

const obj = (properties, required = []) => ({ type: "object", properties, required });
export const TOOLS = [
  { name: "agents_list", description: "List the team's agents and what each does.", inputSchema: obj({}) },
  { name: "agent_ask", description: "Ask one named agent to do a task with its tools; returns its answer.", inputSchema: obj({ agent: { type: "string" }, task: { type: "string" } }, ["agent", "task"]) },
  { name: "research_start", description: "Open a long-horizon research environment the team works on for hours.", inputSchema: obj({ goal: { type: "string" }, agents: { type: "array", items: { type: "string" } }, maxSteps: { type: "number" }, horizonHours: { type: "number" } }, ["goal"]) },
  { name: "research_status", description: "Status of one research environment, or all of them.", inputSchema: obj({ id: { type: "string" } }) },
  { name: "research_report", description: "The findings report of a research environment, in Markdown.", inputSchema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "lattice_highlights", description: "The most interesting recent agent messages, reasoning and discoveries.", inputSchema: obj({ limit: { type: "number" } }) },
  { name: "knowledge_search", description: "Search the team's recorded discoveries.", inputSchema: obj({ q: { type: "string" } }) }
];

const ok = v => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }] });
const fail = msg => ({ isError: true, content: [{ type: "text", text: msg }] });

export async function callTool(name, args = {}, { getAgent, listAgents, runAgent, tools, knowledge } = {}) {
  args = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  switch (name) {
    case "agents_list": return ok((listAgents?.() || []).map(a => ({ id: a.id, name: a.name || a.id, job: a.job || a.description || "" })));
    case "agent_ask": {
      if (typeof args.agent !== "string" || typeof args.task !== "string" || !args.task.trim()) return fail("agent and task are required");
      if (args.task.length > 8000) return fail("task is too long (8000 characters max)");
      const agent = getAgent?.(args.agent);
      if (!agent) return fail(`unknown agent: ${args.agent}`);
      try { return ok(String(await runAgent(agent, args.task, tools, { runId: `mcp-${Date.now().toString(36)}`, agentName: args.agent }) ?? "")); }
      catch (e) { return fail(`agent failed: ${e.message}`); }
    }
    case "research_start": { const r = research.create(args, { getAgent }); return r.error ? fail(r.error) : ok(r.env); }
    case "research_status": {
      if (args.id === undefined) return ok(research.list());
      const e = research.get(args.id); return e ? ok({ ...e, log: e.log.slice(-10) }) : fail(`no research environment ${args.id}`);
    }
    case "research_report": { const r = research.report(args.id); return r ? ok(r) : fail(`no research environment ${args.id}`); }
    case "lattice_highlights": return ok(lattice.highlights({ limit: args.limit ?? 10 }).map(e => ({ agent: e.agent, kind: e.kind, at: e.at, text: e.text })));
    case "knowledge_search": return ok(knowledge?.({ q: typeof args.q === "string" ? args.q : undefined, limit: 20 }) || []);
    default: return fail(`unknown tool: ${name}`);
  }
}

function tokenOk(header) {
  const want = process.env.MCP_TOKEN || "";
  const got = String(header || "").replace(/^Bearer\s+/i, "").trim();
  if (!want || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Express handler for /mcp. A new server+transport per request (stateless mode).
export function mcpHandler(deps) {
  return async (req, res) => {
    if (!process.env.MCP_TOKEN) return res.status(503).json({ error: "the MCP endpoint is off: set MCP_TOKEN to enable it" });
    if (!tokenOk(req.headers.authorization)) return res.status(401).json({ error: "unauthorized" });
    if (req.method !== "POST") return res.status(405).set("Allow", "POST").json({ error: "stateless MCP endpoint: POST only" });
    const server = new Server({ name: "grok-bot", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async r => callTool(r.params.name, r.params.arguments, deps));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: e.message }, id: null });
    }
  };
}
