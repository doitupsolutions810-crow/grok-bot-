import Database from "better-sqlite3";
import { LLM } from "../llm/provider.js";

const db = new Database("/app/data/memory.db");
const llm = new LLM();

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY, session TEXT, role TEXT, content TEXT, ts TEXT
  );
  CREATE TABLE IF NOT EXISTS summaries (
    session TEXT PRIMARY KEY, summary TEXT, updated TEXT
  );
`);

export async function remember(session, role, content) {
  db.prepare("INSERT INTO messages (session, role, content, ts) VALUES (?,?,?,datetime('now'))")
    .run(session, role, content);
  // Rolling summary: compact old context each turn (Grok-style "remembers past chats")
  const count = db.prepare("SELECT COUNT(*) c FROM messages WHERE session=?").get(session).c;
  if (count % 20 === 0) {
    const prior = db.prepare("SELECT summary FROM summaries WHERE session=?").get(session)?.summary || "";
    const recent = db.prepare("SELECT role, content FROM messages WHERE session=? ORDER BY id DESC LIMIT 20").all(session)
      .map(m => `${m.role}: ${m.content}`).join("\n");
    const r = await llm.chat([
      { role: "system", content: "Merge the previous long-term summary with the recent messages into one compact long-term memory of durable facts, preferences, and decisions. Output only the summary." },
      { role: "user", content: `Previous summary:\n${prior}\n\nRecent:\n${recent}` }
    ]);
    db.prepare("INSERT INTO summaries (session, summary, updated) VALUES (?,?,datetime('now')) ON CONFLICT(session) DO UPDATE SET summary=excluded.summary, updated=excluded.updated")
      .run(session, r.content);
  }
}

export function recall(session) {
  const s = db.prepare("SELECT summary FROM summaries WHERE session=?").get(session);
  const recent = db.prepare("SELECT role, content FROM messages WHERE session=? ORDER BY id DESC LIMIT 8").all(session);
  return { longTerm: s?.summary || "", recent };
}

export function memoryContext(session) {
  const { longTerm, recent } = recall(session);
  const lines = [];
  if (longTerm) lines.push(`Long-term memory about this user:\n${longTerm}`);
  if (recent.length) lines.push(`Recent conversation:\n${recent.map(m => `${m.role}: ${m.content}`).join("\n")}`);
  return lines.join("\n\n");
}
