// Shared browser sidecar: persistent Chromium profile with a network-reachable CDP endpoint.
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright");

const port = Number(process.env.BROWSER_CDP_PORT || 3000);
const address = process.env.BROWSER_CDP_ADDRESS || "0.0.0.0";
const readyUrl = `http://127.0.0.1:${port}/json/version`;

async function main() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("BROWSER_CDP_PORT must be an integer between 1 and 65535");
  }

  const args = [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=/profile`,
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=${address}`,
    "--remote-allow-origins=*",
    "about:blank"
  ];

  const child = spawn(chromium.executablePath(), args, {
    stdio: "inherit",
    env: process.env
  });

  let spawnError = null;
  let shuttingDown = false;
  child.once("error", error => { spawnError = error; });
  child.once("exit", (code, signal) => {
    if (!shuttingDown) {
      console.error(`[browser] Chromium exited unexpectedly (code=${code}, signal=${signal})`);
      process.exitCode = code && code !== 0 ? code : 1;
    }
  });

  const shutdown = signal => {
    shuttingDown = true;
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`Could not start Chromium: ${spawnError.message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chromium exited before CDP became ready (code=${child.exitCode}, signal=${child.signalCode})`);
    }
    try {
      const response = await fetch(readyUrl, { signal: AbortSignal.timeout(4_000) });
      if (response.ok) {
        const payload = await response.json();
        if (typeof payload.webSocketDebuggerUrl === "string"
            && payload.webSocketDebuggerUrl.startsWith("ws")) {
          console.log(`[browser] CDP ready on ${address}:${port}; persistent profile at /profile`);
          return;
        }
      }
    } catch {}
    await delay(1_000);
  }

  shutdown("SIGTERM");
  throw new Error(`Chromium did not expose a valid CDP endpoint at ${readyUrl}`);
}

main().catch(error => {
  console.error("[browser] fatal:", error);
  process.exitCode = 1;
});
