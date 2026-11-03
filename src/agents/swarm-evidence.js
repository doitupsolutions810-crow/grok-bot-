import { createHash, createPrivateKey, sign } from "node:crypto";

function assertUnicode(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("unpaired Unicode surrogate");
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError("unpaired Unicode surrogate");
  }
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function canonicalJson(value) {
  if (typeof value === "string") { assertUnicode(value); return JSON.stringify(value); }
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("non-finite number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",") }]`;
  if (!isPlainObject(value)) throw new TypeError("plain JSON values only");
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    assertUnicode(key);
    if (["__proto__", "constructor", "prototype"].includes(key) || value[key] === undefined) throw new TypeError("unsafe canonical JSON key/value");
  }
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
const digest = (value) => `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
function parseReport(answer) {
  if (typeof answer !== "string") return null;
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  try {
    const report = JSON.parse(fenced?.[1] || answer.trim());
    return isPlainObject(report) ? report : null;
  } catch { return null; }
}
function validIso(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

export function buildSwarmEvidence({ jobId, role, executor, runId, answer, events, startedAt, completedAt, privateKeyPem }) {
  const report = parseReport(answer);
  const toolResults = (Array.isArray(events) ? events : [])
    .filter((event) => event?.kind === "tool.result")
    .map((event) => ({
      tool: String(event.tool || ""),
      ok: event.ok === true,
      exitCode: Number.isInteger(event.exitCode) ? event.exitCode : null,
      stdout_sha256: event.stdout_sha256 || null,
      stderr_sha256: event.stderr_sha256 || null,
    }));
  const allToolsSucceeded = toolResults.length > 0 && toolResults.every((result) => result.ok);
  const terminalSucceeded = toolResults.some((result) => result.tool === "terminal" && result.ok && result.exitCode === 0);
  let reportSucceeded = false;
  if (role === "debugger") reportSucceeded = typeof report?.diagnosis === "string" && !!report.diagnosis.trim() && typeof report?.reproduction === "string" && !!report.reproduction.trim();
  else if (role === "coder") reportSucceeded = Array.isArray(report?.artifacts) && report.artifacts.length > 0 && report.artifacts.every((item) => typeof item.path === "string" && /^sha256:[0-9a-f]{64}$/.test(item.sha256 || ""));
  else if (role === "tester") reportSucceeded = Array.isArray(report?.tests) && report.tests.length > 0 && report.tests.every((item) => typeof item.command === "string" && item.exit_code === 0);
  else if (role === "governance") reportSucceeded = report?.decision === "approve" && Array.isArray(report?.checks) && report.checks.length > 0 && report.checks.every((item) => item.passed === true);
  const roleToolSucceeded = ["coder", "tester"].includes(role)
    ? terminalSucceeded
    : toolResults.some((result) => result.ok && ["terminal", "web.fetch", "browser"].includes(result.tool));
  const status = allToolsSucceeded && roleToolSucceeded && reportSucceeded && typeof answer === "string" && answer.trim()
    ? "succeeded" : "failed";
  if (!validIso(startedAt) || !validIso(completedAt) || Date.parse(completedAt) < Date.parse(startedAt)) throw new Error("invalid evidence timestamps");
  const evidence = {
    schema: "grokbot.swarm-evidence/v1",
    job_id: jobId,
    role,
    executor,
    run_id: runId,
    status,
    started_at: startedAt,
    completed_at: completedAt,
    answer_digest: digest(answer || ""),
    tool_results: toolResults,
    report: report || {},
  };
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("executor evidence signing key must be Ed25519");
  const signature = sign(null, Buffer.from(canonicalJson(evidence)), key).toString("base64");
  return { evidence, signature };
}
