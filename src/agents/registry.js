// Registry — the single source of truth for agents AND bots (config/agents.json).
// Teammates created in the console are written here and hot-reloaded, so every
// subsystem (router, team dispatch, spawn) sees the same live roster.

import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from "node:fs";

const FILE = () => process.env.AGENTS_FILE || "/app/config/agents.json";

let cache = null;

// Read tolerates a missing file (fresh install) and writes are atomic
// (tmp + rename) so a crash mid-save can never leave a half-written roster.
let lastGood = null;
export function readConfig() {
  if (!existsSync(FILE())) return { agents: [], bots: [], mcpServers: {} };
  const raw = readFileSync(FILE(), "utf-8");
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (e) {
    // A hand-edited or truncated roster must not take every agent down: keep a copy of
    // the broken file and keep serving the last good roster (or an empty one).
    const bak = `${FILE()}.corrupt-${Date.now()}`;
    try { copyFileSync(FILE(), bak); } catch {}
    console.warn(`[registry] ${FILE()} is not valid JSON (${e.message}); saved a copy to ${bak}`);
    return structuredClone(lastGood || { agents: [], bots: [], mcpServers: {} });
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
  if (!Array.isArray(cfg.agents)) cfg.agents = [];
  if (!Array.isArray(cfg.bots)) cfg.bots = [];
  cfg.agents = cfg.agents.filter(a => a && typeof a.id === "string");
  cfg.bots = cfg.bots.filter(b => b && typeof b.id === "string");
  if (!cfg.mcpServers || typeof cfg.mcpServers !== "object") cfg.mcpServers = {};
  lastGood = structuredClone(cfg);
  return cfg;
}
export function writeConfig(cfg) {
  const tmp = `${FILE()}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  renameSync(tmp, FILE());
  reload();
}
export function reload() { cache = null; }

export function loadAgents() {
  if (cache) return cache;
  const cfg = readConfig();
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
  const cfg = readConfig();
  cfg.bots = cfg.bots || [];
  const i = cfg.bots.findIndex(b => b.id === bot.id);
  if (i >= 0) cfg.bots[i] = { ...cfg.bots[i], ...bot };
  else cfg.bots.push(bot);
  writeConfig(cfg);
  return bot;
}

export function deleteBot(id) {
  const cfg = readConfig();
  const before = (cfg.bots || []).length;
  cfg.bots = (cfg.bots || []).filter(b => b.id !== id);
  writeConfig(cfg);
  return (cfg.bots || []).length < before;
}

// A user-created teammate is stored as { name, job, instructions, ... }. The
// runtime only reads systemPrompt, so every lookup materializes one here —
// otherwise a custom agent's name and custom instructions never reach the model.
export const DEFAULT_TOOLS = ["terminal", "browser", "web.search", "web.fetch", "web.scrape", "github"];
export const _defaultTools = DEFAULT_TOOLS;
export function toAgent(b) {
  if (!b) return b;
  const name = b.name || b.id;
  const base = b.systemPrompt ||
    `You are ${name}, an always-on AI teammate. Your job: ${b.job || "help the team"}. ` +
    "Work end-to-end with your tools (shared computer: files, browser sessions, logins). " +
    "Return only finished work; ask for approval only when a decision is needed.";
  const custom = typeof b.instructions === "string" && b.instructions.trim()
    ? `\n\nCustom instructions from your owner (follow these):\n${b.instructions.trim()}` : "";
  return {
    ...b,
    id: b.id,
    name,
    systemPrompt: base + custom,
    tools: Array.isArray(b.tools) && b.tools.length ? b.tools : DEFAULT_TOOLS,
    model: b.model || "",
    mode: b.mode || "chat",
    review: !!b.review
  };
}

// Agents first, then bots (by id, or by name case-insensitively); never null —
// falls back to the chief of staff.
export function findAgent(id) {
  const { agents, bots } = loadAgents();
  const key = String(id ?? "");
  const lower = key.toLowerCase();
  const hit = agents[key] ||
    bots.find(b => b.id === key || b.name === key) ||
    bots.find(b => String(b.name || "").toLowerCase() === lower);
  return toAgent(hit || agents["grok-main"] || Object.values(agents)[0]);
}

// Strict lookup: null when nothing by that id/name exists (no fallback).
export function getAgent(id) {
  const { agents, bots } = loadAgents();
  const key = String(id ?? "");
  const lower = key.toLowerCase();
  const hit = agents[key] || bots.find(b => b.id === key || String(b.name || "").toLowerCase() === lower);
  return hit ? toAgent(hit) : null;
}
