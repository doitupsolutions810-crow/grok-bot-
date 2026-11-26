import Database from "better-sqlite3";
import { dataPath } from "../paths.js";
import { readFileSync } from "node:fs";

const OLLAMA = process.env.OLLAMA_URL || "http://ollama:11434";
const db = new Database(dataPath("rag.db"));
db.exec(`CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY, source TEXT, chunk TEXT, embedding BLOB
)`);

const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

async function embed(text) {
  const res = await fetch(`${process.env.OLLAMA_URL || OLLAMA}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: String(text) }),
    signal: AbortSignal.timeout(60_000)
  });
  const r = await res.json().catch(() => ({}));
  // model not pulled → {error}; Float32Array.from(undefined) used to throw a cryptic TypeError
  if (!res.ok || !Array.isArray(r.embedding) || !r.embedding.length)
    throw new Error(`embedding failed (${res.status}): ${r.error || "no embedding"} — is ${EMBED_MODEL} pulled?`);
  return Float32Array.from(r.embedding);
}

// The BLOB holds raw float32 bytes. `new Float32Array(buffer)` converted each BYTE to a float
// (3072 bogus values for a 768-dim vector), so every search score was garbage. Copy first so
// the view is 4-byte aligned whatever offset SQLite's Buffer has.
export const blobToVec = b => new Float32Array(Uint8Array.prototype.slice.call(b, 0, b.byteLength - (b.byteLength % 4)).buffer);

export const cos = (a, b) => {
  // vectors from a different embed model (other dimension) or all-zero vectors can't be
  // compared: score them lowest instead of NaN, which broke the sort order
  if (!a?.length || a.length !== b?.length) return -1;
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2; }
  const v = d / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(v) ? v : -1;
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
    .map(r => ({ source: r.source, chunk: r.chunk, score: cos(q, blobToVec(r.embedding)) }))
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
