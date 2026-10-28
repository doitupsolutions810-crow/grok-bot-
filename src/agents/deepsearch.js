import { LLM } from "../llm/provider.js";

const llm = new LLM();

// Grok's DeepSearch equivalent: iterative browse-search synthesis with citations.
export async function deepSearch(query, browserTool, { rounds = 3 } = {}) {
  const sources = [];
  let synthesis = "";
  for (let round = 0; round < rounds; round++) {
    // 1. Decide what to search next
    const next = await llm.chat([
      { role: "system", content: `You are a research agent (round ${round + 1}/${rounds}). Given the query and findings so far, output ONE concrete web URL to read next that best fills the biggest gap. Output only the URL, or DONE if you have enough.` },
      { role: "user", content: `Query: ${query}\n\nFindings so far:\n${synthesis || "(none)"}\n\nSources seen:\n${sources.map(s => s.url).join("\n") || "(none)"}` }
    ]);
    const target = next.content.trim();
    if (target === "DONE" || !/^https?:\/\//.test(target)) break;

    // 2. Read it with the browser tool
    const page = await browserTool.run({ url: target, action: "read" });
    sources.push({ url: page.url, title: page.title });

    // 3. Synthesize incrementally, always keeping citations
    const s = await llm.chat([
      { role: "system", content: "Synthesize everything known so far about the query. Always attribute facts to their source URL inline as markdown links. Keep it factual." },
      { role: "user", content: `Query: ${query}\n\nNew page: ${page.title} (${page.url})\n${page.content}\n\nPrevious synthesis:\n${synthesis}` }
    ]);
    synthesis = s.content;
  }
  return { synthesis, sources };
}
