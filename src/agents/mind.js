// Each agent's mind: visible reasoning, a lasting journal, and goals it sets for itself.
//
//   mind.think    reason out loud. Any model, even one with no built-in "thinking", can lay out
//                 its reasoning step by step; the Lattice records it as a "reasoning" event.
//   mind.journal  write lessons learned / read them back. Persistent per agent, across sessions.
//   mind.goals    set its own goals, list them, mark them done.
// Evolution: an agent's recent lessons and open goals are folded into its system prompt on
// every run (mindContext), so what it learns and wants carries into how it thinks next time.
// Models that DO emit reasoning (<think>…</think>, reasoning_content, reasoning, thinking) have
// it split from the answer by splitReasoning and recorded the same way.

import fs from "node:fs";
import path from "node:path";
import * as lattice from "./lattice.js";

const dir = () => path.join(process.env.DATA_DIR || "/data", "minds");
const safeId = id => String(id || "").replace(/[^\w.-]/g, "_").slice(0, 80) || "agent";
const MAX_JOURNAL = 500, MAX_GOALS = 50;
const clean = (s, n) => (typeof s === "string" ? s : "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, n);

function load(id) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir(), `${safeId(id)}.json`), "utf8"));
    return { journal: Array.isArray(m.journal) ? m.journal : [], goals: Array.isArray(m.goals) ? m.goals : [] };
  } catch { return { journal: [], goals: [] }; }
}
function save(id, m) {
  fs.mkdirSync(dir(), { recursive: true });
  const f = path.join(dir(), `${safeId(id)}.json`);
  fs.writeFileSync(f + ".tmp", JSON.stringify(m));
  fs.renameSync(f + ".tmp", f);                       // atomic: a crash never leaves half a mind
}
export const readMind = id => load(id);

export function splitReasoning(msg) {
  if (!msg || typeof msg !== "object") return { msg, reasoning: "" };
  const parts = [];
  for (const k of ["reasoning_content", "reasoning", "thinking"]) {
    if (typeof msg[k] === "string" && msg[k].trim()) parts.push(msg[k].trim());
    delete msg[k];                                       // never echo reasoning back to the API
  }
  if (typeof msg.content === "string" && /<think>/i.test(msg.content)) {
    let c = msg.content;
    c = c.replace(/<think>([\s\S]*?)(<\/think>|$)/gi, (_m, t) => { if (t.trim()) parts.push(t.trim()); return ""; });
    msg.content = c.trim();
  }
  return { msg, reasoning: parts.join("\n\n") };
}

export function mindContext(id) {
  const m = load(id);
  const lessons = m.journal.slice(-5).map(e => `- ${e.text}`);
  const goals = m.goals.filter(g => !g.done).slice(-5).map(g => `- [${g.id}] ${g.text}`);
  if (!lessons.length && !goals.length) return "";
  return [
    "Your own mind, carried over from earlier sessions:",
    lessons.length ? `Lessons you recorded:\n${lessons.join("\n")}` : "",
    goals.length ? `Goals you set yourself (mark them done with mind.goals when met):\n${goals.join("\n")}` : "",
    "Think out loud with mind.think when a problem is hard, and record what you learn with mind.journal."
  ].filter(Boolean).join("\n");
}

export function mindTools() {
  return [
    {
      name: "mind.think",
      description: "Think out loud: lay out your reasoning, doubts, and plan step by step before acting. Your team and owner can follow it.",
      parameters: { type: "object", properties: { thought: { type: "string" } }, required: ["thought"] },
      async run({ thought } = {}, ctx) {
        const t = clean(thought, 6000);
        if (!t) return { error: "thought required" };
        lattice.record("reasoning", { agent: ctx?.agent, runId: ctx?.run?.runId, text: t });
        return { ok: true, note: "Recorded. Now act on it." };
      }
    },
    {
      name: "mind.journal",
      description: "Your lasting journal. action=write records a lesson you learned (it shapes how you think next time); action=read returns your recent entries.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["write", "read"] }, lesson: { type: "string" }, limit: { type: "number" } }, required: ["action"] },
      async run({ action, lesson, limit = 10 } = {}, ctx) {
        const id = ctx?.agent || "agent";
        const m = load(id);
        if (action === "read") return { entries: m.journal.slice(-Math.min(Math.max(1, Math.floor(Number(limit)) || 10), 100)) };
        if (action !== "write") return { error: "action must be write or read" };
        const t = clean(lesson, 1000);
        if (!t) return { error: "lesson required" };
        if (m.journal.some(e => e.text.toLowerCase() === t.toLowerCase())) return { ok: true, duplicate: true };
        m.journal.push({ ts: new Date().toISOString(), text: t });
        if (m.journal.length > MAX_JOURNAL) m.journal = m.journal.slice(-MAX_JOURNAL);
        save(id, m);
        lattice.record("reasoning", { agent: id, runId: ctx?.run?.runId, text: `Lesson learned: ${t}` });
        return { ok: true, entries: m.journal.length };
      }
    },
    {
      name: "mind.goals",
      description: "Goals you choose for yourself. action=set (goal), list, or done (id).",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["set", "list", "done"] }, goal: { type: "string" }, id: { type: "string" } }, required: ["action"] },
      async run({ action, goal, id: gid } = {}, ctx) {
        const id = ctx?.agent || "agent";
        const m = load(id);
        if (action === "list") return { goals: m.goals };
        if (action === "set") {
          const t = clean(goal, 500);
          if (!t) return { error: "goal required" };
          if (m.goals.filter(g => !g.done).length >= MAX_GOALS) return { error: `at most ${MAX_GOALS} open goals; finish some first` };
          const g = { id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: t, ts: new Date().toISOString(), done: false };
          m.goals.push(g); save(id, m);
          lattice.record("reasoning", { agent: id, runId: ctx?.run?.runId, text: `New goal: ${t}` });
          return { ok: true, goal: g };
        }
        if (action === "done") {
          const g = m.goals.find(x => x.id === gid);
          if (!g) return { error: "no such goal" };
          if (!g.done) { g.done = true; g.doneAt = new Date().toISOString(); save(id, m);
            lattice.record("eureka", { agent: id, runId: ctx?.run?.runId, text: `Goal met: ${g.text}` }); }
          return { ok: true, goal: g };
        }
        return { error: "action must be set, list, or done" };
      }
    }
  ];
}
