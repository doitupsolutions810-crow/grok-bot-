import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, createHash } from "node:crypto";
import { createSwarmExecutor, canonicalJson, tokenMatches, validateCoordinatorClaim } from "../src/swarm/executor.js";

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

test("coordinator claim validation forwards role identity and accepts an exact active claim", async () => {
  let call;
  const result = await validateCoordinatorClaim({
    coordinatorUrl: "http://coordinator:4100/",
    role: "coder", jobId: "job-42", tenant: "tenant-42", workerId: "coder-2",
    claimToken: "c".repeat(40), coordinatorToken: "r".repeat(40),
    fetchImpl: async (url, options) => {
      call = { url, options };
      return { ok: true, status: 200, json: async () => ({ valid: true, jobId: "job-42", tenant: "tenant-42", role: "coder", workerId: "coder-2", leaseExpiresAt: 999999 }) };
    }
  });
  assert.equal(result.ok, true);
  assert.equal(call.url, "http://coordinator:4100/api/worker/coder/validate");
  assert.equal(call.options.headers.authorization, "Bearer " + "r".repeat(40));
  assert.deepEqual(JSON.parse(call.options.body), { jobId: "job-42", tenant: "tenant-42", workerId: "coder-2", claimToken: "c".repeat(40) });
});

test("coordinator claim validation rejects wrong response identity, expiry, and unavailable coordinator", async () => {
  const base = {
    coordinatorUrl: "http://coordinator:4100", role: "tester", jobId: "job-1", tenant: "test-tenant",
    workerId: "tester-1", claimToken: "c".repeat(40), coordinatorToken: "r".repeat(40)
  };
  const wrong = await validateCoordinatorClaim({ ...base, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ valid: true, jobId: "job-evil", tenant: "test-tenant", role: "tester", workerId: "tester-1" }) }) });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.status, 409);
  const wrongTenant = await validateCoordinatorClaim({ ...base, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ valid: true, jobId: "job-1", tenant: "other-tenant", role: "tester", workerId: "tester-1" }) }) });
  assert.equal(wrongTenant.ok, false);
  assert.equal(wrongTenant.status, 409);
  const expired = await validateCoordinatorClaim({ ...base, fetchImpl: async () => ({ ok: false, status: 409 }) });
  assert.equal(expired.status, 409);
  const unavailable = await validateCoordinatorClaim({ ...base, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(unavailable.status, 503);
});

test("coordinator claim validation rejects malformed identities before network access", async () => {
  let calls = 0;
  const base = {
    coordinatorUrl: "http://coordinator:4100", role: "tester", jobId: "job-1",
    workerId: "tester-1", claimToken: "c".repeat(40), coordinatorToken: "r".repeat(40),
    fetchImpl: async () => { calls++; throw new Error("must not call"); }
  };
  assert.equal((await validateCoordinatorClaim({ ...base, workerId: "../escape" })).status, 400);
  assert.equal((await validateCoordinatorClaim({ ...base, claimToken: "short" })).status, 400);
  assert.equal((await validateCoordinatorClaim({ ...base, coordinatorToken: "" })).status, 503);
  assert.equal(calls, 0);
});

test("executor enforces its concurrency ceiling and releases slots after completion", async () => {
  let release;
  let started;
  let runs = 0;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const execute = createSwarmExecutor({
    tools: [], executorId: "spiffe://test/executor", privateKeyPem: privatePem, maxConcurrency: 1,
    runAgent: async () => {
      runs += 1;
      if (runs === 1) {
        started();
        await new Promise(resolve => { release = resolve; });
      }
      return "diagnostic output from a constrained test executor";
    }
  });
  const first = execute({ jobId: "capacity-1", tenant: "test-tenant", role: "debugger", objective: "Inspect." });
  await startedPromise;
  const second = await execute({ jobId: "capacity-2", tenant: "test-tenant", role: "debugger", objective: "Inspect." });
  assert.equal(second.status, 429);
  release();
  await first;
  const third = await execute({ jobId: "capacity-3", tenant: "test-tenant", role: "debugger", objective: "Inspect." });
  assert.equal(third.status, 422);
});

