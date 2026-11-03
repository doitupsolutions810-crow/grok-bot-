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
import { createSwarmExecutor, readPrivateKey, tokenMatches } from "./swarm/executor.js";

const PORT = process.env.PORT || 3000;

async function main() {
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

  // 5a. Optional signed Swarm execution bridge. It stays disabled until an
  // operator mounts the pinned Ed25519 private key and configures the executor ID.
  let swarmExecutor = null;
  try {
    const privateKeyPem = readPrivateKey(process.env.SWARM_EXECUTOR_PRIVATE_KEY_FILE || "");
    if (privateKeyPem && process.env.SWARM_EXECUTOR_ID) {
      swarmExecutor = createSwarmExecutor({
        tools, runAgent,
        executorId: process.env.SWARM_EXECUTOR_ID,
        privateKeyPem,
        defaultRepository: process.env.SWARM_DEFAULT_REPOSITORY || "",
        defaultBranch: process.env.SWARM_DEFAULT_BRANCH || ""
      });
      console.log("[swarm] signed specialist execution bridge configured");
    } else {
      console.log("[swarm] specialist execution bridge disabled: signing key or executor ID missing");
    }
  } catch (error) {
    console.warn("[swarm] specialist execution bridge disabled:", error.message);
  }

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
  app.post("/api/swarm/execute", async (req, res) => {
    const { jobId, role, objective, workerId, claimToken } = req.body || {};
    if (!["debugger", "coder", "tester", "governance"].includes(role)) {
      return res.status(400).json({ error: "unknown specialist role" });
    }
    const expected = process.env["SWARM_EXECUTOR_" + role.toUpperCase() + "_TOKEN"] || "";
    const authorization = String(req.headers.authorization || "");
    const match = /^Bearer ([A-Za-z0-9._~+\\/-]{32,512})$/.exec(authorization);
    if (!tokenMatches(expected, match?.[1])) return res.status(401).json({ error: "unauthorized specialist worker" });
    if (typeof jobId !== "string" || typeof workerId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(workerId)
        || typeof claimToken !== "string" || claimToken.length < 32) {
      return res.status(400).json({ error: "jobId, workerId, and claimToken are required" });
    }
    if (!swarmExecutor) return res.status(503).json({ error: "signed specialist executor is not configured" });
    const coordinatorUrl = (process.env.SWARM_COORDINATOR_URL || "").replace(/\\/+$/, "");
    const coordinatorToken = String(req.headers["x-swarm-coordinator-token"] || "");
    if (!coordinatorUrl || coordinatorToken.length < 32 || coordinatorToken.length > 512) {
      return res.status(503).json({ error: "coordinator claim-validation bridge is not configured" });
    }
    const controller = new AbortController();
    const abortOnDisconnect = () => {
      if (!res.writableEnded && !controller.signal.aborted) controller.abort(new Error("worker disconnected"));
    };
    req.on("aborted", abortOnDisconnect);
    res.on("close", abortOnDisconnect);
    try {
      const validation = await fetch(coordinatorUrl + "/api/worker/" + role + "/validate", {
        method: "POST",
        headers: { authorization: "Bearer " + coordinatorToken, "content-type": "application/json" },
        body: JSON.stringify({ jobId, workerId, claimToken }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      if (!validation.ok) {
        const status = validation.status === 401 ? 401 : validation.status === 404 ? 404 : 409;
        return res.status(status).json({ error: "coordinator rejected specialist claim (" + validation.status + ")" });
      }
      const validationBody = await validation.json();
      if (validationBody.valid !== true) return res.status(409).json({ error: "coordinator did not validate specialist claim" });
      const result = await swarmExecutor({ jobId, role, objective, signal: controller.signal });
      if (!res.writableEnded) return res.status(result.status).json(result.body);
    } catch (error) {
      if (!res.writableEnded) return res.status(controller.signal.aborted ? 409 : 503).json({ error: error.message || "specialist execution bridge unavailable" });
    }
  });
  app.use("/api", makeRouter({ tools, docker }));
  app.get("/api/status", (req, res) => res.json({
    ready: test.ok, degraded: !test.ok, tools: tools.map(t => t.name), selftest: test.results
  }));
  app.use(express.static("public"));       // web console (public/index.html)

  app.listen(PORT, () => console.log(`[boot] Grok Bot fully live on :${PORT}`));
}

main().catch(err => { console.error("[boot] fatal:", err); process.exit(1); });
