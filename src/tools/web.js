// Plain HTTP fetch tool — readable text for simple pages; SPAs go to the browser tool.
export const webFetchTool = {
  name: "web.fetch",
  description: "Fetch a URL and return the raw text content (first 12k chars). Use for docs, APIs, and static pages.",
  parameters: {
    type: "object",
    properties: { url: { type: "string" }, method: { type: "string", enum: ["GET", "POST"] }, body: { type: "string" } },
    required: ["url"]
  },
  async run({ url, method = "GET", body } = {}) {
    let u;
    try { u = new URL(String(url)); } catch { return { error: "invalid url" }; }
    if (!["http:", "https:"].includes(u.protocol)) return { error: `unsupported protocol ${u.protocol}` };
    method = String(method).toUpperCase();
    if (!["GET", "POST"].includes(method)) return { error: "method must be GET or POST" };
    if (body != null && typeof body !== "string") body = JSON.stringify(body);
    const res = await fetch(u, {
      method,
      headers: { "user-agent": "GrokBot/1.0", "content-type": "application/json" },
      body: method === "POST" ? body : undefined,
      signal: AbortSignal.timeout(15_000)
    });
    const text = await res.text();
    return { status: res.status, contentType: res.headers.get("content-type"), content: text.slice(0, 12_000) };
  }
};
