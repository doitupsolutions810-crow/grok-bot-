import test from "node:test";
import assert from "node:assert/strict";
import { sameModelName } from "../src/boot/preinstall.js";

test("an untagged Ollama model matches its implicit latest tag", () => {
  assert.equal(sameModelName("nomic-embed-text:latest", "nomic-embed-text"), true);
  assert.equal(sameModelName("nomic-embed-text", "nomic-embed-text:latest"), true);
});

test("explicit non-latest tags remain distinct", () => {
  assert.equal(sameModelName("qwen2.5:3b", "qwen2.5"), false);
  assert.equal(sameModelName("qwen2.5:3b", "qwen2.5:3b"), true);
});

test("malformed names never match", () => {
  assert.equal(sameModelName(null, "nomic-embed-text"), false);
  assert.equal(sameModelName("nomic-embed-text:latest", undefined), false);
});
