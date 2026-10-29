import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const compose = readFileSync(new URL("../docker-compose.yml", import.meta.url), "utf8");
const fullEnv = readFileSync(new URL("../.env.full", import.meta.url), "utf8");

test("compose forwards configured model-chain and vision settings to the runtime", () => {
  assert.match(compose, /^\s+MODEL_CHAIN: \$\{MODEL_CHAIN:-\}\s*$/m);
  assert.match(compose, /^\s+ENABLE_VISION: \$\{ENABLE_VISION:-false\}\s*$/m);
});

test("compose forwards optional X credentials and polling settings without inventing a token", () => {
  assert.match(compose, /^\s+X_API_BEARER: \$\{X_API_BEARER:-\}\s*$/m);
  assert.match(compose, /^\s+X_ACCOUNT: \$\{X_ACCOUNT:-grok_bot\}\s*$/m);
  assert.match(compose, /^\s+X_POLL_SECONDS: \$\{X_POLL_SECONDS:-60\}\s*$/m);
  assert.match(fullEnv, /^X_API_BEARER=\s*(?:#.*)?$/m);
  assert.doesNotMatch(fullEnv, /X_API_BEARER=TODO/i);
});

test("compose still forwards the integration and Whisper sidecar origins", () => {
  assert.match(compose, /^\s+AVRONE_URL: \$\{AVRONE_URL:-\}\s*.*$/m);
  assert.match(compose, /^\s+WHISPER_URL: \$\{WHISPER_URL:-\}\s*.*$/m);
  assert.match(compose, /^\s+PIPER_URL: \$\{PIPER_URL:-\}\s*.*$/m);
  assert.match(compose, /^\s+TTS_VOICE: \$\{TTS_VOICE:-en_US-lessac-medium\}\s*$/m);
  assert.match(compose, /command: \["--voice", "en_US-lessac-medium"\]/);
  assert.match(compose, /piper_data:.*downloaded Piper voice models/);
  assert.match(fullEnv, /^PIPER_URL=tcp:\/\/piper:10200\s/);
});
