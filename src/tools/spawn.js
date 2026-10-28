// team.spawn — depth-limited subagent spawner. A spawned agent can spawn its own
// helpers, but only GROK_MAX_SPAWN_DEPTH levels deep, so agent trees can't recurse
// forever. Spawned agents share the run (same CodeX runId) and get their own names.

import { runAgent } from "../agents/runtime.js";
import { findAgent } from "../agents/registry.js";

export function spawnTool(getTools) {
  const MAX_DEPTH = Math.max(0, Number(process.env.GROK_MAX_SPAWN_DEPTH) || 2);
  return {
    name: "team.spawn",
    description: `Spawn a subagent to handle a self-contained subtask in parallel with your own work. They share your computer and run context. Max spawn depth: ${MAX_DEPTH}.`,
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "Fully self-contained task for the subagent (include all context it needs)" },
        agentId: { type: "string", description: "Optional teammate id to run the task (default: grok-main)" }
      },
      required: ["task"]
    },
    async run({ task, agentId }, ctx) {
      const depth = ctx?.spawnDepth ?? 0;
      if (depth >= MAX_DEPTH) return { error: `spawn depth limit (${MAX_DEPTH}) reached — handle this subtask yourself` };
      const agent = findAgent(agentId || "grok-main");
      const answer = await runAgent(agent, task, getTools(), {
        runId: ctx?.run?.runId,
        agentName: agent.id,
        spawnDepth: depth + 1
      });
      return { spawned: true, depth: depth + 1, agent: agent.id, answer };
    }
  };
}
