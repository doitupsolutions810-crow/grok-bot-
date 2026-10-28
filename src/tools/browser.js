import { chromium } from "playwright";

// Connects to the shared-computer browser service over CDP. One persistent
// profile (browser_profile volume) — logins and cookies survive restarts and
// are shared between bots. We reuse the existing context/pages rather than
// creating new ones, so sessions stay warm.
async function connectCDP() {
  const ws = process.env.BROWSER_WS || "ws://browser:3000";
  let lastErr;
  // 3 attempts: a cold/restarting browser container must not fail the boot
  // self-test (or a live tool call) on a transient refusal.
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await chromium.connectOverCDP(ws); }
    catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw lastErr;
}

export const browserTool = {
  name: "browser",
  description: "Open a web page in the shared headless browser and extract readable content. Use for research, docs, and SPA pages that fetch can't render.",
  parameters: {
    type: "object",
    properties: {
      url: { "type": "string", description: "Page to open" },
      action: { "type": "string", enum: ["read", "click", "type"], description: "Default: read" },
      selector: { "type": "string", description: "Element for click/type actions" },
      text: { "type": "string", description: "Text for type action" }
    },
    required: ["url"]
  },
  async run({ url, action = "read", selector, text }) {
    const browser = await connectCDP();
    try {
      const ctx = browser.contexts()[0] || (await browser.newContext());
      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
      if (action === "click" && selector) {
        await page.click(selector);
        await page.waitForTimeout(500);
      }
      if (action === "type" && selector) {
        await page.fill(selector, text || "");
      }
      const title = await page.title();
      const content = await page.evaluate(() => document.body.innerText);
      return { title, url: page.url(), content: content.slice(0, 12_000) };
    } finally {
      await browser.close();   // closes the CDP connection, not the shared browser
    }
  }
};
