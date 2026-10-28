import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export async function loadMCPTools(serverConfigs) {
  const tools = [];
  for (const [id, cfg] of Object.entries(serverConfigs)) {
    if (cfg.transport !== "stdio") continue;
    const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args });
    const client = new Client({ name: `grok-bot-${id}`, version: "1.0.0" });
    await client.connect(transport);
    const { tools: mcpTools } = await client.listTools();
    for (const t of mcpTools) {
      tools.push({
        name: `mcp.${id}.${t.name}`,
        description: t.description || `MCP tool ${t.name} from ${id}`,
        parameters: t.inputSchema,
        async run(args) {
          const res = await client.callTool({ name: t.name, arguments: args });
          return res.content;
        }
      });
    }
  }
  return tools;
}
