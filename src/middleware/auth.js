import { nanoid } from "nanoid";
import { timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import { dataFile } from "../paths.js";

const db = new Database(dataFile("auth.db"));
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

// Opt-in gate for the whole app (console + API). Set GROK_AUTH_PASSWORD to enable.
// Browser-native HTTP Basic auth, so the console and SSE streams work with no code changes.
// /api/health stays open for probes. Username defaults to "admin" (GROK_AUTH_USER).
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};
export function basicGate(req, res, next) {
  const pass = process.env.GROK_AUTH_PASSWORD;
  if (!pass) return next();
  if (req.path === "/api/health") return next();
  const m = /^Basic (.+)$/.exec(req.headers.authorization || "");
  if (m) {
    const [u, ...rest] = Buffer.from(m[1], "base64").toString().split(":");
    if (safeEq(u, process.env.GROK_AUTH_USER || "admin") && safeEq(rest.join(":"), pass)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Grok Bot"').status(401).send("Authentication required");
}
