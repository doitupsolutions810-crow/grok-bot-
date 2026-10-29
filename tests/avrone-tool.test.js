import test from "node:test";
import assert from "node:assert/strict";
import { createAvroneTool } from "../src/tools/avrone.js";

const okResponse = body => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" }
});

test("forward bridge posts to the configured origin and requires a run receipt", async () => {
  let observed;
  const tool = createAvroneTool({
    getBaseUrl: () => "http://avrone:8710",
    fetchImpl: async (url, init) => {
      observed = { url: String(url), init };
      return okResponse({ run_id: "run-123", answer: "two workers reported" });
    }
  });
  const result = await tool.run({ prompt: "Inspect the bridge.", mode: "deep" });
  assert.deepEqual(result, {
    ok: true, mode: "deep", runId: "run-123", answer: "two workers reported", truncated: false
  });
  assert.equal(observed.url, "http://avrone:8710/api/chat");
  assert.equal(observed.init.redirect, "manual");
  assert.ok(observed.init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(observed.init.body), { message: "Inspect the bridge.", mode: "deep" });
});

test("forward bridge rejects URL paths, credentials, query strings, fragments and non-HTTP schemes", async () => {
  for (const value of [
    "http://avrone:8710/admin",
    "http://user:pass@avrone:8710",
    "http://avrone:8710?token=secret",
    "http://avrone:8710/#fragment",
    "file:///tmp"
  ]) {
    const tool = createAvroneTool({
      getBaseUrl: () => value,
      fetchImpl: async () => { throw new Error("network should not be called"); }
    });
    const result = await tool.run({ prompt: "Inspect." });
    assert.match(result.error, /HTTP\(S\) origin/);
  }
});

test("forward bridge refuses redirects rather than following them", async () => {
  const tool = createAvroneTool({
    getBaseUrl: () => "http://avrone:8710",
    fetchImpl: async () => new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1:1/" }
    })
  });
  const result = await tool.run({ prompt: "Inspect." });
  assert.match(result.error, /refused HTTP redirect/);
});

test("forward bridge rejects success responses without a run id or textual answer", async () => {
  const withoutRunId = createAvroneTool({
    getBaseUrl: () => "http://avrone:8710",
    fetchImpl: async () => okResponse({ answer: "answer" })
  });
  const withoutAnswer = createAvroneTool({
    getBaseUrl: () => "http://avrone:8710",
    fetchImpl: async () => okResponse({ run_id: "run-1", answer: " " })
  });
  assert.match((await withoutRunId.run({ prompt: "Inspect." })).error, /omitted its run_id/);
  assert.match((await withoutAnswer.run({ prompt: "Inspect." })).error, /omitted a textual answer/);
});

test("forward bridge rejects prompts over 8000 characters before network I/O", async () => {
  let called = false;
  const tool = createAvroneTool({
    getBaseUrl: () => "http://avrone:8710",
    fetchImpl: async () => { called = true; return okResponse({}); }
  });
  const result = await tool.run({ prompt: "x".repeat(8001) });
  assert.match(result.error, /8000-character limit/);
  assert.equal(called, false);
});

test("forward bridge caps response size and reports timeouts without leaking errors", async () => {
  const tooLarge = createAvroneTool({
    getBaseUrl: () => "http://avrone:8710",
    fetchImpl: async () => okResponse({ run_id: "run-1", answer: "x".repeat(70000) })
  });
  assert.match((await tooLarge.run({ prompt: "Inspect." })).error, /64 KiB limit/);

  const timeout = createAvroneTool({
    getBaseUrl: () => "http://avrone:8710",
    fetchImpl: async () => {
      const error = new Error("internal host details");
      error.name = "TimeoutError";
      throw error;
    }
  });
  assert.match((await timeout.run({ prompt: "Inspect." })).error, /timed out/);
  assert.doesNotMatch((await timeout.run({ prompt: "Inspect." })).error, /internal host details/);
});

test("forward bridge handles non-2xx statuses as failure receipts", async () => {
  const tool = createAvroneTool({
    getBaseUrl: () => "http://avrone:8710",
    fetchImpl: async () => new Response("untrusted internal response", { status: 503 })
  });
  assert.match((await tool.run({ prompt: "Inspect." })).error, /HTTP 503/);
});
