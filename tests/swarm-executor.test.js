import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, createHash } from "node:crypto";
import { createSwarmExecutor, canonicalJson, tokenMatches } from "../src/swarm/executor.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const sha = value => "sha256:" + createHash("sha256").update(String(value)).digest("hex");
function verifyEvidence(evidence, signature) {
  return verify(null, Buffer.from(canonicalJson(evidence)), publicPem, Buffer.from(signature, "base64"));
}

function harness({ role, answer = "Root cause found and reproduced in the isolated workspace.", terminalResults = [], inventory = "a".repeat(64) + "  ./src/fix.js\n", now = () => 1730000000000 } = {}) {
  const calls = [];
  const terminal = {
    name: "terminal", description: "terminal", parameters: {},
    async run(args) {
      calls.push(args.command);
      if (args.command.includes("artifact inventory") || args.command.startsWith("git rev-parse")) return { ok: true, stdout: inventory, stderr: "" };
      const result = terminalResults.shift() || { ok: true, stdout: "test output", stderr: "" };
      return result;
    }
  };
  const execute = createSwarmExecutor({
    tools: [terminal], executorId: "spiffe://test/executor", privateKeyPem: privatePem,
    now, runAgent: async (_agent, _prompt, wrapped) => {
      await wrapped.find(t => t.name === "terminal").run({ command: ["tester", "governance"].includes(role) ? "npm test" : "node --check src/fix.js" });
      return answer;
    }
  });
  return { execute, calls };
}

test("canonical JSON sorts object keys recursively and rejects unsafe values", () => {
  assert.equal(canonicalJson({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}');
  assert.throws(() => canonicalJson({ x: undefined }), /unsafe JSON/);
  assert.throws(() => canonicalJson({ x: NaN }), /non-finite/);
});

test("token comparison rejects short, wrong, and different-length values", () => {
  const secret = "s".repeat(40);
  assert.equal(tokenMatches(secret, secret), true);
  assert.equal(tokenMatches(secret, "x".repeat(40)), false);
  assert.equal(tokenMatches(secret, "s".repeat(39)), false);
  assert.equal(tokenMatches("short", "short"), false);
});

test("signs evidence with Ed25519 and includes an actual terminal tool result", async () => {
  const { execute } = harness({ role: "debugger" });
  const out = await execute({ jobId: "job-1", role: "debugger", objective: "Diagnose the failing service." });
  assert.equal(out.status, 200);
  assert.equal(out.body.evidence.status, "succeeded");
  assert.equal(out.body.evidence.tool_results[0].tool, "terminal");
  assert.equal(verifyEvidence(out.body.evidence, out.body.evidence_signature), true);
});

test("coder evidence fails when no changed artifact is present", async () => {
  const { execute } = harness({ role: "coder", inventory: "" });
  const out = await execute({ jobId: "job-2", role: "coder", objective: "Implement the requested patch." });
  assert.equal(out.status, 422);
  assert.equal(out.body.evidence.status, "failed");
  assert.equal(out.body.evidence.report.artifacts.length, 0);
  assert.equal(verifyEvidence(out.body.evidence, out.body.evidence_signature), true);
});

test("coder evidence lists only safe changed paths and SHA-256 digests", async () => {
  const inventory = `${"b".repeat(64)}  ./src/fix.js\n${"c".repeat(64)}  ./../escape.js\n${"d".repeat(64)}  ./node_modules/pkg/index.js\n${"e".repeat(64)}  ./secrets/private.pem\n${"f".repeat(64)}  ./.env\n`;
  const { execute } = harness({ role: "coder", inventory });
  const out = await execute({ jobId: "job-3", role: "coder", objective: "Implement the requested patch." });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.evidence.report.artifacts, [{ path: "src/fix.js", sha256: "b".repeat(64) }]);
});

test("tester evidence requires a successful test command", async () => {
  const { execute } = harness({ role: "tester" });
  const out = await execute({ jobId: "job-4", role: "tester", objective: "Run the tests." });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.evidence.report.tests, [{ command: "npm test", exit_code: 0 }]);
});

test("tester evidence fails when the test command fails", async () => {
  const { execute } = harness({ role: "tester", terminalResults: [{ ok: false, stdout: "", stderr: "failed" }] });
  const out = await execute({ jobId: "job-5", role: "tester", objective: "Run the tests." });
  assert.equal(out.status, 422);
});

test("governance rejects without explicit approval and successful checks", async () => {
  const { execute } = harness({ role: "governance", answer: "The code appears fine." });
  const out = await execute({ jobId: "job-6", role: "governance", objective: "Review the changes." });
  assert.equal(out.status, 422);
  assert.equal(out.body.evidence.report.decision, "reject");
});

test("governance approves only with explicit decision, tests and artifacts", async () => {
  const { execute } = harness({ role: "governance", answer: "Independent review complete.\nDECISION: APPROVE" });
  const out = await execute({ jobId: "job-7", role: "governance", objective: "Review the changes." });
  assert.equal(out.status, 200);
  assert.equal(out.body.evidence.report.decision, "approve");
  assert.ok(out.body.evidence.report.checks.every(check => check.passed));
});

test("rejects malformed job IDs, roles, objectives and non-Ed25519 keys", async () => {
  const { execute } = harness({ role: "debugger" });
  await assert.rejects(() => execute({ jobId: "../escape", role: "debugger", objective: "ok" }), /invalid jobId/);
  await assert.rejects(() => execute({ jobId: "job", role: "admin", objective: "ok" }), /invalid specialist role/);
  await assert.rejects(() => execute({ jobId: "job", role: "debugger", objective: "" }), /objective/);
  assert.throws(() => createSwarmExecutor({ tools: [], runAgent: async () => "", executorId: "x", privateKeyPem: publicPem }), /private key/);
});