test("executor excludes browser and mutating task-board tools from specialist runtime", async () => {
  let names = [];
  const execute = createSwarmExecutor({
    tools: [
      { name: "terminal", run: async () => ({ ok: true, stdout: "pwd", stderr: "" }) },
      { name: "browser", run: async () => ({ ok: true }) },
      { name: "task.board", run: async () => ({ ok: true }) }
    ],
    executorId: "spiffe://test/executor", privateKeyPem: privatePem,
    runAgent: async (_agent, _prompt, tools) => {
      names = tools.map(tool => tool.name);
      await tools[0].run({ command: "pwd" });
      return "diagnostic output from terminal inspection";
    }
  });
  await execute({ jobId: "tool-filter", tenant: "test-tenant", role: "debugger", objective: "Inspect." });
  assert.deepEqual(names, ["terminal"]);
});

test("tenant-scoped workspaces do not collide for identical job IDs", async () => {
  const workspaceNames = [];
  const execute = createSwarmExecutor({
    tools: [], executorId: "spiffe://test/executor", privateKeyPem: privatePem,
    runAgent: async (_agent, _prompt, _tools, options) => {
      workspaceNames.push(options.agentName);
      return "diagnostic output from a workspace with no terminal tool";
    }
  });
  await execute({ jobId: "same-job", tenant: "tenant-a", role: "debugger", objective: "Inspect the workspace." });
  await execute({ jobId: "same-job", tenant: "tenant-b", role: "debugger", objective: "Inspect the workspace." });
  assert.notEqual(workspaceNames[0], workspaceNames[1]);
});

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
  const out = await execute({ jobId: "job-1", tenant: "test-tenant", role: "debugger", objective: "Diagnose the failing service." });
  assert.equal(out.status, 200);
  assert.equal(out.body.evidence.status, "succeeded");
  assert.equal(out.body.evidence.tool_results[0].tool, "terminal");
  assert.equal(verifyEvidence(out.body.evidence, out.body.evidence_signature), true);
});

test("coder evidence fails when no changed artifact is present", async () => {
  const { execute } = harness({ role: "coder", inventory: "" });
  const out = await execute({ jobId: "job-2", tenant: "test-tenant", role: "coder", objective: "Implement the requested patch." });
  assert.equal(out.status, 422);
  assert.equal(out.body.evidence.status, "failed");
  assert.equal(out.body.evidence.report.artifacts.length, 0);
  assert.equal(verifyEvidence(out.body.evidence, out.body.evidence_signature), true);
});

test("coder evidence lists only safe changed paths and SHA-256 digests", async () => {
  const inventory = `${"b".repeat(64)}  ./src/fix.js\n${"c".repeat(64)}  ./../escape.js\n${"d".repeat(64)}  ./node_modules/pkg/index.js\n${"e".repeat(64)}  ./secrets/private.pem\n${"f".repeat(64)}  ./.env\n`;
  const { execute } = harness({ role: "coder", inventory });
  const out = await execute({ jobId: "job-3", tenant: "test-tenant", role: "coder", objective: "Implement the requested patch." });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.evidence.report.artifacts, [{ path: "src/fix.js", sha256: "sha256:" + "b".repeat(64) }]);
});

test("tester evidence requires a successful test command", async () => {
  const { execute } = harness({ role: "tester" });
  const out = await execute({ jobId: "job-4", tenant: "test-tenant", role: "tester", objective: "Run the tests." });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.evidence.report.tests, [{ command: "npm test", exit_code: 0 }]);
});

test("tester evidence fails when the test command fails", async () => {
  const { execute } = harness({ role: "tester", terminalResults: [{ ok: false, stdout: "", stderr: "failed" }] });
  const out = await execute({ jobId: "job-5", tenant: "test-tenant", role: "tester", objective: "Run the tests." });
  assert.equal(out.status, 422);
});

test("governance rejects without explicit approval and successful checks", async () => {
  const { execute } = harness({ role: "governance", answer: "The code appears fine." });
  const out = await execute({ jobId: "job-6", tenant: "test-tenant", role: "governance", objective: "Review the changes." });
  assert.equal(out.status, 422);
  assert.equal(out.body.evidence.report.decision, "reject");
});

