// The agents' evolution loop — the system reviews its own runs and writes
// EVOLVE.md, the same sequential process the developers used:
// observe -> conclude -> propose.
//
// It scans the Eternal CodeX JSONL run logs under /app/data (corrupt lines
// are skipped, never crash), counts tool calls and errors, lists the
// recorded skills, and writes /app/data/EVOLVE.md with the next proposed
// evolutions. CI runs it after the live tests; run it yourself with:
//   docker compose exec grok-bot node scripts/evolve.js
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseEventLine, recordEvent } from "./evolve-core.js";

const DATA = process.env.DATA_DIR || "/app/data";
const SKILLS = process.env.SKILLS_DIR || "/app/skills";

function scanRuns() {
  const stats = { files: 0, events: 0, byKind: {}, toolCalls: {}, errors: 0 };
  const walk = dir => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        stats.files++;
        let lines = [];
        try { lines = readFileSync(p, "utf8").split("\n"); } catch { continue; }
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          const ev = parseEventLine(t); // malformed JSON and non-object roots are skipped
          if (ev) recordEvent(stats, ev);
        }
      }
    }
  };
  walk(DATA);
  return stats;
}

function listSkills() {
  try {
    return readdirSync(SKILLS, { withFileTypes: true })
      .filter(d => d.isDirectory() || d.name.endsWith(".md"))
      .map(d => d.name);
  } catch { return []; }
}

const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

function propose(stats, skills) {
  const p = [];
  if (stats.errors > 0) {
    p.push(`- ${stats.errors} error events recorded — replay the failing flows and fix the top erroring tool first.`);
  }
  for (const [tool, n] of top(stats.toolCalls, 3)) {
    p.push(`- \`${tool}\` is the most-used tool (${n} calls) — teach a skill that makes its common flow one call.`);
  }
  if (!skills.length) {
    p.push("- No skills recorded yet — record one browser workflow so teammates can replay it.");
  }
  p.push("- Re-run the model bench (tools/model_bench.py) after any model or stack change; keep the measured winner as the default.");
  return p;
}

const stats = scanRuns();
const skills = listSkills();
const toolLines = top(stats.toolCalls, 8);
const md = [
  "# EVOLVE — the agents' own evolution report",
  "",
  `Generated ${new Date().toISOString()} from ${stats.files} run log(s), ${stats.events} events.`,
  "",
  "## Usage",
  "",
  ...top(stats.byKind, 12).map(([k, n]) => `- ${k}: ${n}`),
  "",
  "## Top tools",
  "",
  ...(toolLines.length ? toolLines.map(([t, n]) => `- ${t}: ${n}`) : ["- (no tool calls recorded yet)"]),
  "",
  "## Skills",
  "",
  ...(skills.length ? skills.map(s => `- ${s}`) : ["- none yet"]),
  "",
  "## Proposed next evolutions",
  "",
  ...propose(stats, skills),
  ""
].join("\n");

try { mkdirSync(DATA, { recursive: true }); } catch { /* exists */ }
writeFileSync(join(DATA, "EVOLVE.md"), md);
console.log(md);
if (process.argv.includes("--check")) console.log("[evolve] loop OK: EVOLVE.md written");
