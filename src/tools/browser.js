import { chromium } from "playwright";

// Connects to the shared-computer browser service over CDP. One persistent
// profile (browser_profile volume) — logins and cookies survive restarts and
// are shared between bots. We reuse the existing context/pages rather than
// creating new ones, so sessions stay warm.
export const browserTool = {
  name: "browser",
  description: "Open a web page in the shared headless browser and extract readable content. Use for research, docs, and SPA pages that fetch can't render.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      action: { type: "string", enum: ["read", "click", "type"], description: "Default: read" },
      selector: { type: "string", description: "Element for click/type actions" },
      text: { type: "string", description: "Text for type action" }
    },
    required: ["url"]
  },
  async run({ url, action = "read", selector, text }) {
    const browser = await chromium.connectOverCDP(process.env.BROWSER_WS || "ws://browser:3000");
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
