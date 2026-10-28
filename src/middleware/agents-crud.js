// Agent CRUD API — create & edit teammates from the console.
// Writes go through the registry (single source of truth) and hot-reload it,
// so a new teammate is usable the moment the POST returns.

import { readFileSync, writeFileSync } from "node:fs";
import * as registry from "../agents/registry.js";

const FILE = () => process.env.AGENTS_FILE || "/app/config/agents.json";
const MODELS = (process.env.MODELS_REQUIRED || "").split(",").map(s => s.trim()).filter(Boolean);
const MODES = ["chat", "think", "deepsearch", "squad", "deep"];
const ALL_TOOLS = [
  "*", "terminal", "browser", "web.fetch", "x.search", "x.post", "imagegen",
  "rag.search", "team.ask", "team.spawn", "task.board", "skill.list", "skill.load",
  "mcp.filesystem", "mcp.git", "voice.speak", "memory.recall"
];

function read() { return JSON.parse(readFileSync(FILE(), "utf-8")); }
function write(db) { writeFileSync(FILE(), JSON.stringify(db, null, 2)); registry.reload(); }

function valid(a, { partial = false } = {}) {
  const errs = [];
  if (!partial || a.name !== undefined) if (!a.name || typeof a.name !== "string" || a.name.length > 64) errs.push("name required (≤64 chars)");
  if (!partial || a.job !== undefined) if (typeof a.job !== "string" || a.job.length > 1000) errs.push("job must be a string (≤1000 chars)");
  if (!partial || a.model !== undefined) if (MODELS.length && !MODELS.includes(a.model)) errs.push(`model must be one of: ${MODELS.join(", ")}`);
  if (!partial || a.tools !== undefined) if (!Array.isArray(a.tools) || a.tools.some(t => !ALL_TOOLS.includes(t))) errs.push(`tools must be from: ${ALL_TOOLS.join(", ")}`);
  if (!partial || a.mode !== undefined) if (a.mode !== undefined && !MODES.includes(a.mode)) errs.push(`mode must be one of: ${MODES.join("|")}`);
  if (!partial || a.trigger !== undefined) if (a.trigger && !/^@[\w-]{1,15}$/.test(a.trigger)) errs.push("trigger must look like @handle");
  return errs;
}

export { MODES, ALL_TOOLS };

export function agentsCrud(r) {
  r.get("/agents", (req, res) => {
    const db = read();
    res.json({ agents: db.agents || [], bots: db.bots || [], allTools: ALL_TOOLS, modes: MODES, models: MODELS });
  });

  r.post("/agents", (req, res) => {
    const errs = valid(req.body || {});
    if (errs.length) return res.status(400).json({ errors: errs });
    const db = read();
    const id = (req.body.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
    if ((db.bots || []).some(b => b.id === id)) return res.status(409).json({ errors: [`agent "${id}" already exists`] });
    db.bots = db.bots || [];
    db.bots.push({
      id, name: req.body.name, job: req.body.job, model: req.body.model,
      tools: req.body.tools, mode: req.body.mode || "chat", trigger: req.body.trigger || "",
      review: !!req.body.review, emoji: req.body.emoji || "🤖"
    });
    write(db);
    res.status(201).json({ ok: true, id });
  });

  r.patch("/agents/:id", (req, res) => {
    const db = read();
    const bot = (db.bots || []).find(b => b.id === req.params.id);
    if (!bot) return res.status(404).json({ errors: ["no such agent"] });
    const errs = valid(req.body || {}, { partial: true });
    if (errs.length) return res.status(400).json({ errors: errs });
    for (const k of ["name", "job", "model", "tools", "mode", "trigger", "emoji"]) if (req.body[k] !== undefined) bot[k] = req.body[k];
    if (req.body.review !== undefined) bot.review = !!req.body.review;
    write(db);
    res.json({ ok: true });
  });

  r.delete("/agents/:id", (req, res) => {
    const db = read();
    const before = (db.bots || []).length;
    db.bots = (db.bots || []).filter(b => b.id !== req.params.id);
    if ((db.bots || []).length === before) return res.status(404).json({ errors: ["no such agent"] });
    write(db);
    res.json({ ok: true });
  });
}
