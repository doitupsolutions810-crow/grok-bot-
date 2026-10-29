import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/evolve.js", import.meta.url));

function runEvolve(dataDir, skillsDir, cwd) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, DATA_DIR: dataDir, SKILLS_DIR: skillsDir }
  });
}

test("evolution report skips corrupt JSONL while preserving real evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "grok-evolve-test-"));
  try {
    const dataDir = join(root, "data");
    const runDir = join(dataDir, "runs", "nested");
    const skillsDir = join(root, "skills");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(join(skillsDir, "sample-skill"), { recursive: true });
    writeFileSync(join(skillsDir, "readme.md"), "supporting notes\n", "utf8");
    writeFileSync(join(runDir, "one.jsonl"), [
      JSON.stringify({ kind: "tool.call", tool: "runtime_preflight" }),
      "{broken json",
      JSON.stringify({ kind: "tool.error", name: "fetch", error: "fixture error" })
    ].join("\n") + "\n", "utf8");

    const result = runEvolve(dataDir, skillsDir, root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = readFileSync(join(dataDir, "EVOLVE.md"), "utf8");
    assert.match(report, /from 1 run log\(s\), 2 events/);
    assert.match(report, /tool\.call: 1/);
    assert.match(report, /runtime_preflight: 1/);
    assert.match(report, /sample-skill/);
    assert.match(report, /fetch: 1/);
    assert.match(report, /error events recorded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evolution report tolerates absent run and skill directories", () => {
  const root = mkdtempSync(join(tmpdir(), "grok-evolve-empty-"));
  try {
    const dataDir = join(root, "not-yet-created-data");
    const skillsDir = join(root, "not-yet-created-skills");
    const result = runEvolve(dataDir, skillsDir, root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = readFileSync(join(dataDir, "EVOLVE.md"), "utf8");
    assert.match(report, /from 0 run log\(s\), 0 events/);
    assert.match(report, /no tool calls recorded yet/);
    assert.match(report, /- none yet/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
