import { LLM } from "../llm/provider.js";

const llm = new LLM();

// Grok's DeepSearch equivalent: iterative browse-search synthesis with citations.
export async function deepSearch(query, browserTool, { rounds = 3 } = {}) {
  const sources = [];
  let synthesis = "";
  if (!browserTool?.run) return { synthesis: "DeepSearch needs the browser tool, which is not available.", sources };
  rounds = Math.min(Math.max(1, Math.floor(Number(rounds)) || 3), 8);
  const tried = new Set();
  for (let round = 0; round < rounds; round++) {
    // 1. Decide what to search next
    const next = await llm.chat([
      { role: "system", content: `You are a research agent (round ${round + 1}/${rounds}). Given the query and findings so far, output ONE concrete web URL to read next that best fills the biggest gap. Output only the URL, or DONE if you have enough.` },
      { role: "user", content: `Query: ${query}\n\nFindings so far:\n${synthesis || "(none)"}\n\nSources seen:\n${sources.map(s => s.url).join("\n") || "(none)"}` }
    ]);
    // models wrap the URL in prose/markdown ("Next: <https://…>."): take the first URL
    const out = String(next?.content || "").trim();
    const target = (out.match(/https?:\/\/[^\s<>()"'`\]]+/) || [])[0]?.replace(/[.,;:!?]+$/, "");
    if (!target || /^DONE\b/i.test(out)) break;
    if (tried.has(target)) continue;          // never re-read the same page
    tried.add(target);

    // 2. Read it with the browser tool (a dead page is skipped, not fed in as "undefined")
    let page;
    try { page = await browserTool.run({ url: target, action: "read" }); } catch (e) { page = { error: e.message }; }
    if (page?.error || typeof page?.content !== "string") { sources.push({ url: target, error: page?.error || "no content" }); continue; }
    sources.push({ url: page.url || target, title: page.title || "" });

    // 3. Synthesize incrementally, always keeping citations
    const s = await llm.chat([
      { role: "system", content: "Synthesize everything known so far about the query. Always attribute facts to their source URL inline as markdown links. Keep it factual." },
      { role: "user", content: `Query: ${query}\n\nNew page: ${page.title} (${page.url})\n${page.content}\n\nPrevious synthesis:\n${synthesis}` }
    ]);
    if (s?.content) synthesis = s.content;
  }
  if (!synthesis) synthesis = sources.length ? "No readable sources could be synthesized." : "No sources found.";
  return { synthesis, sources };
}
