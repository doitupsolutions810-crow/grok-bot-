import test from "node:test";
import assert from "node:assert/strict";
import { toolSucceeded } from "./runtime.js";

test("terminal requires explicit success and zero exit code", () => {
  assert.equal(toolSucceeded("terminal", { ok: true, exitCode: 0 }), true);
  for (const result of [undefined, null, {}, { ok: true }, { ok: true, exitCode: 1 }, { ok: false, exitCode: 0 }, { ok: true, exitCode: 0, error: "timeout" }]) {
    assert.equal(toolSucceeded("terminal", result), false);
  }
});

test("HTTP fetch only passes for a 2xx response with textual content", () => {
  assert.equal(toolSucceeded("web.fetch", { status: 200, content: "ok" }), true);
  assert.equal(toolSucceeded("web.fetch", { status: 200, content: "ok", error: "contradictory" }), false);
  assert.equal(toolSucceeded("web.fetch", { status: 204, content: "" }), true);
  for (const result of [{ status: 302, content: "redirect" }, { status: 404, content: "missing" }, { status: 503, content: "down" }, { status: 200 }, { status: "200", content: "bad" }]) {
    assert.equal(toolSucceeded("web.fetch", result), false);
  }
});

test("browser requires a navigated URL and extracted content", () => {
  assert.equal(toolSucceeded("browser", { url: "https://example.test", content: "page" }), true);
  assert.equal(toolSucceeded("browser", { url: "https://example.test", content: "page", error: "navigation failed" }), false);
  assert.equal(toolSucceeded("browser", { title: "page", content: "page" }), false);
});

test("MCP-style tool errors and unknown return values fail closed", () => {
  assert.equal(toolSucceeded("filesystem.read", { content: [{ type: "text", text: "ok" }] }), true);
  assert.equal(toolSucceeded("filesystem.read", { ok: true }), true);
  assert.equal(toolSucceeded("filesystem.read", {}), false);
  assert.equal(toolSucceeded("filesystem.read", { isError: true, content: [{ type: "text", text: "denied" }] }), false);
  assert.equal(toolSucceeded("filesystem.read", { error: "failed" }), false);
  assert.equal(toolSucceeded("filesystem.read", undefined), false);
  assert.equal(toolSucceeded("filesystem.read", "ok"), false);
});
