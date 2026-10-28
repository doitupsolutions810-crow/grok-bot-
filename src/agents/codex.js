// Eternal CodeX — ported from Avrone (codex.py). One append-only JSONL file per run.
// Every orchestrated run (squad, deep, single agent with a runId) writes its life
// story here: plan, spawns, tool calls, merges, throttles, failures, done.
// Corrupt/truncated lines are skipped on replay — the log survives crashes.

import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const RUNS_DIR = process.env.RUNS_DIR || "/app/data/runs";
try { mkdirSync(RUNS_DIR, { recursive: true }); } catch {}

export function newRunId() {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

export function emit(runId, kind, data = {}) {
  if (!runId) return;
  try {
    appendFileSync(`${RUNS_DIR}/${runId}.jsonl`,
      JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + "\n");
  } catch (e) {
    console.warn(`[codex] emit failed for ${runId}/${kind}: ${e.message}`);
  }
}

// Replay a run: every parseable event, in order. Never throws on corruption.
export function replay(runId) {
  const file = `${RUNS_DIR}/${runId}.jsonl`;
  if (!existsSync(file)) return null;
  const events = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* corrupt/truncated line — skip */ }
  }
  const first = events[0];
  const done = events.some(e => e.kind === "run.done");
  return { runId, events, started: first?.ts || null, done };
}

// All runs, newest first.
export function runs() {
  let names = [];
  try { names = readdirSync(RUNS_DIR).filter(f => f.endsWith(".jsonl")); } catch { return []; }
  return names
    .map(f => replay(f.slice(0, -6)))
    .filter(Boolean)
    .sort((a, b) => String(b.started || "").localeCompare(String(a.started || "")));
}
