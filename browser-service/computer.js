// browser service entry (replaces `npx playwright run-server`):
// computer.js — runs inside the browser container
//
// Playwright drives Chromium over --remote-debugging-pipe, which leaves the CDP
// HTTP server bound to loopback only — and it refuses requests whose Host header
// is a name (only an IP or localhost is allowed). So this service forwards the
// public port to that loopback endpoint, rewriting the request's Host header to
// this container's own IP: sibling containers reach it by service name, and the
// ws:// URL /json/version hands back still points at an address they can dial.
const net = require("node:net");
const os = require("node:os");
const { chromium } = require("playwright");

const CDP_PORT = 9222;
const PUBLIC_PORT = 3000;

function primaryIPv4() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const addr of list || []) if (addr.family === "IPv4" && !addr.internal) return addr.address;
  return "127.0.0.1";
}

async function main() {
  // `port` is only valid for launchServer(); a persistent profile needs a real
  // context instead, so CDP comes from Chrome's own debugging port.
  const browser = await chromium.launchPersistentContext("/profile", {
    headless: true, viewport: { width: 1280, height: 800 },
    args: [`--remote-debugging-port=${CDP_PORT}`]
  });

  const publicHost = `${primaryIPv4()}:${PUBLIC_PORT}`;
  net.createServer(client => {
    const upstream = net.connect(CDP_PORT, "127.0.0.1");
    let pending = Buffer.alloc(0);
    let upgraded = false;
    const fail = () => { client.destroy(); upstream.destroy(); };
    client.on("error", fail);
    upstream.on("error", fail);
    upstream.on("close", () => client.destroy());
    client.on("close", () => upstream.destroy());
    // Rewrite Host in the first request header block, then pass bytes through.
    client.on("data", chunk => {
      if (upgraded) return upstream.write(chunk);
      pending = Buffer.concat([pending, chunk]);
      if (pending.indexOf("\r\n\r\n") === -1 && pending.length < 65536) return;
      const head = pending.toString("latin1").replace(/^Host:.*$/mi, `Host: ${publicHost}`);
      pending = Buffer.alloc(0);
      upgraded = true;
      upstream.write(head, "latin1");
    });
    upstream.on("data", chunk => client.write(chunk));
  }).listen(PUBLIC_PORT, "0.0.0.0",
    () => console.log(`shared computer browser on :${PUBLIC_PORT} (CDP ${CDP_PORT} as ${publicHost}, profile at /profile, ${browser.pages().length} page)`));
}

main().catch(err => { console.error("browser service failed:", err); process.exit(1); });
