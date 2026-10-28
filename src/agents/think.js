import { LLM } from "../llm/provider.js";

const llm = new LLM();

// Grok's Think mode equivalent: give the model an explicit reasoning budget,
// then a self-critique pass before the final answer.
export async function thinkAnswer(question, { passes = 2 } = {}) {
  let reasoning = "";
  for (let i = 0; i < passes; i++) {
    const r = await llm.chat([
      { role: "system", content: `Think step by step in depth. Pass ${i + 1} of ${passes}. ${i > 0 ? "Critique and correct your previous reasoning." : ""} End with the strongest reasoning you can produce.` },
      { role: "user", content: `${question}\n\nPrevious reasoning:\n${reasoning || "(none)"}` }
    ], { temperature: 0.2 });
    reasoning = r.content;
  }
  const final = await llm.chat([
    { role: "system", content: "Using the validated reasoning, give the final concise answer. No reasoning steps in the output." },
    { role: "user", content: `Question: ${question}\n\nReasoning:\n${reasoning}` }
  ], { temperature: 0.1 });
  return final.content;
}
