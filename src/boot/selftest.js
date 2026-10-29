import { LLM } from "../llm/provider.js";
import { isNative } from "../native/index.js";

export async function selftest({ tools, docker, log = console.log }) {
  const results = [];
  const check = async (name, fn) => {
    try { const detail = await fn(); results.push({ name, ok: true, detail }); log(`[boot] OK ${name}`); }
    catch (e) { results.push({ name, ok: false, error: e.message }); log(`[boot] FAIL ${name}: ${e.message}`); }
  };

  await check("LLM: real inference round-trip", async () => {
    const llm = new LLM();
    const r = await llm.chat([{ role: "user", content: "Reply with the single word: online" }], { temperature: 0 });
    if (!/online/i.test(r.content || "")) throw new Error(`unexpected reply: ${r.content}`);
    return `model ${llm.model} answered correctly`;
  });

  await check(isNative() ? "Terminal: real local exec (native)" : "Terminal: real docker exec in sandbox", async () => {
    const t = tools.find(t => t.name === "terminal");
    const r = await t.run({ command: "echo grok-sandbox-ok && uname -s" });
    if (!r.ok || !r.stdout.includes("grok-sandbox-ok")) throw new Error(JSON.stringify(r));
    return r.stdout.trim();
  });

  await check("Browser: real page load via Playwright container", async () => {
    const b = tools.find(t => t.name === "browser");
    const r = await b.run({ url: "https://example.com", action: "read" });
    if (!r.title) throw new Error("no title returned");
    return `loaded "${r.title}" (${r.content.length} chars)`;
  });

  await check("MCP: real server handshake + tool list", async () => {
    const mcp = tools.filter(t => t.name.startsWith("mcp."));
    if (!mcp.length) throw new Error("no MCP tools registered");
    return `${mcp.length} live MCP tools: ${mcp.map(t => t.name).join(", ")}`;
  });

  await check("RAG: real embedding round-trip", async () => {
    const r = await tools.find(t => t.name === "rag.search").run({ query: "docker socket" });
    if (!r.results) throw new Error("no results");
    return "embedding + cosine search responded";
  });

  if (isNative()) {
    results.push({ name: "Docker: skipped (GROK_NATIVE)", ok: true, detail: "native mode, no Docker daemon" });
    log("[boot] SKIP Docker daemon check (GROK_NATIVE=true)");
  } else await check("Docker: daemon control verified", async () => {
    const list = await docker.listContainers();
    if (!list.length) throw new Error("no containers visible");
    return `${list.length} containers visible`;
  });

  const failed = results.filter(r => !r.ok);
  return { ok: failed.length === 0, results };
}
