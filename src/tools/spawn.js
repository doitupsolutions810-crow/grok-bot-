// team.spawn — depth-limited subagent spawner. A spawned agent can spawn its own
// helpers, but only GROK_MAX_SPAWN_DEPTH levels deep, so agent trees can't recurse
// forever. Spawned agents share the run (same CodeX runId) and get their own names.

import { runAgent } from "../agents/runtime.js";
import { findAgent } from "../agents/registry.js";
import * as nodes from "../agents/nodes.js";

export function spawnTool(getTools, getDocker) {
  const raw = Number(process.env.GROK_MAX_SPAWN_DEPTH);
  // "0" must disable spawning (|| 2 used to turn it back into 2); cap runaway values.
  const MAX_DEPTH = Number.isFinite(raw) && process.env.GROK_MAX_SPAWN_DEPTH !== "" ? Math.min(Math.max(0, Math.floor(raw)), 8) : 2;
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
    async run({ task, agentId } = {}, ctx) {
      if (typeof task !== "string" || !task.trim()) return { error: "task required" };
      const d = Number(ctx?.spawnDepth);
      const depth = Number.isFinite(d) && d > 0 ? Math.floor(d) : 0;
      if (depth >= MAX_DEPTH) return { error: `spawn depth limit (${MAX_DEPTH}) reached — handle this subtask yourself` };
      const agent = findAgent(agentId || "grok-main");
      // each spawned subagent gets its own ephemeral node (removed when it finishes)
      const nodeKey = nodes.enabled() ? `${agent.id}-spawn${depth + 1}-${Math.random().toString(36).slice(2, 8)}` : undefined;
      let answer;
      try {
        answer = await runAgent(agent, task, getTools(), {
          runId: ctx?.run?.runId,
          agentName: agent.id,
          spawnDepth: depth + 1,
          nodeKey
        });
      } finally {
        if (nodeKey && getDocker?.()) await nodes.removeNode(getDocker(), nodeKey).catch(() => {});
      }
      return { spawned: true, depth: depth + 1, agent: agent.id, answer };
    }
  };
}
