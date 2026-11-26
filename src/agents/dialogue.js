// Team dialogue: the agents' shared conversation channel + knowledge board.
//
//  - dialogue: every message one agent sends another (asks, answers, notes, eurekas),
//    queued per recipient. Each agent keeps a read cursor, so team.inbox returns only
//    what it has not seen yet (broadcasts included), in order.
//  - knowledge: "eureka" findings. The newest ones are injected into every agent's
//    system prompt, so what one agent learns, the whole team knows on its next turn.
//  - council: a real round-table. Each agent reads the thread so far, may use its own
//    tools and skills, and replies in plain English; lines starting "EUREKA:" become
//    knowledge entries.

import Database from "better-sqlite3";
import { dataPath } from "../paths.js";

const db = new Database(dataPath("dialogue.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS dialogue (
    id INTEGER PRIMARY KEY, ts TEXT, run_id TEXT, from_agent TEXT, to_agent TEXT, kind TEXT, text TEXT
  );
  CREATE TABLE IF NOT EXISTS knowledge (
    id INTEGER PRIMARY KEY, ts TEXT, agent TEXT, text TEXT, run_id TEXT
  );
  CREATE TABLE IF NOT EXISTS cursors (agent TEXT PRIMARY KEY, last_id INTEGER);
  CREATE INDEX IF NOT EXISTS dialogue_to ON dialogue(to_agent, id);
`);

import * as lattice from "./lattice.js";
export const KINDS = ["ask", "answer", "note", "eureka", "human"];
const MAX_TEXT = 4000;
const MAX_ROWS = 20_000;     // the channel is a rolling window, not an unbounded log

export const ENGLISH_STYLE =
  "When you talk to teammates or the user, write clear, complete sentences in proper English: " +
  "no shorthand, no fragments, no internal jargon without a short explanation. Say what you found, " +
  "how you know it (which tool or skill), and what should happen next. When you discover something " +
  "the whole team should remember, add a line that starts with \"EUREKA:\" and states it in one sentence.";

const clean = (s, max = MAX_TEXT) => String(s ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const name = s => clean(s, 64).toLowerCase() || "unknown";

export function post({ from, to = "*", kind = "note", text, runId = "" } = {}) {
  const body = clean(text);
  if (!body) throw new Error("text required");
  if (!KINDS.includes(kind)) throw new Error(`kind must be one of ${KINDS.join(", ")}`);
  const info = db.prepare("INSERT INTO dialogue (ts, run_id, from_agent, to_agent, kind, text) VALUES (datetime('now'),?,?,?,?,?)")
    .run(clean(runId, 128), name(from), to === "*" ? "*" : name(to), kind, body);
  const id = Number(info.lastInsertRowid);
  lattice.record("say", { agent: name(from), to: to === "*" ? "*" : name(to), runId, text: body, data: { kind } });
  if (id % 500 === 0) db.prepare("DELETE FROM dialogue WHERE id <= ?").run(id - MAX_ROWS);
  // every EUREKA: line in any message is also filed on the knowledge board
  for (const m of body.matchAll(/^\s*EUREKA:\s*(.+)$/gim)) addKnowledge(from, m[1], runId);
  if (kind === "eureka" && !/^\s*EUREKA:/im.test(body)) addKnowledge(from, body, runId);
  return id;
}

// Seen live on qwen2.5:3b: agents prefixed plans ("I will start by testing…"), invitations
// ("Let's brainstorm…") and even non-findings ("No recent discoveries…") with EUREKA:, and
// filed near-identical rewordings, flooding the board every prompt reads. A finding states
// something learned; intentions, requests, questions and "nothing found" are not findings.
const NOT_A_FINDING = [
  /^(i|we)\s*(will|'ll|am going to|are going to|plan to|shall)\b/i,
  /^(let'?s|let us|please|once|next,?|first,?|i propose|we propose|i suggest|we should (start|begin|also consider|consider))\b/i,
  /\b(no|nothing)\s+(new|recent|specific|notable)?\s*(discover(y|ies)|findings?|insights?)\b/i,
];
export function isFinding(t) {
  const s = String(t || "").trim();
  if (s.length < 20 || /\?\s*$/.test(s)) return false;
  return !NOT_A_FINDING.some(re => re.test(s));
}
const words = s => new Set(String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []);
export function similar(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / (A.size + B.size - n);
}

export function addKnowledge(agent, text, runId = "") {
  const t = clean(text, 1000);
  if (!t || !isFinding(t)) return null;
  // the same insight twice is one insight, and so is the same insight reworded
  if (db.prepare("SELECT 1 FROM knowledge WHERE lower(text)=lower(?)").get(t)) return null;
  const recent = db.prepare("SELECT text FROM knowledge ORDER BY id DESC LIMIT 60").all();
  if (recent.some(r => similar(r.text, t) >= 0.7)) return null;
  const info = db.prepare("INSERT INTO knowledge (ts, agent, text, run_id) VALUES (datetime('now'),?,?,?)").run(name(agent), t, clean(runId, 128));
  lattice.record("eureka", { agent: name(agent), runId, text: t });
  return Number(info.lastInsertRowid);
}

// Unread messages for an agent (addressed to it, or broadcast by someone else), oldest first.
export function inbox(agent, { limit = 20 } = {}) {
  const me = name(agent);
  const last = db.prepare("SELECT last_id FROM cursors WHERE agent=?").get(me)?.last_id || 0;
  const rows = db.prepare(`SELECT id, ts, from_agent AS "from", to_agent AS "to", kind, text FROM dialogue
    WHERE id > ? AND (to_agent = ? OR (to_agent = '*' AND from_agent != ?)) ORDER BY id LIMIT ?`)
    .all(last, me, me, Math.min(Math.max(1, Number(limit) || 20), 100));
  if (rows.length) db.prepare("INSERT INTO cursors (agent, last_id) VALUES (?,?) ON CONFLICT(agent) DO UPDATE SET last_id=excluded.last_id")
    .run(me, rows.at(-1).id);
  return rows;
}

export function feed({ runId, limit = 50, kind } = {}) {
  const where = [], args = [];
  if (runId) { where.push("run_id = ?"); args.push(String(runId)); }
  if (kind && KINDS.includes(kind)) { where.push("kind = ?"); args.push(kind); }
  const rows = db.prepare(`SELECT id, ts, run_id AS runId, from_agent AS "from", to_agent AS "to", kind, text FROM dialogue
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(Math.max(1, Number(limit) || 50), 500));
  return rows.reverse();
}

