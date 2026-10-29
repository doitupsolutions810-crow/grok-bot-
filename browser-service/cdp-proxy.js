// Exposes the Chromium DevTools endpoint to the compose network.
// Chromium only ever listens on 127.0.0.1, so clients in other containers
// cannot reach it directly. This proxy forwards the DevTools HTTP endpoints
// and the CDP websocket, and rewrites the reported host so the client
// resolves the websocket through this proxy.
const http = require("node:http");
const net = require("node:net");

const CDP_HOST = "127.0.0.1";
const CDP_PORT = Number(process.env.CDP_PORT || 9222);
const LISTEN_PORT = Number(process.env.CDP_PROXY_PORT || 3000);

function rewriteHost(value, requestHost) {
  return String(value)
    .replaceAll(`${CDP_HOST}:${CDP_PORT}`, requestHost)
    .replaceAll(`localhost:${CDP_PORT}`, requestHost);
}

function proxyHttp(req, res) {
  // Playwright probes /json/version/ (trailing slash); Chromium only serves
  // the canonical path.
  const path = req.url.replace(/^\/json\/version\/?$/, "/json/version");
  const upstream = http.request({
    host: CDP_HOST,
    port: CDP_PORT,
    path,
    method: req.method,
    headers: { ...req.headers, host: `${CDP_HOST}:${CDP_PORT}` }
  }, up => {
    const isJson = String(up.headers["content-type"] || "").includes("json");
    if (!isJson) {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
      return;
    }
    let body = "";
    up.on("data", chunk => { body += chunk; });
    up.on("end", () => {
      const rewritten = rewriteHost(body, req.headers.host || `localhost:${LISTEN_PORT}`);
      const headers = { ...up.headers, "content-length": Buffer.byteLength(rewritten) };
      res.writeHead(up.statusCode, headers);
      res.end(rewritten);
    });
  });
  upstream.on("error", () => { res.writeHead(502); res.end("CDP proxy: browser unreachable"); });
  req.pipe(upstream);
}

function proxyWebSocket(req, socket, head) {
  const upstream = net.connect(CDP_PORT, CDP_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      const value = key.toLowerCase() === "host" ? `${CDP_HOST}:${CDP_PORT}` : req.rawHeaders[i + 1];
      lines.push(`${key}: ${value}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

const server = http.createServer(proxyHttp);
server.on("upgrade", proxyWebSocket);
server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`CDP proxy on :${LISTEN_PORT} -> ${CDP_HOST}:${CDP_PORT}`);
});
