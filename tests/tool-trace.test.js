import test from "node:test";
import assert from "node:assert/strict";
import { safeToolTraceText, summarizeToolResult } from "../src/agents/tool-trace.js";

test("an explicit failed terminal result remains failed in CodeX", () => {
  const receipt = summarizeToolResult({ ok: false, stdout: "partial output", stderr: "Permission denied" });
  assert.equal(receipt.ok, false);
  assert.match(receipt.output_excerpt, /partial output/);
  assert.match(receipt.output_excerpt, /Permission denied/);
});

test("tool errors expressed as strings are marked failed", () => {
  const receipt = summarizeToolResult("ERROR: redirects are blocked");
  assert.equal(receipt.ok, false);
  assert.match(receipt.error_excerpt, /redirects are blocked/);
});

test("trace excerpts redact bearer credentials and common secret assignments", () => {
  const text = 'Bearer abc.def.ghi token=secret-value API_KEY="other-secret"';
  const redacted = safeToolTraceText(text);
  assert.doesNotMatch(redacted, /abc\.def\.ghi|secret-value|other-secret/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
});

test("tool output receipts are bounded", () => {
  const receipt = summarizeToolResult({ ok: true, stdout: "x".repeat(5000) });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.output_excerpt.length, 1200);
  assert.equal(receipt.output_chars, 5000);
});
