import Database from "better-sqlite3";
import { dataPath } from "../paths.js";

const db = new Database(dataPath("approvals.db"));
db.exec(`CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, ts TEXT, agent TEXT, tool TEXT, args TEXT, status TEXT DEFAULT 'pending'
)`);

const DANGER = process.env.REVIEW_PATTERNS
  ? new RegExp(process.env.REVIEW_PATTERNS)
  : /rm\s+-rf|mkfs|dd\s+if=|curl[^|]*\|\s*(ba)?sh|docker\s+(rm|rmi|kill)|git\s+push\s+--force|shutdown|reboot/i;

export function needsReview(tool, args) {
  if (tool === "terminal" && DANGER.test(String(args?.command ?? ""))) return true;
  return ["imagegen", "x.search"].includes(tool) && process.env.REVIEW_SENSITIVE === "true";
}

export function createApproval(agent, tool, args) {
  // better-sqlite3 reports the new key as lastInsertRowid (a Number here)
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO approvals (ts, agent, tool, args) VALUES (datetime('now'),?,?,?)"
  ).run(agent, tool, JSON.stringify(args ?? {}));
  return Number(lastInsertRowid);
}
export function pending() {
  return db.prepare("SELECT id, ts, agent, tool, args, status FROM approvals WHERE status='pending'").all();
}
export function decide(id, approve) {
  db.prepare("UPDATE approvals SET status=? WHERE id=?").run(approve ? "approved" : "rejected", id);
}
export function approvalStatus(id) {
  return db.prepare("SELECT status FROM approvals WHERE id=?").get(id)?.status || null;
}
export function isApproved(id) {
  return db.prepare("SELECT status FROM approvals WHERE id=?").get(id)?.status === "approved";
}

// held calls: the agent thread paused mid-loop, waiting for this approval to resume
const held = new Map();
export function saveHeld(id, state) { held.set(id, state); }
export function takeHeld(id) { const s = held.get(id); held.delete(id); return s; }   // claim exactly once → idempotent approve
