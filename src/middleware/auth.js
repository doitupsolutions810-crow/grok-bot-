import { nanoid } from "nanoid";
import Database from "better-sqlite3";

const db = new Database("/app/data/auth.db");
db.exec("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created TEXT)");
const sessions = new Set(db.prepare("SELECT token FROM sessions").all().map(r => r.token));

export function issueToken() {
  const token = nanoid(32);
  db.prepare("INSERT INTO sessions VALUES (?, datetime('now'))").run(token);
  sessions.add(token);
  return token;
}

export function authRequired(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "") || req.query.token;
  if (!sessions.has(token)) return res.status(401).json({ error: "unauthorized" });
  next();
}
