import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { buildSwarmEvidence, canonicalJson } from "./swarm-evidence.js";

const keys = generateKeyPairSync("ed25519");
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicKey = keys.publicKey;
const base = {
  jobId: "job-42", role: "tester", executor: "spiffe://prod/agent/grok-bot",
  runId: "swarm-job-42-tester", answer: JSON.stringify({ tests: [{ command: "npm test", exit_code: 0 }] }),
  events: [{ kind: "tool.result", tool: "terminal", ok: true, exitCode: 0, stdout_sha256: null, stderr_sha256: null }],
  startedAt: "2026-11-03T08:00:00.000Z", completedAt: "2026-11-03T08:00:01.000Z", privateKeyPem,
};

test("creates verifiable evidence for a real successful tester tool result", () => {
  const result = buildSwarmEvidence(base);
  assert.equal(result.evidence.status, "succeeded");
  assert.equal(result.evidence.job_id, base.jobId);
  assert.equal(verify(null, Buffer.from(canonicalJson(result.evidence)), publicKey, Buffer.from(result.signature, "base64")), true);
});

test("fails closed when no tools ran or any tool failed", () => {
  assert.equal(buildSwarmEvidence({ ...base, events: [] }).evidence.status, "failed");
  assert.equal(buildSwarmEvidence({ ...base, events: [{ kind: "tool.result", tool: "terminal", ok: false, exitCode: 127 }] }).evidence.status, "failed");
});

test("does not accept a passing report without a successful terminal command", () => {
  const result = buildSwarmEvidence({ ...base, events: [{ kind: "tool.result", tool: "terminal", ok: true, exitCode: null }] });
  assert.equal(result.evidence.status, "failed");
});

test("rejects incomplete or role-incompatible reports", () => {
  assert.equal(buildSwarmEvidence({ ...base, answer: JSON.stringify({ tests: [] }) }).evidence.status, "failed");
  assert.equal(buildSwarmEvidence({ ...base, answer: JSON.stringify({ diagnosis: "x", reproduction: "y" }) }).evidence.status, "failed");
});

test("rejects HTTP error-shaped fetches as successful debugger evidence", () => {
  const result = buildSwarmEvidence({ ...base, role: "debugger", answer: JSON.stringify({ diagnosis: "found", reproduction: "reproduced" }), events: [{ kind: "tool.result", tool: "web.fetch", ok: false, exitCode: null }] });
  assert.equal(result.evidence.status, "failed");
});

test("rejects malformed timestamps and invalid signing keys", () => {
  assert.throws(() => buildSwarmEvidence({ ...base, startedAt: "yesterday" }), /timestamps/);
  assert.throws(() => buildSwarmEvidence({ ...base, privateKeyPem: "not a key" }));
});

test("hashes Unicode answer bytes deterministically", () => {
  const one = buildSwarmEvidence({ ...base, answer: "東京 🚀" });
  const two = buildSwarmEvidence({ ...base, answer: "東京 🚀" });
  assert.equal(one.evidence.answer_digest, two.evidence.answer_digest);
});