import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSubtasks } from "../src/agents/trinity.js";

test("configured squad size fills a missing parallel lane", () => {
  const tasks = normalizeSubtasks('["Inspect the Node runtime"]', {
    fallback: 2, min: 2, max: 2, source: "Observe node and bridge health"
  });
  assert.equal(tasks.length, 2);
  assert.notEqual(tasks[0], tasks[1]);
});

test("configured squad size caps an over-eager planner", () => {
  const tasks = normalizeSubtasks('["A","B","C","D"]', {
    fallback: 2, min: 2, max: 2, source: "Observe the runtime"
  });
  assert.deepEqual(tasks, ["A", "B"]);
});

test("invalid planner output still produces the configured number of lanes", () => {
  const tasks = normalizeSubtasks("not valid JSON", {
    fallback: 2, min: 2, max: 2, source: "Observe the integrated stack"
  });
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every(task => task.includes("integrated stack")));
});
