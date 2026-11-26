import { validateNodeConfig } from "../agents/nodes.js";
// Agent CRUD API — users create, name, and instruct their own agents.
// Writes go through the registry (single source of truth, atomic writes) and
// hot-reload it, so a new agent is usable the moment the POST returns.
//
// Agent shape: { id, name, job, instructions, model, tools, mode, trigger,
//                review, emoji }
//   name          display name (1–64 chars); the id is derived from it
//   job           one-line role, also used by chief-of-staff dispatch
//   instructions  free-form custom instructions (≤ 8000 chars), appended to the
//                 agent's system prompt on every run

import * as registry from "../agents/registry.js";

const MODELS = () => (process.env.MODELS_REQUIRED || "").split(",").map(s => s.trim()).filter(Boolean);
const MODES = ["chat", "think", "deepsearch", "squad", "deep"];
const ALL_TOOLS = [
  "*", "terminal", "browser", "web.fetch", "web.search", "web.scrape", "github", "x.search", "x.post", "imagegen",
  "rag.search", "team.ask", "team.spawn", "task.board", "skill.list", "skill.load",
  "mcp.filesystem", "mcp.git", "voice.speak", "memory.recall", "node", "mcp", "env"
];
// shell access always (owner, Nov 26): a new agent gets a shell, the browser and research tools
export { DEFAULT_TOOLS } from "../agents/registry.js";
import { DEFAULT_TOOLS } from "../agents/registry.js";
const FIELDS = ["name", "job", "instructions", "model", "tools", "mode", "trigger", "emoji", "review", "resources", "env", "network", "mcp"];
const LIMITS = { name: 64, job: 1000, instructions: 8000, emoji: 16 };
const MAX_AGENTS = (() => { const n = Number(process.env.MAX_AGENTS); return Number.isFinite(n) && process.env.MAX_AGENTS !== "" && process.env.MAX_AGENTS != null ? Math.max(0, Math.floor(n)) : 200; })();

export const slug = name => String(name || "").toLowerCase().normalize("NFKD")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

// Strip control characters (keeps \n and \t) so names and prompts can't smuggle
// terminal escapes or NULs into logs, prompts, or the JSON roster.
const clean = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

function normalize(body) {
  const out = {};
  for (const k of FIELDS) if (body[k] !== undefined) out[k] = body[k];
  for (const k of ["name", "job", "instructions", "emoji", "trigger", "model"]) {
    if (typeof out[k] === "string") out[k] = clean(out[k]).trim();
  }
  if (Array.isArray(out.tools)) out.tools = [...new Set(out.tools)];
  return out;
}

export function validate(a, { partial = false } = {}) {
  const errs = [];
  const has = k => !partial || a[k] !== undefined;
  if (has("name")) {
    if (typeof a.name !== "string" || !a.name || a.name.length > LIMITS.name) errs.push(`name required (1–${LIMITS.name} chars)`);
    else if (!slug(a.name)) errs.push("name must contain at least one letter or digit");
  }
  if (a.job !== undefined && (typeof a.job !== "string" || a.job.length > LIMITS.job)) errs.push(`job must be a string (≤${LIMITS.job} chars)`);
  if (!partial && !a.job && !a.instructions) errs.push("give the agent a job or custom instructions");
  if (a.instructions !== undefined && (typeof a.instructions !== "string" || a.instructions.length > LIMITS.instructions)) errs.push(`instructions must be a string (≤${LIMITS.instructions} chars)`);
  const models = MODELS();
  if (a.model !== undefined && a.model !== "" && (typeof a.model !== "string" || (models.length && !models.includes(a.model)))) errs.push(`model must be one of: ${models.join(", ") || "(any string)"}`);
  if (a.tools !== undefined && (!Array.isArray(a.tools) || a.tools.some(t => !ALL_TOOLS.includes(t)))) errs.push(`tools must be from: ${ALL_TOOLS.join(", ")}`);
  if (a.mode !== undefined && !MODES.includes(a.mode)) errs.push(`mode must be one of: ${MODES.join("|")}`);
  if (a.trigger !== undefined && a.trigger !== "" && (typeof a.trigger !== "string" || !/^@[\w-]{1,15}$/.test(a.trigger))) errs.push("trigger must look like @handle");
  if (a.emoji !== undefined && (typeof a.emoji !== "string" || a.emoji.length > LIMITS.emoji)) errs.push(`emoji must be a short string (≤${LIMITS.emoji} chars)`);
  if (a.review !== undefined && typeof a.review !== "boolean") errs.push("review must be true or false");
  errs.push(...validateNodeConfig(a));   // the agent's own node: resources, env, network, MCP servers
  return errs;
}

