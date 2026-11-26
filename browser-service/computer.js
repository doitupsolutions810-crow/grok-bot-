// Shared-computer browser service (runs inside the Playwright container).
//
// Why not launchPersistentContext({ port })? Playwright has no such option, so
// nothing ever listened on :3000. Chromium only exposes CDP when started with
// --remote-debugging-port, and modern headless binds that to 127.0.0.1 and
// rejects any Host header that isn't localhost/an IP (DNS-rebinding guard).
// So: Chromium serves CDP on 127.0.0.1:CDP_PORT, and this file runs a small
// HTTP+WebSocket relay on 0.0.0.0:PORT that
//   • rewrites Host to 127.0.0.1 so Chromium accepts requests from "browser:3000"
//   • rewrites webSocketDebuggerUrl in /json/* so clients dial back through the relay
//   • maps a bare ws://browser:3000/ upgrade to the browser endpoint, so both
//     BROWSER_WS=ws://browser:3000 and http://browser:3000 work with connectOverCDP.
// The persistent profile (/profile) keeps logins and cookies across restarts.

const http = require("http");
const net = require("net");
const { chromium } = require("playwright");

const PORT = Number(process.env.PORT || 3000);
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = process.env.PROFILE_DIR || "/profile";

let browserWsPath = null;   // /devtools/browser/<id>

async function cdpVersion() {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: CDP_PORT, path: "/json/version" }, res => {
      let b = ""; res.on("data", c => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function rewriteWsUrls(body, publicHost) {
  return body.replace(/ws:\/\/(127\.0\.0\.1|localhost):\d+\//g, `ws://${publicHost}/`);
}

const server = http.createServer((req, res) => {
  const publicHost = req.headers.host || `localhost:${PORT}`;
  if (req.url === "/healthz") {
    res.writeHead(browserWsPath ? 200 : 503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: !!browserWsPath }));
  }
  // Playwright asks for /json/version/ (trailing slash); newer Chromium 404s it.
  const path = req.url.replace(/^(\/json(?:\/[a-z]+)?)\/+(\?|$)/, "$1$2");
  const up = http.request({
    host: "127.0.0.1", port: CDP_PORT, path, method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${CDP_PORT}` }
  }, ur => {
    let b = ""; ur.setEncoding("utf8");
    ur.on("data", c => (b += c));
    ur.on("end", () => {
      const out = rewriteWsUrls(b, publicHost);
      const headers = { ...ur.headers, "content-length": Buffer.byteLength(out) };
      res.writeHead(ur.statusCode || 502, headers);
      res.end(out);
    });
  });
  up.on("error", e => { res.writeHead(503); res.end(`cdp unavailable: ${e.message}`); });
  req.pipe(up);
});

// Raw TCP relay for websocket upgrades (CDP traffic is long-lived and binary-safe).
server.on("upgrade", (req, socket, head) => {
  const path = (req.url === "/" || req.url === "") && browserWsPath ? browserWsPath : req.url;
  const upstream = net.connect(CDP_PORT, "127.0.0.1", () => {
    const lines = [`${req.method} ${path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      lines.push(`${k}: ${k.toLowerCase() === "host" ? `127.0.0.1:${CDP_PORT}` : req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket); socket.pipe(upstream);
  });
  const end = () => { upstream.destroy(); socket.destroy(); };
  upstream.on("error", end); socket.on("error", end);
  upstream.on("close", end); socket.on("close", end);
});

(async () => {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1", "--no-first-run"]
  });
  if (!context.pages().length) await context.newPage();   // keep one warm page for the shared session

  for (let i = 0; i < 50 && !browserWsPath; i++) {
    try { browserWsPath = new URL((await cdpVersion()).webSocketDebuggerUrl).pathname; }
    catch { await new Promise(r => setTimeout(r, 200)); }
  }
  if (!browserWsPath) { console.error("CDP endpoint never came up"); process.exit(1); }

  server.listen(PORT, "0.0.0.0", () =>
    console.log(`shared computer browser: CDP relay on :${PORT} → 127.0.0.1:${CDP_PORT}${browserWsPath} (profile ${PROFILE})`));

  context.on("close", () => { console.error("browser context closed — exiting so the container restarts"); process.exit(1); });
  for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { await context.close().catch(() => {}); process.exit(0); });
})().catch(e => { console.error("browser service failed:", e); process.exit(1); });
