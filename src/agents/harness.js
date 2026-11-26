// Self-development: agents read and improve their OWN harness, in chains.
//
//   harness.list / harness.read   browse the system's own source (src, skills, config, tests, scripts)
//   harness.propose               write new or changed files as a proposal; it is applied to an
//                                 isolated copy of the harness and the FULL test suite runs there
//   harness.proposals             see every proposal, its test output, and what to fix next
// Proposals can build on each other (basedOn), so an agent can research, propose, read the
// failing tests, propose again, and chain new software out of its own earlier work.
//
// Applying to the live system is the owner's call: POST /harness/proposals/:id/approve.
// HARNESS_AUTO_APPLY=true lets proposals that pass every test apply themselves.
// Never writable by agents: secrets, the data dir, CI, and the container/compose definitions,
// so an agent can't widen its own sandbox or switch off the tests that judge it.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import * as lattice from "./lattice.js";

const ROOT = () => path.resolve(process.env.HARNESS_ROOT || process.cwd());
const STORE = () => path.join(process.env.DATA_DIR || "/data", "proposals");
const READABLE = ["src", "skills", "config", "tests", "scripts", "browser-service", "public", "package.json", "README.md", "docs"];
const WRITABLE = ["src", "skills", "config", "tests", "scripts", "public", "docs"];
const DENY = /(^|\/)(\.env[^/]*|\.git|node_modules|data|\.github)(\/|$)|(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml)$|\.(pem|key|db|sqlite)$/i;
const MAX_FILES = 20, MAX_BYTES = 200_000;

export function safeRel(p, { write = false } = {}) {
  if (typeof p !== "string" || !p.trim() || p.includes("\0")) throw new Error("path required");
  const rel = path.posix.normalize(p.replace(/\\/g, "/").replace(/^\/+/, ""));
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path must stay inside the harness");
  if (DENY.test(rel)) throw new Error(`${rel} is off-limits to agents`);
  const top = rel.split("/")[0];
  // agents may ADD tests, never edit the existing ones that judge their own changes
  if (write && top === "tests" && fs.existsSync(path.join(ROOT(), rel))) throw new Error(`${rel} is an existing test: add a new test file instead`);
  if (!(write ? WRITABLE : READABLE).includes(top)) throw new Error(`${write ? "writable" : "readable"} areas: ${(write ? WRITABLE : READABLE).join(", ")}`);
  const abs = path.join(ROOT(), rel);
  if (!abs.startsWith(ROOT() + path.sep) && abs !== ROOT()) throw new Error("path must stay inside the harness");
  return rel;
}

