// The agents' evolution loop — the system reviews its own runs and writes
// EVOLVE.md, the same sequential process the developers used:
// observe -> conclude -> propose.
//
// It scans the Eternal CodeX JSONL run logs under /app/data (corrupt lines
// are skipped, never crash), counts tool calls and errors, lists the
// recorded skills, and writes /app/data/EVOLVE.md with the next proposed
// evolutions. CI runs it after the live tests; run it yourself with:
//   docker compose exec grok-bot node scripts/evolve.js
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

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
          let ev;
          try { ev = JSON.parse(t); } catch { continue; }   // corrupt line: skip
          stats.events++;
          const kind = String(ev.kind || ev.type || "event");
          stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
          const tool = ev.tool || ev.name;
          if (kind.includes("tool") && tool) {
            stats.toolCalls[tool] = (stats.toolCalls[tool] || 0) + 1;
          }
          if (kind.includes("error") || ev.error) stats.errors++;
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

function latestObservation() {
  const file = join(DATA, "observations", "latest.json");
  try { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null; }
  catch { return null; }
}

function propose(stats, skills, observation) {
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
  if (!observation) {
    p.push("- No persisted S-mode observation exists yet — run scripts/squad-observe.js and review its evidence report.");
  } else {
    for (const gap of (observation.failures || []).slice(0, 5)) {
      p.push(`- Runtime observation gap: ${String(gap).slice(0, 240)} — fix it and rerun the observation gate.`);
    }
    if (!observation.grokToAvrone?.ok) {
      p.push("- Grok Bot → AVRONE bridge is not evidenced green — diagnose the avrone.squad receipt before release.");
    }
    if (!observation.avroneToGrok?.ok) {
      p.push("- AVRONE → Grok Bot bridge is not evidenced green — inspect grokbot.bridge CodeX receipts and tool routing.");
    }
    if (!(observation.grokSquad?.overlappingPairs > 0)) {
      p.push("- Two-worker overlap is not evidenced — inspect SQUAD_N, governor target, and worker start/finish traces.");
    }
    if (!(observation.failures || []).length) {
      p.push("- Latest S-mode and bridge checks report no gaps; rerun after every runtime/configuration change to prevent stale evidence.");
    }
  }
  p.push("- Re-run the model bench (tools/model_bench.py) after any model or stack change; keep the measured winner as the default.");
  return p;
}

const stats = scanRuns();
const skills = listSkills();
const observation = latestObservation();
const toolLines = top(stats.toolCalls, 8);
const observationLines = observation ? [
  `- Observation created: ${observation.createdAt || "unknown"}`,
  `- Grok Bot ready: ${observation.grokBot?.summary?.ready ?? "unknown"}`,
  `- AVRONE reachable: ${observation.avrone?.ok === true}`,
  `- S-mode workers/findings: ${observation.grokSquad?.spawned ?? 0}/${observation.grokSquad?.successfulFindings ?? 0}`,
  `- Worker overlap pairs: ${observation.grokSquad?.overlappingPairs ?? 0}`,
  `- Forward bridge: ${observation.grokToAvrone?.ok === true}; reverse bridge: ${observation.avroneToGrok?.ok === true}`,
  ...(observation.conclusions || []).slice(0, 8).map(c => `- ${String(c).slice(0, 300)}`)
] : ["- No observation artifact found."];
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
  "## Latest runtime observation",
  "",
  ...observationLines,
  "",
  "Full evidence: `observations/latest.md` and `observations/latest.json`.",
  "",
  "## Proposed next evolutions",
  "",
  ...propose(stats, skills, observation),
  ""
].join("\n");

try { mkdirSync(DATA, { recursive: true }); } catch { /* exists */ }
writeFileSync(join(DATA, "EVOLVE.md"), md);
console.log(md);
if (process.argv.includes("--check")) console.log("[evolve] loop OK: EVOLVE.md written");
