import test from "node:test";
import assert from "node:assert/strict";
import { createTerminalTool } from "../src/tools/terminal.js";

test("terminal executes inside a sanitized per-agent workspace", async () => {
  const calls = [];
  const tool = createTerminalTool({
    uuid: () => "run-fixed-id",
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      callback(null, "actual stdout", "");
    }
  });
  const result = await tool.run({ command: "pwd" }, { agent: "../../unsafe name" });
  assert.equal(result.ok, true);
  assert.equal(result.cwd, "/workspace/agents/unsafename");
  assert.equal(result.stdout, "actual stdout");
  assert.equal(calls.length, 1);
  assert.match(calls[0][4], /setsid sh -lc/);
  assert.match(calls[0][4], /grok-swarm-run-fixed-id\.pid/);
});

test("terminal cancellation kills the remote process group and leaves a cancellation marker", async () => {
  const controller = new AbortController();
  const calls = [];
  const tool = createTerminalTool({
    uuid: () => "cancel-fixed-id",
    execFileImpl: (_file, args, options, callback) => {
      calls.push({ args, options });
      if (calls.length === 1) {
        options.signal.addEventListener("abort", () => callback(new Error("aborted"), "", ""), { once: true });
      } else {
        callback(null, "", "");
      }
      return {};
    }
  });
  const pending = tool.run({ command: "sleep 60" }, { agent: "job-a", signal: controller.signal });
  controller.abort(new Error("lease lost"));
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
  assert.match(calls[1].args[4], /grok-swarm-cancel-fixed-id\.cancel/);
  assert.match(calls[1].args[4], /kill -TERM/);
  assert.match(calls[1].args[4], /kill -KILL/);
});

test("terminal timeout also requests remote process-group cleanup", async () => {
  const calls = [];
  const timeout = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  const tool = createTerminalTool({
    uuid: () => "timeout-fixed-id",
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      callback(calls.length === 1 ? timeout : null, "", "");
    }
  });
  const result = await tool.run({ command: "sleep 60" }, { agent: "job-b" });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 2);
  assert.match(calls[1][4], /timeout-fixed-id\.cancel/);
});

test("terminal rejects empty and oversized commands without starting Docker", async () => {
  let calls = 0;
  const tool = createTerminalTool({ execFileImpl: () => { calls++; } });
  assert.equal((await tool.run({ command: "" }, {})).ok, false);
  assert.equal((await tool.run({ command: "x".repeat(20001) }, {})).ok, false);
  assert.equal(calls, 0);
});
