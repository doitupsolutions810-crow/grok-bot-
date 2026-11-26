// Grok's signature edge is live X data. Self-hosted options:
//   1. Official X API v2 search (needs X_API_BEARER token)
//   2. Fallback: the shared browser agent scraping public mirrors
import { browserTool } from "./browser.js";

export const xSearchTool = {
  name: "x.search",
  description: "Search recent posts on X (Twitter) about a topic. Returns post text, author, and engagement.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  async run({ query } = {}) {
    if (typeof query !== "string" || !query.trim()) return { error: "query required" };
    query = query.trim().slice(0, 512);   // X API max query length
    const token = process.env.X_API_BEARER;
    if (token) {
      const url = `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=25&tweet.fields=created_at,public_metrics,author_id`;
      const resp = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
      const r = await resp.json().catch(() => ({}));
      // 401/429 used to look like "no posts"
      if (!resp.ok) return { error: `X API ${resp.status}: ${r.title || r.detail || "request failed"}` };
      return { posts: (r.data || []).map(t => ({ text: t.text, at: t.created_at, metrics: t.public_metrics })) };
    }
    // No API key: delegate to the shared browser on a public mirror
    const page = await browserTool.run({ url: `https://nitter.net/search?f=tweets&q=${encodeURIComponent(query)}` });
    if (page?.error || typeof page?.content !== "string") return { error: `X fallback scrape failed: ${page?.error || "no content"}` };
    return { scraped: true, content: page.content.slice(0, 6000) };
  }
};

export const xPostTool = {
  name: "x.post",
  description: "Post a message to X via the configured X API credentials (requires X_API_BEARER with write access).",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  async run({ text } = {}) {
    if (typeof text !== "string" || !text.trim()) return { error: "text required" };
    const token = process.env.X_API_BEARER;
    if (!token) return { error: "no X_API_BEARER configured — cannot post" };
    const r = await fetch("https://api.x.com/2/tweets", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: [...text.trim()].slice(0, 280).join("") }),   // code points: never split an emoji
      signal: AbortSignal.timeout(20_000)
    }).then(r => r.json());
    if (r.data?.id) return { posted: true, id: r.data.id };
    return { error: r };
  }
};
