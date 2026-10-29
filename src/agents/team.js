// Bot team model (named teammates + chief-of-staff dispatch) — registry-backed.
// SQLite is used ONLY for the bot-to-bot mailbox; the roster itself lives in
// config/agents.json through the registry so console edits are hot everywhere.

import Database from "better-sqlite3";
import { runAgent } from "./runtime.js";
import { listBots, upsertBot, findAgent } from "./registry.js";
import { dataFile } from "../paths.js";

const db = new Database(dataFile("bots.db"));
db.exec(`CREATE TABLE IF NOT EXISTS mailbox (
  id INTEGER PRIMARY KEY, ts TEXT, from_bot TEXT, to_bot TEXT, content TEXT, done INTEGER DEFAULT 0
)`);

export function toAgent(b) {
  return {
    id: b.id,
    name: b.name || b.id,
    systemPrompt: `You are ${b.name || b.id}, an always-on AI teammate. Your job: ${b.job || "help the team"}. Work end-to-end with your tools (shared computer: files, browser sessions, logins). Return only finished work; ask for approval only when a decision is needed.`,
    tools: b.tools?.length ? b.tools : ["terminal", "browser", "web.fetch"],
    model: b.model,
    mode: b.mode || "chat",
    review: !!b.review
  };
}

export function createBot({ name, job, tools, model, mode, review, emoji, trigger }) {
  const id = String(name || "bot").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bot";
  const bot = {
    id, name, job: job || "", model: model || "", mode: mode || "chat",
    review: !!review, emoji: emoji || "🤖", trigger: trigger || "",
    tools: tools?.length ? tools : ["terminal", "browser", "web.fetch"]
  };
  upsertBot(bot);
  return bot;
}

// Chief-of-staff: pick the best-matching specialist by job overlap, else grok-main
export function dispatch(task) {
  const bots = listBots();
  let best = { bot: null, score: 0 };
  for (const b of bots) {
    const words = String(b.job || "").toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const score = words.filter(w => String(task).toLowerCase().includes(w)).length;
    if (score > best.score) best = { bot: b, score };
  }
  return best.score > 0 ? toAgent(best.bot)
    : { id: "grok-main", name: "Grok Main", systemPrompt: "You are Grok Bot, the chief of staff. Handle this end-to-end.", tools: ["*"], mode: "chat", review: false };
}

// Bot-to-bot messaging on the shared computer
export function sendMail(from, to, content) {
  db.prepare("INSERT INTO mailbox (ts, from_bot, to_bot, content) VALUES (datetime('now'),?,?,?)").run(from, to, content);
}
export function readMail(to) {
  const rows = db.prepare("SELECT id, from_bot, content FROM mailbox WHERE to_bot=? AND done=0").all(to);
  db.prepare("UPDATE mailbox SET done=1 WHERE to_bot=?").run(to);
  return rows;
}

// team.ask: a bot delegates to a teammate — the teammate ACTUALLY runs and answers
export function teamAskTool(getTools) {
  return {
    name: "team.ask",
    description: "Delegate a task to a teammate bot by name; they share your computer (files, browser, logins). Their finished answer is returned to you.",
    parameters: {
      type: "object",
      properties: { bot: { type: "string" }, task: { type: "string" } },
      required: ["bot", "task"]
    },
    async run({ bot, task }, ctx) {
      const b = findAgent(bot);
      if (!b || (b.id === "grok-main" && bot !== "grok-main")) return { error: `no teammate named ${bot}` };
      sendMail(ctx?.agent || "caller", b.id, task);
      const answer = await runAgent(toAgent(b), task, getTools(), {
        runId: ctx?.run?.runId, agentName: b.id, spawnDepth: ctx?.spawnDepth
      });
      return { delegated: true, teammate: b.id, answer };
    }
  };
}
