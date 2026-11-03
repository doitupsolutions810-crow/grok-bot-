import test from "node:test";
import assert from "node:assert/strict";
import { parseEventLine, recordEvent } from "../scripts/evolve-core.js";

test("parseEventLine rejects corrupt JSON and non-object roots", () => {
  for (const line of ["", "{bad", "null", "[]", "42", '"string"']) {
    assert.equal(parseEventLine(line), null);
  }
  assert.deepEqual(parseEventLine('{"kind":"tool.call","tool":"runtime_preflight"}'), {
    kind: "tool.call", tool: "runtime_preflight"
  });
});

test("recordEvent preserves tool counts and error evidence", () => {
  const stats = { events: 0, byKind: {}, toolCalls: {}, errors: 0 };
  assert.equal(recordEvent(stats, null), false);
  assert.equal(recordEvent(stats, []), false);
  recordEvent(stats, { kind: "tool.call", tool: "runtime_preflight" });
  recordEvent(stats, { kind: "tool.error", name: "fetch", error: "mock" });
  assert.equal(stats.events, 2);
  assert.equal(stats.byKind["tool.call"], 1);
  assert.equal(stats.toolCalls.runtime_preflight, 1);
  assert.equal(stats.toolCalls.fetch, 1);
  assert.equal(stats.errors, 1);
});

test("recordEvent normalizes fallback event kinds", () => {
  const stats = { events: 0, byKind: {}, toolCalls: {}, errors: 0 };
  recordEvent(stats, { type: "custom.event" });
  recordEvent(stats, {});
  assert.equal(stats.byKind["custom.event"], 1);
  assert.equal(stats.byKind.event, 1);
  assert.equal(stats.events, 2);
});
