import { createHash, createPrivateKey, randomUUID, sign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const ROLES = new Set(["debugger", "coder", "tester", "governance"]);
const ALLOWED_TOOLS = new Set(["terminal", "browser", "web.fetch", "rag.search", "task.board"]);
const MAX_OBJECTIVE = 2000;
const MAX_TOOL_RESULTS = 64;
const MAX_ARTIFACTS = 50;
const text = (value, max = 2000) => String(value ?? "").trim().slice(0, max);

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("plain JSON objects required");
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    if (["__proto__", "prototype", "constructor"].includes(key) || value[key] === undefined) throw new TypeError("unsafe JSON object");
  }
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

const sha = value => "sha256:" + createHash("sha256").update(String(value), "utf8").digest("hex");

export function tokenMatches(expected, supplied) {
  if (typeof expected !== "string" || expected.length < 32 || typeof supplied !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function safeWorkspaceId(jobId) {
  return "swarm-" + String(jobId).toLowerCase().replace(/[^a-z0-9_-]/g, "-").slice(0, 40);
}

function rolePrompt(role, objective, defaultRepository, defaultBranch) {
  const bootstrap = defaultRepository
    ? `If this workspace does not contain the target source, clone ${defaultRepository}${defaultBranch ? ` at branch ${defaultBranch}` : ""} into the current directory before working. Never overwrite an existing checkout.`
    : "Inspect the current workspace first. If the source is absent, report the blocker instead of inventing a repository.";
  const shared = `You are the ${role.toUpperCase()} specialist in a real software engineering swarm. Task: ${objective}\n${bootstrap}\nUse the terminal tool to inspect and act on actual files. Do not claim work or tests you did not perform. Keep all work inside your current per-job workspace. Return a concise factual report with commands actually run and files actually changed.`;
  const prompts = {
    debugger: `${shared}\nReproduce the issue where possible, inspect logs and source, identify a root cause, and state a concrete reproduction procedure. Do not patch unless the task explicitly asks you to.`,
    coder: `${shared}\nImplement the requested change in the workspace. Make the smallest coherent patch, inspect the diff, run relevant syntax checks, and list changed artifacts. Do not report success if no file was changed.`,
    tester: `${shared}\nIndependently run the relevant test suite and edge cases. Do not change implementation files. Report exact test commands and exit codes. A test pass requires an actually executed command with exit code zero.`,
    governance: `${shared}\nIndependently inspect the workspace, changed files, diffs, hashes and test evidence. Re-run or inspect tests where possible. Finish with exactly one final line: DECISION: APPROVE or DECISION: REJECT. Approve only if the implementation and evidence are independently verifiable; otherwise reject and explain gaps.`
  };
  return prompts[role];
}

function parseArtifacts(stdout) {
  const rows = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) continue;
    const rel = match[2].replace(/^\.\//, "");
    if (!rel || rel.startsWith("/") || rel.split("/").some(p => p === ".." || p === ".git" || p === "node_modules" || p === "secrets")
        || /(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(rel)
        || /(?:id_rsa|credentials)/i.test(rel) || /[\0\r\n\t]/.test(rel)) continue;
    rows.push({ path: rel, sha256: match[1] });
    if (rows.length >= MAX_ARTIFACTS) break;
  }
  return rows;
}

export function createSwarmExecutor({ tools, runAgent, executorId, privateKeyPem, defaultRepository = "", defaultBranch = "", now = () => Date.now() }) {
  if (!Array.isArray(tools) || typeof runAgent !== "function") throw new TypeError("tools and runAgent are required");
  if (typeof executorId !== "string" || !executorId.trim()) throw new TypeError("executorId is required");
  if (typeof privateKeyPem !== "string" || !privateKeyPem.includes("BEGIN PRIVATE KEY")) throw new TypeError("Ed25519 private key is required");
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new TypeError("executor signing key must be Ed25519");

  return async function execute({ jobId, role, objective }) {
    if (typeof jobId !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(jobId)) throw new TypeError("invalid jobId");
    if (!ROLES.has(role)) throw new TypeError("invalid specialist role");
    if (typeof objective !== "string" || !objective.trim() || objective.length > MAX_OBJECTIVE) throw new TypeError("objective must contain 1..2000 characters");

    const startedAt = new Date(now()).toISOString();
    const runId = randomUUID();
    const workspaceAgent = safeWorkspaceId(jobId);
    const captured = [];
    const allowed = tools.filter(tool => ALLOWED_TOOLS.has(tool.name));
    const wrappedTools = allowed.map(tool => ({
      ...tool,
      async run(args = {}, ctx = {}) {
        const result = await tool.run(args, { ...ctx, agent: workspaceAgent });
        if (tool.name === "terminal") {
          const stdout = String(result?.stdout ?? "");
          const stderr = String(result?.stderr ?? result?.error ?? "");
          captured.push({
            tool: "terminal", ok: result?.ok === true,
            exitCode: Number.isInteger(result?.exitCode) ? result.exitCode : result?.ok === true ? 0 : 1,
            stdout_sha256: sha(stdout), stderr_sha256: sha(stderr),
            command: text(args.command, 300)
          });
        }
        return result;
      }
    }));

    let answer = "";
    let runtimeError = "";
    try {
      const agent = {
        id: `swarm-${role}`, name: `Swarm ${role}`,
        systemPrompt: rolePrompt(role, objective, defaultRepository, defaultBranch),
        tools: wrappedTools.map(tool => tool.name), mode: "chat", review: false
      };
      const result = await runAgent(agent, objective, wrappedTools, {
        runId, agentName: workspaceAgent, maxSteps: 16, spawnDepth: 0
      });
      answer = typeof result === "string" ? result : JSON.stringify(result);
      if (result && typeof result === "object" && result.pendingApproval) runtimeError = "execution paused for human approval; unattended swarm cannot claim success";
    } catch (error) {
      runtimeError = text(error?.message || error, 1000);
      answer = runtimeError;
    }

    let artifacts = [];
    const terminal = allowed.find(tool => tool.name === "terminal");
    if (terminal && role !== "debugger") {
      try {
        const inventory = await terminal.run({
          command: "git rev-parse --is-inside-work-tree >/dev/null && { git diff --name-only -z HEAD; git ls-files --others --exclude-standard -z; } | xargs -0 -r sha256sum"
        }, { agent: workspaceAgent });
        const stdout = String(inventory?.stdout ?? "");
        const stderr = String(inventory?.stderr ?? inventory?.error ?? "");
        captured.push({ tool: "terminal", ok: inventory?.ok === true, exitCode: inventory?.ok === true ? 0 : 1, stdout_sha256: sha(stdout), stderr_sha256: sha(stderr), command: "git diff and untracked artifact inventory" });
        artifacts = parseArtifacts(stdout);
      } catch (error) {
        runtimeError ||= `artifact inventory failed: ${text(error?.message || error, 500)}`;
      }
    }

    const toolResults = captured.slice(0, MAX_TOOL_RESULTS).map(({ tool, ok, exitCode, stdout_sha256, stderr_sha256 }) => ({ tool, ok, exitCode, stdout_sha256, stderr_sha256 }));
    const successfulTerminal = toolResults.some(item => item.tool === "terminal" && item.ok && item.exitCode === 0);
    const testCommands = captured.filter(item => item.tool === "terminal" && /\b(test|pytest|vitest|jest|mocha|cargo test|go test|phpunit)\b/i.test(item.command));
    const tests = testCommands.map(item => ({ command: item.command, exit_code: item.exitCode }));
    const answerText = text(answer, 6000);

    let report;
    if (role === "debugger") {
      const reproduction = captured.find(item => item.tool === "terminal" && item.ok)?.command || "No successful reproduction command was recorded.";
      report = { diagnosis: answerText || runtimeError || "No diagnosis produced.", reproduction };
    } else if (role === "coder") {
      report = { artifacts };
    } else if (role === "tester") {
      report = { tests };
    } else {
      const approved = /(?:^|\n)\s*DECISION:\s*APPROVE\s*$/i.test(answerText);
      report = {
        decision: approved && successfulTerminal && artifacts.length > 0 && tests.some(test => test.exit_code === 0) ? "approve" : "reject",
        checks: [
          { name: "successful terminal execution", passed: successfulTerminal },
          { name: "artifact inventory", passed: artifacts.length > 0 },
          { name: "successful test command", passed: tests.some(test => test.exit_code === 0) },
          { name: "explicit governance approval", passed: approved }
        ]
      };
    }

    const roleReady = role === "debugger"
      ? answerText.length >= 20 && successfulTerminal
      : role === "coder"
        ? artifacts.length > 0 && successfulTerminal
        : role === "tester"
          ? tests.length > 0 && tests.every(test => test.exit_code === 0) && successfulTerminal
          : report.decision === "approve" && report.checks.every(check => check.passed);
    const status = roleReady && !runtimeError ? "succeeded" : "failed";
    const completedAt = new Date(now()).toISOString();
    const unsigned = {
      schema: "grokbot.swarm-evidence/v1", job_id: jobId, role, executor: executorId,
      run_id: runId, status, started_at: startedAt, completed_at: completedAt,
      answer_digest: sha(answerText), tool_results: toolResults, report
    };
    const evidence_signature = sign(null, Buffer.from(canonicalJson(unsigned)), privateKey).toString("base64");
    return { status: status === "succeeded" ? 200 : 422, body: { evidence: unsigned, evidence_signature } };
  };
}

export function readPrivateKey(filePath) {
  if (typeof filePath !== "string" || !filePath.trim()) return "";
  return readFileSync(filePath, "utf8");
}
