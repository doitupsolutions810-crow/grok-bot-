// browser service entry (replaces `npx playwright run-server`):
// computer.js — runs inside the browser container
const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launchPersistentContext("/profile", {
    headless: true, port: 3000, viewport: { width: 1280, height: 800 }
  });
  console.log("shared computer browser on :3000 (profile at /profile)");
})();
