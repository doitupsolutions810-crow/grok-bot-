import test from "node:test";
import assert from "node:assert/strict";
import { resolveModelChain, resolveRequiredModels } from "../src/llm/model-chain.js";

test("default chain uses the selected primary model and stable fallbacks", () => {
  assert.deepEqual(resolveModelChain({ LLM_MODEL: "qwen2.5:3b" }), [
    "qwen2.5:3b", "llama3.2:3b", "llama3.2:1b"
  ]);
});

test("configured chain trims whitespace and removes duplicate models", () => {
  assert.deepEqual(resolveModelChain({
    LLM_MODEL: "qwen2.5:3b",
    MODEL_CHAIN: " qwen2.5:3b, llama3.2:3b, qwen2.5:3b, "
  }), ["qwen2.5:3b", "llama3.2:3b"]);
});

test("boot provisions every chain model and the vision model only when enabled", () => {
  assert.deepEqual(resolveRequiredModels({
    LLM_MODEL: "qwen2.5:3b",
    MODELS_REQUIRED: "qwen2.5:3b,nomic-embed-text",
    MODEL_CHAIN: "qwen2.5:3b,llama3.2:3b",
    ENABLE_VISION: "true"
  }), ["qwen2.5:3b", "nomic-embed-text", "llama3.2:3b", "llava:7b"]);
});

test("a false vision flag never pulls the optional vision model", () => {
  assert.deepEqual(resolveRequiredModels({
    LLM_MODEL: "qwen2.5:3b",
    MODELS_REQUIRED: "qwen2.5:3b,nomic-embed-text",
    MODEL_CHAIN: "qwen2.5:3b",
    ENABLE_VISION: "false"
  }), ["qwen2.5:3b", "nomic-embed-text"]);
});

test("explicit chain models are always added to a short model list", () => {
  assert.deepEqual(resolveRequiredModels({
    LLM_MODEL: "qwen2.5:3b",
    MODELS_REQUIRED: "qwen2.5:3b,nomic-embed-text",
    MODEL_CHAIN: "qwen2.5:3b,llama3.2:3b"
  }), ["qwen2.5:3b", "nomic-embed-text", "llama3.2:3b"]);
});
