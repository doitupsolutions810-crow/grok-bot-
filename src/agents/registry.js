// Registry — the single source of truth for agents AND bots (config/agents.json).
// Teammates created in the console are written here and hot-reloaded, so every
// subsystem (router, team dispatch, spawn) sees the same live roster.

import { readFileSync, writeFileSync } from "node:fs";

const FILE = () => process.env.AGENTS_FILE || "/app/config/agents.json";

let cache = null;
export function reload() { cache = null; }

export function loadAgents() {
  if (cache) return cache;
  const cfg = JSON.parse(readFileSync(FILE(), "utf-8"));
  cache = {
    defaultModel: cfg.defaultModel || "",
    agents: Object.fromEntries((cfg.agents || []).map(a => [a.id, a])),
    bots: cfg.bots || [],
    mcpServers: cfg.mcpServers || {}
  };
  return cache;
}

export function listBots() { return loadAgents().bots; }

export function upsertBot(bot) {
  const cfg = JSON.parse(readFileSync(FILE(), "utf-8"));
  cfg.bots = cfg.bots || [];
  const i = cfg.bots.findIndex(b => b.id === bot.id);
  if (i >= 0) cfg.bots[i] = { ...cfg.bots[i], ...bot };
  else cfg.bots.push(bot);
  writeFileSync(FILE(), JSON.stringify(cfg, null, 2));
  reload();
  return bot;
}

export function deleteBot(id) {
  const cfg = JSON.parse(readFileSync(FILE(), "utf-8"));
  const before = (cfg.bots || []).length;
  cfg.bots = (cfg.bots || []).filter(b => b.id !== id);
  writeFileSync(FILE(), JSON.stringify(cfg, null, 2));
  reload();
  return (cfg.bots || []).length < before;
}

// Agents first, then bots; never null — falls back to the chief of staff.
export function findAgent(id) {
  const { agents, bots } = loadAgents();
  return agents[id] || bots.find(b => b.id === id || b.name === id) || agents["grok-main"] || Object.values(agents)[0];
}
