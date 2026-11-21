import express from "express";
import { bootDocker } from "./boot/docker.js";
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
import { ragTool } from "./rag/index.js";
import { xSearchTool, xPostTool } from "./tools/xfeed.js";
import { imagegenTool } from "./tools/imagegen.js";
import { visionTool } from "./tools/vision.js";
import { taskBoardTool } from "./agents/taskboard.js";
import { teamAskTool } from "./agents/team.js";
import { spawnTool } from "./tools/spawn.js";
import { avroneTool } from "./tools/avrone.js";
import { skillTools, playbookTools } from "./tools/skills.js";
import { startXTrigger } from "./tools/xtrigger.js";
import { traceTools } from "./observability/traces.js";
import { createBasicAuth, readBasicAuthConfig } from "./middleware/basic-auth.js";

const PORT = process.env.PORT || 3000;

async function main() {
  // Validate security configuration before pulling images/models or opening ports.
  const authConfig = readBasicAuthConfig();
  if (authConfig.enabled) console.log("[boot] HTTP Basic authentication enabled");

  // 1. Connect to the host's Docker installation (real socket / socket-proxy)
  const docker = await bootDocker();

  // 2. Pre-install: pull images, pull LLM/embedding models, start sidecars
  await preinstall(docker);

  // 3. Live tools — every one of these is a real, running capability
  const baseTools = [
    terminalTool, browserTool, webFetchTool, ragTool,
    xSearchTool, xPostTool, imagegenTool, visionTool,
    taskBoardTool(),                       // run-scoped task board (Avrone)
    teamAskTool(() => tools),              // delegate to a named teammate
    spawnTool(() => tools),                // depth-limited subagent spawn
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
  app.disable("x-powered-by");
  // Protect the UI, API (including SSE), and all static assets. Only the minimal
  // /api/health endpoint is public so Docker can perform a healthcheck.
  app.use(createBasicAuth(authConfig));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", makeRouter({ tools, docker }));
  app.get("/api/status", (req, res) => res.json({
    ready: test.ok, degraded: !test.ok, tools: tools.map(t => t.name), selftest: test.results
  }));
  app.use(express.static("public"));       // web console (public/index.html)

  app.listen(PORT, () => console.log(`[boot] Grok Bot fully live on :${PORT}`));
}

main().catch(err => { console.error("[boot] fatal:", err); process.exit(1); });
