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
  assert.doesNotMatch(safeToolTraceText("https://user:password-secret@example.test/path"), /user:password-secret/);
});

test("JSON credentials and prefixed cloud-secret names are redacted", () => {
  const sample = '{"token":"json-token-123","api_key":"json-key-123","password":"json-password-123","AWS_SECRET_ACCESS_KEY":"aws-secret-123","AWS_ACCESS_KEY_ID":"aws-access-key-id-123","GITHUB_TOKEN":"github-token-123"}';
  const redacted = safeToolTraceText(sample);
  assert.doesNotMatch(redacted, /json-token-123|json-key-123|json-password-123|aws-secret-123|aws-access-key-id-123|github-token-123/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("secret values in URL query parameters are redacted without swallowing later parameters", () => {
  const redacted = safeToolTraceText("https://example.test/?token=query-token-123&mode=read");
  assert.doesNotMatch(redacted, /query-token-123/);
  assert.match(redacted, /mode=read/);
});

test("tool output receipts are bounded", () => {
  const receipt = summarizeToolResult({ ok: true, stdout: "x".repeat(5000) });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.output_excerpt.length, 1200);
  assert.equal(receipt.output_chars, 5000);
});