function readProposal(id) {
  if (!/^p-[a-z0-9]{6,20}$/.test(String(id))) return null;
  try { return JSON.parse(fs.readFileSync(path.join(STORE(), id, "proposal.json"), "utf8")); } catch { return null; }
}
function saveProposal(p) {
  fs.mkdirSync(path.join(STORE(), p.id), { recursive: true });
  fs.writeFileSync(path.join(STORE(), p.id, "proposal.json"), JSON.stringify(p, null, 2));
}
export function listProposals({ limit = 50 } = {}) {
  let ids = [];
  try { ids = fs.readdirSync(STORE()).filter(d => /^p-/.test(d)); } catch {}
  return ids.map(readProposal).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.min(Number(limit) || 50, 500))
    .map(({ files, ...p }) => ({ ...p, files: files.map(f => f.path) }));
}
export const getProposal = readProposal;

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if ([".git", "node_modules", "data"].includes(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

const run = (cmd, args, opts) => new Promise(resolve => {
  execFile(cmd, args, { ...opts, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, killed: !!err?.killed, out: String(stdout || "") + String(stderr || "") }));
});

export function checkSyntax(source, inputType = "module") {
  return new Promise(resolve => {
    const c = spawn(process.execPath, [`--input-type=${inputType}`, "--check"], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    const t = setTimeout(() => c.kill("SIGKILL"), 20_000);
    c.stderr.on("data", d => { if (err.length < 8000) err += d; });
    c.on("close", code => { clearTimeout(t); resolve({ code: code ?? 1, out: err }); });
    c.on("error", e => { clearTimeout(t); resolve({ code: 1, out: e.message }); });
    c.stdin.on("error", () => {});
    c.stdin.end(source);
  });
}

// Apply the proposal to a throwaway copy of the harness and run the whole suite there.
export async function testProposal(p) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
  try {
    copyTree(ROOT(), work);
    try { fs.symlinkSync(path.join(ROOT(), "node_modules"), path.join(work, "node_modules"), "dir"); } catch {}
    for (const f of p.files) {
      fs.mkdirSync(path.dirname(path.join(work, f.path)), { recursive: true });
      fs.writeFileSync(path.join(work, f.path), f.content);
    }
    // Syntax gate. Not `node --check file.js`: with no "type" in package.json, Node 22's module
    // detection lets a broken .js pass --check. Parse from stdin with an explicit input type.
    let pkgType = "";
    try { pkgType = JSON.parse(fs.readFileSync(path.join(work, "package.json"), "utf8")).type || ""; } catch {}
    for (const f of p.files.filter(f => /\.(m?js|cjs)$/.test(f.path))) {
      const types = f.path.endsWith(".mjs") ? ["module"] : f.path.endsWith(".cjs") ? ["commonjs"]
        : pkgType === "module" ? ["module"] : pkgType === "commonjs" ? ["commonjs"] : ["module", "commonjs"];
      let last = null;
      for (const t of types) { last = await checkSyntax(f.content, t); if (last.code === 0) break; }
      if (last.code !== 0) return { ok: false, stage: "syntax", output: `${f.path}\n${last.out}`.slice(-4000) };
    }
    const [cmd, ...args] = (process.env.HARNESS_TEST_CMD || "npm test").split(/\s+/);
    const t = await run(cmd, args, { cwd: work, timeout: Number(process.env.HARNESS_TEST_TIMEOUT_MS) || 300_000,
      env: { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "harness-data-")) } });
    const summary = (t.out.match(/^# (tests|pass|fail) \d+$/gm) || []).join(", ");
    return { ok: t.code === 0, stage: t.killed ? "timeout" : "tests", summary, output: t.out.slice(-6000) };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export function applyProposal(p, by = "owner") {
  if (p.status !== "passed") throw new Error(`only a proposal that passed its tests can be applied (this one is ${p.status})`);
  for (const f of p.files) safeRel(f.path, { write: true });          // re-check at apply time
  const backup = path.join(STORE(), p.id, "backup");
  for (const f of p.files) {
    const abs = path.join(ROOT(), f.path);
    if (fs.existsSync(abs)) { fs.mkdirSync(path.dirname(path.join(backup, f.path)), { recursive: true }); fs.copyFileSync(abs, path.join(backup, f.path)); }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content);
  }
  Object.assign(p, { status: "applied", appliedAt: new Date().toISOString(), appliedBy: by });
  saveProposal(p);
  lattice.record("eureka", { agent: p.agent, text: `Harness upgrade applied: ${p.title}` });
  return p;
}

// One full-suite run at a time: four agents proposing at once on a CPU box would starve the
// model they think with. Extra proposals wait their turn; past HARNESS_MAX_QUEUE they're refused.
let lane = Promise.resolve(), waiting = 0;
function queued(fn) {
  const max = Number(process.env.HARNESS_MAX_QUEUE) || 5;
  if (waiting >= max) return Promise.reject(new Error(`the test lane is busy (${waiting} proposals waiting); try again later`));
  waiting++;
  const run = lane.then(fn, fn);
  lane = run.catch(() => {}).finally(() => { waiting--; });
  return run;
}
export const queueDepth = () => waiting;

export async function propose({ agent = "agent", title, rationale = "", files, basedOn } = {}) {
  if (typeof title !== "string" || !title.trim()) throw new Error("title required");
  if (!Array.isArray(files) || !files.length) throw new Error("files required: [{path, content}]");
  if (files.length > MAX_FILES) throw new Error(`at most ${MAX_FILES} files per proposal`);
  const clean = files.map(f => {
    if (!f || typeof f.content !== "string") throw new Error("each file needs path and content (string)");
    if (Buffer.byteLength(f.content) > MAX_BYTES) throw new Error(`${f.path}: larger than ${MAX_BYTES} bytes`);
    return { path: safeRel(f.path, { write: true }), content: f.content };
  });
  if (new Set(clean.map(f => f.path)).size !== clean.length) throw new Error("the same path appears twice");
  if (basedOn !== undefined && !readProposal(basedOn)) throw new Error(`unknown basedOn proposal ${basedOn}`);
  if (waiting >= (Number(process.env.HARNESS_MAX_QUEUE) || 5)) throw new Error(`the test lane is busy (${waiting} proposals waiting); try again later`);
  const p = {
    id: `p-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, agent: String(agent), title: title.trim().slice(0, 200),
    rationale: String(rationale).slice(0, 4000), basedOn: basedOn || null, files: clean, status: "testing", createdAt: new Date().toISOString()
  };
  saveProposal(p);
  lattice.record("say", { agent: p.agent, to: "*", text: `I proposed a harness change: ${p.title} (${clean.map(f => f.path).join(", ")})` });
  let result;
  try { result = await queued(() => testProposal(p)); }
  catch (e) { result = { ok: false, stage: "lane", output: e.message }; }       // never leave a proposal stuck in "testing"
  Object.assign(p, { status: result.ok ? "passed" : "failed", test: result, testedAt: new Date().toISOString() });
  saveProposal(p);
  lattice.record(result.ok ? "eureka" : "error", { agent: p.agent,
    text: result.ok ? `Harness proposal "${p.title}" passed the full suite (${result.summary || "ok"})` : `Harness proposal "${p.title}" failed at ${result.stage}` });
  if (result.ok && process.env.HARNESS_AUTO_APPLY === "true") applyProposal(p, "auto (tests passed)");
  return p;
}

export function harnessTools() {
  return [
    {
      name: "harness.list",
      description: "List files in your own harness (the system that runs you): src, skills, config, tests, scripts, docs.",
      parameters: { type: "object", properties: { dir: { type: "string" } } },
      async run({ dir = "src" } = {}) {
        try {
          const rel = safeRel(dir);
          const abs = path.join(ROOT(), rel);
          const out = [];
          const walk = (d, r) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (out.length >= 500 || e.name === "node_modules" || e.name.startsWith(".")) continue;
            const rr = `${r}/${e.name}`; if (DENY.test(rr)) continue;
            if (e.isDirectory()) walk(path.join(d, e.name), rr); else out.push(rr);
          } };
          if (fs.statSync(abs).isDirectory()) walk(abs, rel); else out.push(rel);
          return { files: out };
        } catch (e) { return { error: e.message }; }
      }
    },
    {
      name: "harness.read",
      description: "Read one file of your own harness source.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      async run({ path: p } = {}) {
        try { const rel = safeRel(p); const t = fs.readFileSync(path.join(ROOT(), rel), "utf8"); return { path: rel, bytes: t.length, content: t.slice(0, 60_000) }; }
        catch (e) { return { error: e.message }; }
      }
    },
    {
      name: "harness.propose",
      description: "Propose new or changed files for your own harness (new tools, skills, fixes, tests). It is tested against the full suite in an isolated copy; read the result and propose again (basedOn) to iterate.",
      parameters: { type: "object", properties: {
        title: { type: "string" }, rationale: { type: "string" }, basedOn: { type: "string" },
        files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
        required: ["title", "files"] },
      async run(args = {}, ctx) {
        try {
          const p = await propose({ ...args, agent: ctx?.agent || "agent" });
          return { id: p.id, status: p.status, stage: p.test?.stage, summary: p.test?.summary, output: p.status === "failed" ? p.test.output.slice(-2500) : undefined };
        } catch (e) { return { error: e.message }; }
      }
    },
    {
      name: "harness.proposals",
      description: "List harness proposals (yours and teammates'), or one in full with its test output (id).",
      parameters: { type: "object", properties: { id: { type: "string" } } },
      async run({ id } = {}) {
        if (id) { const p = readProposal(id); return p ? { ...p, files: p.files.map(f => f.path) } : { error: "no such proposal" }; }
        return { proposals: listProposals({ limit: 30 }) };
      }
    }
  ];
}

export function reject(p) {
  p.status = "rejected"; p.rejectedAt = new Date().toISOString();
  saveProposal(p);
  lattice.record("say", { agent: "human", to: p.agent, text: `The owner rejected the harness proposal "${p.title}".` });
  return p.status;
}
