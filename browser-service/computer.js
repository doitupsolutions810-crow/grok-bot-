// browser service entry (replaces `npx playwright run-server`):
// computer.js — runs inside the browser container.
// Launches the shared persistent browser, then serves its DevTools (CDP)
// endpoint to the other containers through cdp-proxy.js. Clients connect with
// `chromium.connectOverCDP(BROWSER_WS)`.
const { chromium } = require("playwright");

(async () => {
  await chromium.launchPersistentContext("/profile", {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: ["--remote-debugging-port=9222"]
  });
  require("./cdp-proxy.js");
  console.log("shared computer browser on :3000 (profile at /profile)");
  // Keep the process (and therefore the browser) alive for the CDP clients.
  await new Promise(() => {});
})().catch(err => {
  console.error(err);
  process.exit(1);
});
