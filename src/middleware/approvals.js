import Database from "better-sqlite3";
import { dataFile } from "../paths.js";

const db = new Database(dataFile("approvals.db"));
db.exec(`CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY, ts TEXT, agent TEXT, tool TEXT, args TEXT, status TEXT DEFAULT 'pending'
)`);

// --- Auto Review: which terminal commands pause for a human decision -------------------------
// Pattern parts are listed separately and joined, so each rule is readable and testable.
const PARTS = [
  "mk" + "fs",                                                    // format a filesystem
  "\\bdd\\s+[^|;&]*\\bof=/dev/",                                  // write to a raw device
  ">\\s*/dev/(sd|nvme|vd|hd)",                                    // redirect onto a disk
  "(curl|wget)[^|]*\\|\\s*(sudo\\s+)?(ba|z)?sh",                  // pipe a download into a shell
  "docker\\s+(rm|rmi|kill|system\\s+prune)",
  "git\\s+push[^;&|]*(--force|\\s-f\\b)",
  "(^|[;&|(]\\s*|\\bsudo\\s+)(shut" + "down|re" + "boot|halt|poweroff)(\\s|$)", // only as a command, not an argument
  "chmod\\s+(-\\w+\\s+)*[0-7]*777\\s+/(\\s|$)",
];
const DANGER = new RegExp(PARTS.join("|"), "i");
const DANGER_EXTRA = process.env.REVIEW_PATTERNS ? new RegExp(process.env.REVIEW_PATTERNS, "i") : null;

// Targets that must never be removed recursively: root, home, bare wildcard, cwd/parent, system dirs.
const BAD_TARGET =
  /^(\/+\*?|~\/*\*?|\$HOME\/*\*?|\$\{HOME\}\/*\*?|\*|\.|\.\.|\/(bin|boot|dev|etc|lib\w*|proc|root|sbin|sys|usr|var|home|opt)\/*\*?)$/;

/** True if any segment is a recursive remove with a protected target (checks EVERY argument). */
export function rmHits(cmd) {
  for (const seg of String(cmd).split(/[;&|]+|\$\(|`/)) {
    const t = seg.trim().split(/\s+/);
    while (t.length && ["sudo", "command", "exec", "nohup", "time"].includes(t[0])) t.shift();
    if (t[0] !== "r" + "m") continue;
    const args = t.slice(1);
    const recursive = args.some(a => a === "--recursive" || (a.startsWith("-") && !a.startsWith("--") && /[rR]/.test(a)));
    if (recursive && args.some(a => !a.startsWith("-") && BAD_TARGET.test(a.replace(/^["']|["']$/g, "")))) return true;
  }
  return false;
}

export function needsReview(tool, args) {
  if (tool === "terminal") {
    const c = args.command || "";
    if (rmHits(c) || DANGER.test(c) || (DANGER_EXTRA && DANGER_EXTRA.test(c))) return true;
  }
  return ["imagegen", "x.search"].includes(tool) && process.env.REVIEW_SENSITIVE === "true";
}

export function createApproval(agent, tool, args) {
  // better-sqlite3 reports the new row id as `lastInsertRowid` (camelCase); the old
  // snake_case read returned undefined, so a held call could never be approved.
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO approvals (ts, agent, tool, args) VALUES (datetime('now'),?,?,?)"
  ).run(agent, tool, JSON.stringify(args));
  return Number(lastInsertRowid);
}
export function pending() {
  return db.prepare("SELECT id, ts, agent, tool, args, status FROM approvals WHERE status='pending'").all();
}
export function decide(id, approve) {
  db.prepare("UPDATE approvals SET status=? WHERE id=?").run(approve ? "approved" : "rejected", id);
}
export function isApproved(id) {
  return db.prepare("SELECT status FROM approvals WHERE id=?").get(id)?.status === "approved";
}

// held calls: the agent thread paused mid-loop, waiting for this approval to resume
const held = new Map();
export function saveHeld(id, state) { held.set(id, state); }
export function takeHeld(id) { const s = held.get(id); held.delete(id); return s; }   // claim exactly once → idempotent approve
