import test from "node:test";
import assert from "node:assert/strict";

import { createBasicAuth, readBasicAuthConfig } from "../src/middleware/basic-auth.js";

function response() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; },
  };
}

function invoke(middleware, { path = "/api/status", authorization } = {}) {
  const req = { path, url: path, headers: authorization ? { authorization } : {} };
  const res = response();
  let continued = 0;
  middleware(req, res, () => { continued += 1; });
  return { req, res, continued };
}

const basic = (username, password) =>
  "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");

test("auth is disabled only when explicitly not required", () => {
  assert.equal(readBasicAuthConfig({ GROK_AUTH_REQUIRED: "false" }).enabled, false);
  assert.equal(readBasicAuthConfig({}).enabled, false);
});

test("required auth fails closed with missing or invalid credentials", () => {
  assert.throws(
    () => readBasicAuthConfig({ GROK_AUTH_REQUIRED: "true", GROK_AUTH_USERNAME: "crow" }),
    /GROK_AUTH_REQUIRED/
  );
  assert.throws(
    () => readBasicAuthConfig({
      GROK_AUTH_REQUIRED: "true", GROK_AUTH_USERNAME: "bad:user", GROK_AUTH_PASSWORD: "secret"
    }),
    /GROK_AUTH_REQUIRED/
  );
  const config = readBasicAuthConfig({
    GROK_AUTH_REQUIRED: "yes", GROK_AUTH_USERNAME: "operator", GROK_AUTH_PASSWORD: "secret"
  });
  assert.equal(config.enabled, true);
  assert.equal(config.username, "operator");
});

test("minimal health route is public but other endpoints are protected", () => {
  const middleware = createBasicAuth({
    enabled: true, username: "operator", password: "secret"
  });
  const health = invoke(middleware, { path: "/api/health" });
  assert.equal(health.continued, 1);
  const status = invoke(middleware, { path: "/api/status" });
  assert.equal(status.continued, 0);
  assert.equal(status.res.statusCode, 401);
  assert.equal(status.res.headers["www-authenticate"], 'Basic realm="Grok Bot", charset="UTF-8"');
  assert.equal(status.res.headers["cache-control"], "no-store");
  assert.equal(status.res.payload.error, "authentication required");
});

test("valid Basic Auth permits the UI, API, and event-stream routes", () => {
  const middleware = createBasicAuth({
    enabled: true, username: "operator", password: "secret"
  });
  for (const path of ["/", "/static/index.html", "/api/chat", "/api/chat/stream"]) {
    const result = invoke(middleware, { path, authorization: basic("operator", "secret") });
    assert.equal(result.continued, 1, path);
    assert.equal(result.res.statusCode, 200, path);
    assert.equal(result.res.headers["x-content-type-options"], "nosniff");
    assert.equal(result.res.headers["x-frame-options"], "DENY");
    assert.equal(result.res.headers["referrer-policy"], "no-referrer");
  }
});

test("wrong credentials and malformed authorization headers are rejected", () => {
  const middleware = createBasicAuth({
    enabled: true, username: "operator", password: "secret"
  });
  for (const authorization of [
    undefined,
    "Bearer token",
    "Basic !!!",
    "Basic " + Buffer.from("operator").toString("base64"),
    basic("other", "secret"),
    basic("operator", "wrong"),
  ]) {
    const result = invoke(middleware, { authorization });
    assert.equal(result.continued, 0);
    assert.equal(result.res.statusCode, 401);
  }
});

test("Basic Auth uses first colon as the username/password separator", () => {
  const middleware = createBasicAuth({
    enabled: true, username: "operator", password: "part-one:part-two"
  });
  const result = invoke(middleware, {
    authorization: basic("operator", "part-one:part-two")
  });
  assert.equal(result.continued, 1);
});

test("disabled auth does not block loopback development", () => {
  const middleware = createBasicAuth({
    enabled: false, username: "crow", password: ""
  });
  const result = invoke(middleware, { path: "/api/status" });
  assert.equal(result.continued, 1);
});
