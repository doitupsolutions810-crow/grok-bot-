// browser service entry (replaces `npx playwright run-server`):
// computer.js — runs inside the browser container.
//
// The shared computer is a persistent-profile Chromium exposed over CDP. This
// Playwright build cannot launch a CDP server itself (`port` is rejected with
// "Cannot specify a port without launching as a server"), and Chrome only
// publishes its DevTools endpoint on loopback — so the browser service runs
// Chromium directly and shares the app container's network namespace
// (compose: network_mode: service:grok-bot). The app connects over CDP at
// BROWSER_WS=http://127.0.0.1:9222.
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");

const CDP_PORT = process.env.CDP_PORT || "9222";

const child = spawn(chromium.executablePath(), [
  "--headless=new",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  `--remote-debugging-port=${CDP_PORT}`,
  "--user-data-dir=/profile",
  "--window-size=1280,800",
  // Container has no dbus/GPU driver: keep Chromium's expected dbus/Vulkan
  // stderr noise out of the service logs (logging below FATAL, no Vulkan).
  "--log-level=3",
  "--disable-features=Vulkan",
  "about:blank"
], { stdio: "inherit" });

child.on("exit", code => process.exit(code ?? 0));
console.log(`shared computer browser on CDP :${CDP_PORT} (profile at /profile)`);