const isObj = b => b && typeof b === "object" && !Array.isArray(b);

export { MODES, ALL_TOOLS };

export function agentsCrud(r) {
  r.get("/agents", (req, res) => {
    const db = registry.readConfig();
    res.json({ agents: db.agents || [], bots: db.bots || [], allTools: ALL_TOOLS, modes: MODES, models: MODELS(), limits: LIMITS });
  });

  r.get("/agents/:id", (req, res) => {
    const db = registry.readConfig();
    const a = (db.agents || []).find(x => x.id === req.params.id) || (db.bots || []).find(x => x.id === req.params.id);
    if (!a) return res.status(404).json({ errors: ["no such agent"] });
    res.json({ ...a, core: (db.agents || []).some(x => x.id === a.id), effectivePrompt: registry.toAgent(a).systemPrompt });
  });

  r.post("/agents", (req, res) => {
    if (!isObj(req.body)) return res.status(400).json({ errors: ["JSON object body required"] });
    const body = normalize(req.body);
    const errs = validate(body);
    if (errs.length) return res.status(400).json({ errors: errs });
    const db = registry.readConfig();
    db.bots = db.bots || [];
    const id = slug(body.name);
    const taken = db.bots.some(b => b.id === id || String(b.name).toLowerCase() === body.name.toLowerCase()) ||
      (db.agents || []).some(a => a.id === id);
    if (taken) return res.status(409).json({ errors: [`an agent named "${body.name}" (id "${id}") already exists`] });
    if (db.bots.length >= MAX_AGENTS) return res.status(409).json({ errors: [`agent limit reached (${MAX_AGENTS})`] });
    const bot = {
      id, name: body.name, job: body.job || "", instructions: body.instructions || "",
      model: body.model || "", tools: body.tools?.length ? body.tools : DEFAULT_TOOLS,
      mode: body.mode || "chat", trigger: body.trigger || "", review: !!body.review, emoji: body.emoji || "🤖",
      // the agent's own node (all optional): resource limits, env vars, network, MCP servers
      ...(body.resources ? { resources: body.resources } : {}), ...(body.env ? { env: body.env } : {}),
      ...(body.network ? { network: body.network } : {}), ...(body.mcp ? { mcp: body.mcp } : {}),
      createdAt: new Date().toISOString()
    };
    db.bots.push(bot);
    registry.writeConfig(db);
    res.status(201).json({ ok: true, id, agent: bot });
  });

  r.patch("/agents/:id", (req, res) => {
    if (!isObj(req.body)) return res.status(400).json({ errors: ["JSON object body required"] });
    const db = registry.readConfig();
    if ((db.agents || []).some(a => a.id === req.params.id)) return res.status(403).json({ errors: ["core agents are read-only"] });
    const bot = (db.bots || []).find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ errors: ["no such agent"] });
    const body = normalize(req.body);
    const errs = validate(body, { partial: true });
    if (errs.length) return res.status(400).json({ errors: errs });
    if (body.name !== undefined && db.bots.some(b => b !== bot && String(b.name).toLowerCase() === body.name.toLowerCase()))
      return res.status(409).json({ errors: [`another agent is already named "${body.name}"`] });
    for (const k of FIELDS) if (body[k] !== undefined) bot[k] = k === "review" ? !!body[k] : body[k];
    bot.updatedAt = new Date().toISOString();
    registry.writeConfig(db);   // id stays stable across renames, so chats and tasks keep working
    res.json({ ok: true, id: bot.id, agent: bot });
  });

  r.delete("/agents/:id", (req, res) => {
    const db = registry.readConfig();
    if ((db.agents || []).some(a => a.id === req.params.id)) return res.status(403).json({ errors: ["core agents can't be deleted"] });
    const before = (db.bots || []).length;
    db.bots = (db.bots || []).filter(b => b.id !== req.params.id);
    if (db.bots.length === before) return res.status(404).json({ errors: ["no such agent"] });
    registry.writeConfig(db);
    res.json({ ok: true });
  });
}
