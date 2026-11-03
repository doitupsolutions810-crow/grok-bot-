import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { buildSwarmEvidence, canonicalJson } from "../src/agents/swarm-evidence.js";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const started = new Date().toISOString();
const completed = new Date(Date.now() + 5).toISOString();

function make(role, report, tool = "terminal") {
  return buildSwarmEvidence({
    jobId: "job-1", role, executor: "spiffe://prod/agent/grok-bot",
    runId: "swarm-job-1-" + role, answer: JSON.stringify(report),
    events: [{ kind: "tool.result", tool, ok: true, exitCode: 0, stdout_sha256: null, stderr_sha256: null }],
    startedAt: started, completedAt: completed, privateKeyPem,
  });
}

test("debugger evidence requires real tool result and reproduction", () => {
  const result = make("debugger", { diagnosis: "failing route", reproduction: "node --test tests/route.test.js" });
  assert.equal(result.evidence.status, "succeeded");
  assert.equal(verify(null, Buffer.from(canonicalJson(result.evidence)), keys.publicKey, Buffer.from(result.signature, "base64")), true);
});

test("coder and tester evidence require successful terminal execution", () => {
  assert.equal(make("coder", { artifacts: [{ path: "src/fix.js", sha256: "sha256:" + "a".repeat(64) }] }).evidence.status, "succeeded");
  assert.equal(make("tester", { tests: [{ command: "npm test", exit_code: 0 }] }).evidence.status, "succeeded");
  assert.equal(make("tester", { tests: [{ command: "npm test", exit_code: 1 }] }).evidence.status, "failed");
});

test("governance requires explicit approval and every check passing", () => {
  assert.equal(make("governance", { decision: "approve", checks: [{ name: "test evidence", passed: true }] }).evidence.status, "succeeded");
  assert.equal(make("governance", { decision: "approve", checks: [{ name: "test evidence", passed: false }] }).evidence.status, "failed");
});

test("missing tool execution and malformed reports never pass", () => {
  const result = buildSwarmEvidence({
    jobId: "job-2", role: "debugger", executor: "spiffe://prod/agent/grok-bot",
    runId: "run-2", answer: JSON.stringify({ diagnosis: "guess", reproduction: "not run" }),
    events: [], startedAt: started, completedAt: completed, privateKeyPem,
  });
  assert.equal(result.evidence.status, "failed");
});
