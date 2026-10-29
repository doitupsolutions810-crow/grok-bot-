import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dataFile } from "../paths.js";

const OLLAMA = process.env.OLLAMA_URL || "http://ollama:11434";
const db = new Database(dataFile("rag.db"));
db.exec(`CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, source TEXT, chunk TEXT, embedding BLOB
)`);

const EMBED_MODEL = "nomic-embed-text";

async function embed(text) {
  const r = await fetch(`${OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
  }).then(r => r.json());
  return Float32Array.from(r.embedding);
}

const cos = (a, b) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

// Grok API's "Files + Collections" equivalent, fully self-hosted.
export async function ingest(path, { size = 1200 } = {}) {
  const text = readFileSync(path, "utf-8");
  const ins = db.prepare("INSERT INTO chunks (source, chunk, embedding) VALUES (?,?,?)");
  for (let i = 0; i < text.length; i += size) {
    const chunk = text.slice(i, i + size);
    const e = await embed(chunk);
    ins.run(path, chunk, Buffer.from(e.buffer));
  }
}

export async function search(query, k = 5) {
  const q = await embed(query);
  const rows = db.prepare("SELECT id, source, chunk, embedding FROM chunks").all();
  return rows
    .map(r => ({ source: r.source, chunk: r.chunk, score: cos(q, new Float32Array(r.embedding)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export const ragTool = {
  name: "rag.search",
  description: "Semantic search over the user's ingested documents. Returns the most relevant passages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  async run({ query }) {
    const hits = await search(query);
    return { results: hits.map(h => ({ source: h.source, passage: h.chunk, score: +h.score.toFixed(3) })) };
  }
};