test("governance approves only with explicit decision, tests and artifacts", async () => {
  const { execute } = harness({ role: "governance", answer: "Independent review complete.\nDECISION: APPROVE" });
  const out = await execute({ jobId: "job-7", tenant: "test-tenant", role: "governance", objective: "Review the changes." });
  assert.equal(out.status, 200);
  assert.equal(out.body.evidence.report.decision, "approve");
  assert.ok(out.body.evidence.report.checks.every(check => check.passed));
  assert.deepEqual(out.body.evidence.report.artifact_inventory, [
    { path: "src/fix.js", sha256: "sha256:" + "a".repeat(64) },
  ]);
  assert.deepEqual(out.body.evidence.report.test_commands, [
    { command: "npm test", exit_code: 0 },
  ]);
});

test("governance rejects when its independent inventory or test evidence is missing", async () => {
  const noArtifacts = harness({ role: "governance", answer: "DECISION: APPROVE", inventory: "" });
  const noArtifactsResult = await noArtifacts.execute({
    jobId: "job-governance-no-artifacts", tenant: "test-tenant", role: "governance", objective: "Review the changes.",
  });
  assert.equal(noArtifactsResult.status, 422);
  assert.equal(noArtifactsResult.body.evidence.report.decision, "reject");
  assert.deepEqual(noArtifactsResult.body.evidence.report.artifact_inventory, []);

  const failedTest = harness({
    role: "governance",
    answer: "DECISION: APPROVE",
    terminalResults: [
      { ok: false, stdout: "", stderr: "test failed" },
      { ok: true, stdout: "a".repeat(64) + "  ./src/fix.js\\n", stderr: "" },
    ],
  });
  const failedTestResult = await failedTest.execute({
    jobId: "job-governance-failed-test", tenant: "test-tenant", role: "governance", objective: "Review the changes.",
  });
  assert.equal(failedTestResult.status, 422);
  assert.equal(failedTestResult.body.evidence.report.decision, "reject");
  assert.deepEqual(failedTestResult.body.evidence.report.test_commands, [
    { command: "npm test", exit_code: 1 },
  ]);
});

test("propagates cancellation into the live agent runtime and fails closed", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const execute = createSwarmExecutor({
    tools: [], executorId: "spiffe://test/executor", privateKeyPem: privatePem,
    runAgent: async (_agent, _prompt, _tools, options) => {
      receivedSignal = options.signal;
      throw new Error("agent execution aborted");
    }
  });
  controller.abort();
  await assert.rejects(() => execute({ jobId: "job-cancel", tenant: "test-tenant", role: "debugger", objective: "Inspect the task.", signal: controller.signal }), /execution aborted before start/);
  assert.equal(receivedSignal, undefined);
  const active = new AbortController();
  const executeActive = createSwarmExecutor({
    tools: [], executorId: "spiffe://test/executor", privateKeyPem: privatePem,
    runAgent: async (_agent, _prompt, _tools, options) => {
      receivedSignal = options.signal;
      throw new Error("agent execution aborted");
    }
  });
  const out = await executeActive({ jobId: "job-cancel-2", tenant: "test-tenant", role: "debugger", objective: "Inspect the task.", signal: active.signal });
  assert.equal(receivedSignal, active.signal);
  assert.equal(out.status, 422);
  assert.equal(out.body.evidence.status, "failed");
});

test("rejects malformed job IDs, roles, objectives and non-Ed25519 keys", async () => {
  const { execute } = harness({ role: "debugger" });
  await assert.rejects(() => execute({ jobId: "../escape", role: "debugger", objective: "ok" }), /invalid jobId/);
  await assert.rejects(() => execute({ jobId: "job", tenant: "test-tenant", role: "admin", objective: "ok" }), /invalid specialist role/);
  await assert.rejects(() => execute({ jobId: "job", tenant: "test-tenant", role: "debugger", objective: "" }), /objective/);
  assert.throws(() => createSwarmExecutor({ tools: [], runAgent: async () => "", executorId: "x", privateKeyPem: publicPem }), /private key/);
});
