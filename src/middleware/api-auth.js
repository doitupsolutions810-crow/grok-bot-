// Control-API auth. /api can create shell-capable agents and apply harness code, so it is never
// open by default: the token is API_TOKEN, or one generated on first boot and kept in
// DATA_DIR/api-token (printed once to the server log). API_AUTH=off opts out, for a machine
// nobody else can reach. GET /api/status and /api/health stay open for boot checks.
import fs from "node:fs";
import crypto from "node:crypto";
import { dataPath } from "../paths.js";

const OPEN = new Set(["GET /status", "GET /health"]);

export function resolveToken({ env = process.env, file = dataPath("api-token"), log = console.log } = {}) {
  if (String(env.API_AUTH || "").toLowerCase() === "off") return null;
  const given = String(env.API_TOKEN || "").trim();
  if (given) {
    if (given.length < 16) throw new Error("API_TOKEN must be at least 16 characters");
    return given;
  }
  try {
    const saved = fs.readFileSync(file, "utf8").trim();
    if (saved.length >= 16) return saved;
  } catch {}
  const t = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  log(`[auth] control API token generated (kept in DATA_DIR/api-token): ${t}`);
  return t;
}

function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// extra(token) lets session tokens from POST /api/auth/token count too
export function apiAuth({ token, extra = () => false } = {}) {
  return (req, res, next) => {
    if (!token) return next();
    const path = req.path.replace(/\/+$/, "") || "/";
    if (OPEN.has(`${req.method} ${path}`)) return next();
    const h = String(req.headers.authorization || "");
    const got = (/^Bearer\s+(.+)$/i.exec(h)?.[1] || String(req.query?.token || "")).trim();
    if (got && (same(got, token) || extra(got))) return next();
    res.status(401).json({ error: "unauthorized: send Authorization: Bearer <API token>" });
  };
}