export function knowledge({ q, limit = 20 } = {}) {
  const n = Math.min(Math.max(1, Number(limit) || 20), 200);
  const rows = q
    ? db.prepare("SELECT id, ts, agent, text FROM knowledge WHERE text LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?")
        .all(`%${String(q).replace(/[\\%_]/g, c => "\\" + c)}%`, n)
    : db.prepare("SELECT id, ts, agent, text FROM knowledge ORDER BY id DESC LIMIT ?").all(n);
  return rows;
}

// What gets appended to every agent's system prompt.
export function teamContext(n = 5) {
  const k = knowledge({ limit: n });
  const lines = [ENGLISH_STYLE];
  if (k.length) lines.push("Team knowledge (discoveries your teammates made):\n" + k.map(e => `- ${e.text} (${e.agent})`).join("\n"));
  return lines.join("\n\n");
}

// ---------- tools ----------
export function dialogueTools() {
  return [
    {
      name: "team.say",
      description: "Send a message to the team channel: to one teammate by id, or to everyone ('*'). Use kind 'eureka' for a discovery the whole team should remember.",
      parameters: { type: "object", properties: {
        text: { type: "string" }, to: { type: "string", description: "teammate id or * (default)" },
        kind: { type: "string", enum: ["note", "ask", "answer", "eureka"] } }, required: ["text"] },
      async run({ text, to = "*", kind = "note" } = {}, ctx) {
        if (kind === "human") kind = "note";
        try { return { ok: true, id: post({ from: ctx?.agent || "agent", to, kind, text, runId: ctx?.run?.runId }) }; }
        catch (e) { return { error: e.message }; }
      }
    },
    {
      name: "team.inbox",
      description: "Read the messages teammates sent you (and team broadcasts) that you have not read yet, oldest first.",
      parameters: { type: "object", properties: { limit: { type: "number" } } },
      async run({ limit } = {}, ctx) { return { messages: inbox(ctx?.agent || "agent", { limit }) }; }
    },
    {
      name: "team.knowledge",
      description: "Search the team knowledge board: discoveries (eurekas) any teammate recorded.",
      parameters: { type: "object", properties: { q: { type: "string" } } },
      async run({ q } = {}) { return { entries: knowledge({ q, limit: 20 }) }; }
    }
  ];
}

// ---------- council: a real round-table between named agents ----------
export async function council({ topic, agents, rounds = 1, runAgent, tools, getAgent, runId = "" }) {
  topic = clean(topic, 2000);
  if (!topic) throw new Error("topic required");
  const roster = [...new Set((Array.isArray(agents) ? agents : []).map(a => String(a)))].map(getAgent).filter(Boolean).slice(0, 6);
  if (roster.length < 2) throw new Error("a council needs at least 2 known agents");
  rounds = Math.min(Math.max(1, Math.floor(Number(rounds)) || 1), 4);
  runId = runId || `council-${Date.now().toString(36)}`;
  post({ from: "human", kind: "human", text: topic, runId });
  for (let r = 0; r < rounds; r++) {
    for (const a of roster) {
      const thread = feed({ runId, limit: 30 }).map(m => `${m.from}${m.to !== "*" ? ` → ${m.to}` : ""}: ${m.text}`).join("\n\n");
      const prompt = `You are ${a.name || a.id} in a team council (round ${r + 1} of ${rounds}).\n` +
        `Topic: ${topic}\n\nConversation so far:\n${thread}\n\n` +
        "Use your tools or skills if they help. Then reply to your teammates in a short paragraph of proper English: " +
        "build on or challenge what they said, and end with one concrete next step. Add an \"EUREKA:\" line only for a genuinely new insight.";
      let text;
      try { text = await runAgent(a, prompt, tools, { runId, agentName: a.id, maxSteps: 4 }); }
      catch (e) { text = `I could not take my turn because of an error: ${e.message}`; }
      if (typeof text !== "string") text = JSON.stringify(text);
      post({ from: a.id, kind: "note", text: text || "(no reply)", runId });
    }
  }
  return { runId, dialogue: feed({ runId, limit: 200 }), eurekas: knowledge({ limit: 10 }) };
}
