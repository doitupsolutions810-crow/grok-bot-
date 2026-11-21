import { timingSafeEqual } from "node:crypto";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function safeEqual(actual, expected) {
  const a = Buffer.from(String(actual), "utf8");
  const b = Buffer.from(String(expected), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readBasicAuthConfig(env = process.env) {
  const enabled = TRUE_VALUES.has(String(env.GROK_AUTH_REQUIRED || "").trim().toLowerCase());
  const username = String(env.GROK_AUTH_USERNAME || "crow");
  const password = String(env.GROK_AUTH_PASSWORD || "");

  if (enabled && (!username || username.includes(":") || !password)) {
    throw new Error(
      "GROK_AUTH_REQUIRED needs GROK_AUTH_USERNAME (without ':') and a non-empty GROK_AUTH_PASSWORD"
    );
  }
  return { enabled, username, password };
}

function parseBasicCredentials(header) {
  if (typeof header !== "string") return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
  if (!match) return null;

  try {
    const raw = Buffer.from(match[1], "base64");
    if (!raw.length || raw.toString("base64") !== match[1]) return null;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    const separator = decoded.indexOf(":");
    if (separator <= 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

export function createBasicAuth(config, { healthPath = "/api/health" } = {}) {
  return function basicAuth(req, res, next) {
    const path = req.path || new URL(req.url || "/", "http://localhost").pathname;
    if (!config.enabled || path === healthPath) return next();

    const supplied = parseBasicCredentials(req.headers?.authorization);
    const valid = supplied
      && safeEqual(supplied.username, config.username)
      && safeEqual(supplied.password, config.password);

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");

    if (!valid) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Grok Bot", charset="UTF-8"');
      res.status(401).json({ error: "authentication required" });
      return;
    }
    next();
  };
}
