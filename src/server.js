import express from "express";
import { bootDocker } from "./boot/docker.js";
import { jsonErrors } from "./middleware/json-errors.js";
import { preinstall } from "./boot/preinstall.js";
import { selftest } from "./boot/selftest.js";
import { makeRouter } from "./router.js";
import { loadMCPTools } from "./tools/mcp.js";
import { loadAgents, listBots } from "./agents/registry.js";
import { dispatch } from "./agents/team.js";
import { runAgent } from "./agents/runtime.js";
import { terminalTool } from "./tools/terminal.js";
import { browserTool } from "./tools/browser.js";
import { webFetchTool } from "./tools/web.js";
import { researchTools } from "./tools/research.js";
import { ragTool } from "./rag/index.js";
import { xSearchTool, xPostTool } from "./tools/xfeed.js";
import { imagegenTool } from "./tools/imagegen.js";
import { visionTool } from "./tools/vision.js";
import { taskBoardTool } from "./agents/taskboard.js";
import { teamAskTool } from "./agents/team.js";
import { dialogueTools, council, knowledge as teamKnowledge } from "./agents/dialogue.js";
import * as lattice from "./agents/lattice.js";
import { nodeTools } from "./agents/nodes.js";
import { harnessTools } from "./agents/harness.js";
import { mindTools } from "./agents/mind.js";
import { mcpRemoteTool } from "./tools/mcp-remote.js";
import * as research from "./agents/research-env.js";
import { mcpHandler } from "./mcp-server.js";
const listAgents = () => [...Object.values(loadAgents().agents), ...listBots()];
import { getAgent } from "./agents/registry.js";
import { spawnTool } from "./tools/spawn.js";
import { avroneTool } from "./tools/avrone.js";
import { skillTools, playbookTools } from "./tools/skills.js";
import { startXTrigger } from "./tools/xtrigger.js";
import { traceTools } from "./observability/traces.js";

const PORT = process.env.PORT || 3000;

async function main() {
  // 1. Connect to the host's Docker installation (real socket / socket-proxy)
  const docker = await bootDocker();

  // 2. Pre-install: pull images, pull LLM/embedding models, start sidecars
  await preinstall(docker);

  // 3. Live tools — every one of these is a real, running capability
  const baseTools = [
    terminalTool, browserTool, webFetchTool, ...researchTools, ragTool,
    xSearchTool, xPostTool, imagegenTool, visionTool,
    taskBoardTool(),                       // run-scoped task board (Avrone)
    teamAskTool(() => tools),              // delegate to a named teammate
    ...dialogueTools(),                    // team.say / team.inbox / team.knowledge
    ...nodeTools(() => docker, getAgent),
    ...harnessTools(),
    ...mindTools(),
    ...research.envTools(),                // env.record / env.state: long-horizon research environments
    mcpRemoteTool(),                       // mcp.remote: reach any public MCP server at runtime                        // mind.think / journal / goals: visible reasoning + self-evolution                     // harness.list / read / propose / proposals (self-development)  // node.exec / node.service / node.info / node.mcp (own machine per agent)
    spawnTool(() => tools, () => docker),                // depth-limited subagent spawn
    avroneTool,                            // the concluding system bridge: delegate to AVRONE's squad
    ...skillTools(),                       // recorded browser skills → tools
    ...playbookTools()                     // skill.list / skill.load (SKILL.md playbooks)
  ];

  // 4. Real MCP servers: handshake at boot, tools registered live
  const mcp = await loadMCPTools(loadAgents().mcpServers)
    .catch(err => { console.warn("[boot] MCP load failed:", err.message); return []; });

  // 5. Wrap everything with the hash-chained trace ledger (ctx passes through)
  const tools = traceTools([...baseTools, ...mcp]);

  // 6. Live self-test: prove every subsystem works before serving traffic
  const test = await selftest({ tools, docker });
  if (!test.ok) {
    console.error("[boot] self-test failed:", JSON.stringify(test.results.filter(r => !r.ok)));
    if (process.env.BOOT_STRICT !== "false") process.exit(1);
  }
  console.log(`[boot] self-test passed (${test.results.filter(r => r.ok).length}/${test.results.length})`);
  console.log(`[boot] ${tools.length} live tools: ${tools.map(t => t.name).join(", ")}`);
  console.log(`[boot] teammates: ${listBots().map(b => `${b.emoji || "🤖"} ${b.name}`).join(" · ") || "none yet"}`);

  // 7. X triggers: @bot mentions become tasks, routed by the chief of staff
  startXTrigger(async text => {
    const agent = dispatch(text);
    console.log(`[x-trigger] routed mention to ${agent.id}: ${text.slice(0, 80)}`);
    await runAgent(agent, text, tools).catch(e => console.warn(`[x-trigger] failed: ${e.message}`));
  });

  // 8. Serve
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", makeRouter({ tools, docker }));
  // Grok Bot as an MCP server (off unless MCP_TOKEN is set)
  app.all("/mcp", mcpHandler({ getAgent, listAgents, runAgent, tools, knowledge: teamKnowledge }));
  app.get("/api/status", (req, res) => res.json({
    ready: test.ok, degraded: !test.ok, tools: tools.map(t => t.name), selftest: test.results
  }));
  app.use(express.static("public"));       // web console (public/index.html)
  app.use(jsonErrors());                   // JSON errors, never an HTML stack trace with file paths

  // 9. The Lattice: restore the agents' thought/communication log, start autonomous growth if enabled
  console.log(`[boot] lattice restored ${lattice.load()} events`);
  if (lattice.startAutonomy({ council, runAgent, tools, getAgent, knowledge: teamKnowledge }))
    console.log(`[boot] lattice autonomy on: a growth council every ${lattice.status().intervalMin} min`);

  // 10. Long-horizon research environments: resume the ones that were running before a restart
  const resumed = research.init({ runAgent, tools, getAgent });
  if (resumed) console.log(`[boot] resumed ${resumed} research environment(s)`);

  app.listen(PORT, () => console.log(`[boot] Grok Bot fully live on :${PORT}`));
}

main().catch(err => { console.error("[boot] fatal:", err); process.exit(1); });
