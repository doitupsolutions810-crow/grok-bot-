import { Router } from "express";
import { saveSkill, listSkills, loadPlaybooks, validateSkill, skillTool } from "./tools/skills.js";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
  loadAgents, listBots, findAgent, runAgent, runOrchestrated,
  thinkAnswer, deepSearch, runSquad, runDeep,
  governor, replay, runs, dispatch, createBot
} from "./agents/index.js";
import { remember, memoryContext } from "./memory/store.js";
import { search, ingest } from "./rag/index.js";
import { addTask, listTasks, runTask, setTaskRunner, deleteTask } from "./tasks/scheduler.js";
import { issueToken, authRequired } from "./middleware/auth.js";
import { agentsCrud } from "./middleware/agents-crud.js";
import { pending, decide, takeHeld, approvalStatus, needsReview } from "./middleware/approvals.js";
import { resumeHeld } from "./agents/runtime.js";
import { getAgent } from "./agents/registry.js";
import * as nodes from "./agents/nodes.js";
import * as lattice from "./agents/lattice.js";
import * as harness from "./agents/harness.js";
import { post as postDialogue, feed as dialogueFeed, knowledge as teamKnowledge, council, KINDS } from "./agents/dialogue.js";
import {
  streamChat, queryTraces, ledger, recordFeedback, recentFeedback,
  sseStart, sseNote, sseDone
} from "./observability/traces.js";
import { transcribe, speak } from "./voice/voice.js";
import { visionTool } from "./tools/vision.js";

// RAG reads project files by default (RAG_ROOTS); secrets need the explicit opt-in below
export const RAG_ROOTS = (process.env.RAG_ROOTS || "/workspace,/app/docs").split(",").map(x => x.trim()).filter(Boolean);
// RAG_ALLOW_SECRETS=true lets ingest read any file (env files, keys) — owner opt-in.
export function ragPath(p) {
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  const abs = resolvePath(p);
  if (process.env.RAG_ALLOW_SECRETS === "true") return abs;
  return RAG_ROOTS.some(r => { const root = r.replace(/\/+$/, ""); return abs.startsWith(root + "/"); }) ? abs : null;
}
// deep rounds come from the request body: clamp so one call can't loop for hours
export const clampRounds = r => (r == null || r === "" ? undefined : Math.min(Math.max(1, Math.floor(Number(r)) || 1), 10));

export function makeRouter({ tools, docker }) {
  const r = Router();
  const { agents } = loadAgents();
  const find = id => findAgent(id) || agents["grok-main"];

  // Scheduled tasks execute through the live agent runtime
  setTaskRunner(async (agentId, prompt) => runAgent(find(agentId), prompt, tools));

  // Chat context = memory + user feedback from previous runs
  const buildContext = (session, message) => {
    const fb = recentFeedback(3);
    const fbNote = fb.length
      ? `User feedback from previous runs (honor it):\n${fb.map(f => `- (${f.good ? "good" : "bad"}) ${f.comment}`).join("\n")}`
      : "";
    return [memoryContext(session), fbNote, message].filter(Boolean).join("\n\n");
  };
  const runWithMemory = async (agentId, session, message) => {
    const agent = agentId === "team" ? dispatch(message) : find(agentId);
    const ctx = buildContext(session, message);
    const answer = await runAgent(agent, ctx, tools);
    await remember(session, "user", message);
    await remember(session, "assistant", answer);
    return { agent, answer };
  };

  r.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));
  r.get("/docker/containers", async (req, res) => {
    const list = await docker.listContainers({ all: true });
    res.json(list.map(c => ({ id: c.Id.slice(0, 12), names: c.Names, image: c.Image, state: c.State })));
  });
  r.get("/traces", (req, res) => res.json(queryTraces(Number(req.query.limit) || 50)));
  r.get("/ledger", (req, res) => res.json(ledger()));

  // Auth (enable r.use(authRequired) below for exposed deployments)
  r.post("/auth/token", (req, res) => res.json({ token: issueToken() }));
  // r.use(authRequired);

  // ---------- runs / governor / feedback (Avrone observability) ----------
  r.get("/runs", (req, res) => res.json(runs()));
  r.get("/runs/:id", (req, res) => {
    const run = replay(req.params.id);
    if (!run) return res.status(404).json({ error: "no such run" });
    res.json(run);
  });
  r.get("/governor", (req, res) => res.json(governor.snapshot()));
  r.post("/feedback", (req, res) => {
    const b = req.body || {};
    const runId = typeof b.runId === "string" ? b.runId : "", comment = typeof b.comment === "string" ? b.comment : "", good = b.good !== false;
    res.json({ ok: true, id: recordFeedback({ runId, comment, good }) });
  });
  r.get("/feedback", (req, res) => res.json(recentFeedback(Number(req.query.limit) || 5)));

  // ---------- teammates (registry-backed CRUD + bots API) ----------
  agentsCrud(r);
  r.get("/bots", (req, res) => res.json(listBots()));
  r.post("/bots", (req, res) => {
    const { name, job, instructions, tools: botTools, model, mode, review, emoji, trigger } = req.body || {};
    if (typeof name !== "string" || !name.trim() || (!job && !instructions)) return res.status(400).json({ error: "name and a job or instructions required" });
    const bot = createBot({ name: name.trim().slice(0, 64), job, instructions: typeof instructions === "string" ? instructions.slice(0, 8000) : "", tools: botTools, model, mode, review, emoji, trigger });
    res.status(201).json({ ok: true, bot });
  });

  // ---------- approvals (Auto Review) ----------
  r.get("/approvals", (req, res) => res.json(pending()));
  r.post("/approvals/:id/decision", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "bad approval id" });
    const body = req.body || {};
    if (typeof body.approve !== "boolean") return res.status(400).json({ error: "approve must be true or false" });
    const approve = body.approve;
    const status = approvalStatus(id);
    if (!status) return res.status(404).json({ error: "no such approval" });
    if (status !== "pending") return res.status(409).json({ error: `already ${status}` });
    const held = takeHeld(id);          // claim exactly once
    decide(id, approve);
    if (!held) return res.json({ ok: true, approved: approve, resumed: false });
    try {
      const answer = await resumeHeld(held, tools, approve);
      res.json({ ok: true, approved: approve, resumed: true, answer });
    } catch (e) {
      res.status(502).json({ ok: false, approved: approve, resumed: false, error: e.message });
    }
  });

  // ---------- X triggers ----------
  r.post("/x/trigger", async (req, res) => {
    const text = String((req.body || {}).text || "").trim();
    if (!text) return res.status(400).json({ error: "text required" });
    const agent = dispatch(text);     // chief of staff routes the mention to the right teammate
    const answer = await runAgent(agent, text, tools);
    res.json({ ok: true, routedTo: agent.id, answer });
  });

  // ---------- chat (all modes) ----------
  r.post("/chat", async (req, res) => {
    const { agentId = "grok-main", message, session = "default", mode = "chat", rounds, firstAnswer } = req.body || {};
    if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "message required" });
    const agent = agentId === "team" ? dispatch(message) : find(agentId);
    const ctx = buildContext(session, message);

    let answer;
    let extra = {};
    if (mode === "squad" || mode === "heavy") {           // legacy "heavy" aliases the Avrone squad
      const notes = [];
      answer = await runSquad(agent, ctx, tools, { onNote: n => notes.push(n.note) });
      extra = { mode: "squad", notes };
    } else if (mode === "deep") {
      const out = await runDeep(agent, ctx, tools, { rounds: clampRounds(rounds), firstAnswer: typeof firstAnswer === "string" ? firstAnswer : undefined, onNote: () => {} });
      answer = out.answer;
      extra = { mode: "deep", bottomLine: out.bottomLine, converged: out.converged, rounds: out.rounds, confidence: out.confidence };
    } else if (mode === "think") {
      answer = await thinkAnswer(message);
    } else if (mode === "deepsearch") {
      answer = (await deepSearch(message, tools.find(t => t.name === "browser"))).synthesis;
    } else {
      ({ answer } = await runWithMemory(agent.id, session, message));
      return res.json({ agentId: agent.id, mode, answer });
    }
    await remember(session, "user", message);
    await remember(session, "assistant", answer);
    res.json({ agentId: agent.id, ...extra, answer });
  });

  // Real streaming: chat pipes Ollama tokens; squad/deep stream {note} progress
  r.post("/chat/stream", async (req, res) => {
    const { agentId = "grok-main", message, session = "default", mode = "chat", rounds, firstAnswer } = req.body || {};
    if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "message required" });
    const agent = agentId === "team" ? dispatch(message) : find(agentId);
    const ctx = buildContext(session, message);
    sseStart(res);

    const finish = async answer => {
      sseNote(res, { delta: answer });
      await remember(session, "user", message);
      await remember(session, "assistant", answer);
      sseDone(res);
    };

    if (mode === "squad" || mode === "heavy" || mode === "deep") {
      try {
        if (mode === "deep") {
          const out = await runDeep(agent, ctx, tools, {
            rounds: clampRounds(rounds), firstAnswer: typeof firstAnswer === "string" ? firstAnswer : undefined, onNote: n => sseNote(res, { note: n.note })
          });
          await remember(session, "user", message);
          await remember(session, "assistant", out.answer);
          sseNote(res, { delta: out.answer, deep: { converged: out.converged, rounds: out.rounds, confidence: out.confidence } });
        } else {
          const answer = await runSquad(agent, ctx, tools, { onNote: n => sseNote(res, { note: n.note }) });
          await remember(session, "user", message);
          await remember(session, "assistant", answer);
          sseNote(res, { delta: answer });
        }
      } catch (e) {
        sseNote(res, { delta: `orchestration failed: ${e.message}` });
      }
      return sseDone(res);
    }
    if (mode === "think") {
      return finish(await thinkAnswer(message));
    }
    if (mode === "deepsearch") {
      return finish((await deepSearch(message, tools.find(t => t.name === "browser"))).synthesis);
    }
    // streamed chats are remembered too (they used to be forgotten)
    const text = await streamChat(res, agent, ctx, tools, { fallback: () => runAgent(agent, ctx, tools) });
    if (text) { await remember(session, "user", message); await remember(session, "assistant", text); }
  });

  // ---------- tools / RAG / vision / voice / tasks / images ----------
  r.post("/tools/:name/invoke", async (req, res) => {
    const tool = tools.find(t => t.name === req.params.name);
    if (!tool) return res.status(404).json({ error: "unknown tool" });
    const args = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    // direct invocation must not bypass Auto Review for dangerous commands
    if (needsReview(tool.name, args)) return res.status(403).json({ error: "needs review: run it through an Auto Review agent so a human can approve it" });
    try { res.json(await tool.run(args, { agent: "api", run: {}, spawnDepth: 0 })); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });
  r.post("/rag/ingest", async (req, res) => {
    const p = ragPath((req.body || {}).path);
    if (!p) return res.status(400).json({ error: `path must be a file under ${RAG_ROOTS.join(" or ")}` });
    try { await ingest(p); res.json({ ok: true, path: p }); }
    catch (e) { res.status(e.code === "ENOENT" ? 404 : 500).json({ error: e.message }); }
  });
  r.post("/rag/search", async (req, res) => {
    const q = (req.body || {}).query;
    if (typeof q !== "string" || !q.trim()) return res.status(400).json({ error: "query required" });
    try { res.json(await search(q.slice(0, 4000))); }
    catch (e) { res.status(503).json({ error: e.message }); }
  });
  r.post("/vision", async (req, res) => {
    const { imageBase64, question } = req.body || {};
    if (typeof imageBase64 !== "string" || !imageBase64) return res.status(400).json({ error: "imageBase64 required" });
    res.json({ description: await visionTool.run({ imageBase64, question: typeof question === "string" ? question : undefined }) });
  });
  r.post("/voice/stt", async (req, res) => {
    const a = (req.body || {}).audioBase64;
    if (typeof a !== "string" || !a) return res.status(400).json({ error: "audioBase64 required" });
    const buf = Buffer.from(a.replace(/^data:[^;,]+;base64,/, ""), "base64");
    if (!buf.length) return res.status(400).json({ error: "audioBase64 decoded to nothing" });
    try { res.json({ text: await transcribe(buf) }); }
    catch (e) { res.status(503).json({ error: e.message }); }
  });
  r.get("/voice/tts", async (req, res) =>
    res.json(await speak(String(req.query.text || "").slice(0, 1000))));
  r.get("/tasks", (req, res) => res.json(listTasks()));
  r.post("/tasks", (req, res) => {
    try { res.status(201).json({ id: addTask(req.body || {}) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  r.post("/tasks/:id/run", async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: "bad task id" });
    const id = await runTask(+req.params.id);
    if (id == null) return res.status(404).json({ error: "no such task" });
    res.json({ ok: true });
  });
  r.delete("/tasks/:id", (req, res) => !/^\d+$/.test(req.params.id) ? res.status(400).json({ error: "bad task id" }) : res.status(deleteTask(+req.params.id) ? 200 : 404).json({ ok: true }));
  // Teach-a-task: record a browser workflow → it becomes the skill.<name> tool immediately
  // ---------- team dialogue: what the agents say to each other, and what they discovered ----------
  r.get("/dialogue", (req, res) => res.json(dialogueFeed({ runId: req.query.run, limit: req.query.limit, kind: req.query.kind })));
  r.get("/knowledge", (req, res) => res.json(teamKnowledge({ q: req.query.q, limit: req.query.limit })));
  r.post("/dialogue", (req, res) => {          // a human drops a message into the team channel
    const { text, to = "*", runId = "" } = req.body || {};
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "text required" });
    if (typeof to !== "string") return res.status(400).json({ error: "to must be a string" });
    res.status(201).json({ id: postDialogue({ from: "human", to, kind: "human", text, runId }) });
  });
  r.post("/council", async (req, res) => {     // a real round-table between named agents
    const { topic, agents: names, rounds } = req.body || {};
    if (typeof topic !== "string" || !topic.trim()) return res.status(400).json({ error: "topic required" });
    if (!Array.isArray(names) || names.length < 2 || names.some(n => typeof n !== "string")) return res.status(400).json({ error: "agents must list at least 2 agent ids" });
    const unknown = names.filter(n => !getAgent(n));
    if (unknown.length) return res.status(404).json({ error: `unknown agents: ${unknown.join(", ")}` });
    try { res.json(await council({ topic, agents: names, rounds, runAgent, tools: tools || [], getAgent })); }
    catch (e) { res.status(502).json({ error: e.message }); }
  });
  // ---------- the Lattice: follow every agent's prompts, thoughts, tools and talk ----------
  const latticeQuery = q => ({ agent: q.agent, kind: q.kind, runId: q.runId, since: q.since, q: q.q, limit: q.limit });
  r.get("/lattice/events", (req, res) => res.json({ events: lattice.events(latticeQuery(req.query)) }));
  r.get("/lattice/graph", (_req, res) => res.json(lattice.graph()));
  r.get("/lattice/status", (_req, res) => res.json(lattice.status()));
  r.get("/lattice/agents/:id", (req, res) => {
    const tl = lattice.events({ ...latticeQuery(req.query), agent: req.params.id });
    res.json({ agent: req.params.id, events: tl, discoveries: tl.filter(e => e.kind === "eureka").map(e => e.text) });
  });
  r.get("/lattice/stream", (req, res) => {       // live follow over SSE, optionally one agent/kind
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const f = latticeQuery(req.query);
    for (const e of lattice.events({ ...f, limit: Math.min(Number(f.limit) || 50, 500) })) res.write(`data: ${JSON.stringify(e)}\n\n`);
    const kinds = f.kind ? String(f.kind).split(",") : null;
    const off = lattice.subscribe(e => {
      if (f.agent && e.agent !== f.agent && e.to !== f.agent) return;
      if (kinds && !kinds.includes(e.kind)) return;
      if (f.runId && e.runId !== f.runId) return;
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000); ping.unref?.();
    req.on("close", () => { off(); clearInterval(ping); });
  });
  r.get("/lattice/highlights", (req, res) => {
    const runIds = req.query.runIds ? String(req.query.runIds).split(",") : lattice.sessionStatus().runIds;
    res.json({ highlights: lattice.highlights({ runIds, limit: req.query.limit }) });
  });
  r.get("/lattice/mission", (_req, res) => res.json({ mission: lattice.mission() }));
  r.get("/lattice/session", (_req, res) => res.json(lattice.sessionStatus()));
  r.post("/lattice/session", (req, res) => {       // e.g. {"minutes":10,"agents":["grok-main","edge-critic"]}
    const { minutes, agents: names } = req.body || {};
    if (minutes !== undefined && !(Number(minutes) >= 1 && Number(minutes) <= 60)) return res.status(400).json({ error: "minutes must be 1..60" });
    if (names !== undefined && (!Array.isArray(names) || names.length < 2 || names.some(n => typeof n !== "string" || !getAgent(n))))
      return res.status(400).json({ error: "agents must list at least 2 known agent ids" });
    const out = lattice.startSession({ council, runAgent, tools: tools || [], getAgent, knowledge: teamKnowledge }, { minutes, agents: names });
    res.status(out.error ? 409 : 202).json(out);
  });
  r.delete("/lattice/session", (_req, res) => res.json(lattice.stopSession()));
  r.post("/lattice/grow", async (req, res) => {   // one autonomous growth cycle now
    const names = req.body?.agents;
    if (names !== undefined && (!Array.isArray(names) || names.some(n => typeof n !== "string" || !getAgent(n))))
      return res.status(400).json({ error: "agents must be a list of known agent ids" });
    const out = await lattice.growOnce({ council, runAgent, tools: tools || [], getAgent, knowledge: teamKnowledge, agents: names });
    res.status(out.skipped ? 409 : out.ok ? 200 : 502).json(out);
  });
  // ---------- self-development: agents' proposals to improve their own harness ----------
  r.get("/harness/proposals", (req, res) => res.json({ autoApply: process.env.HARNESS_AUTO_APPLY === "true", proposals: harness.listProposals({ limit: req.query.limit }) }));
  r.get("/harness/proposals/:id", (req, res) => {
    const p = harness.getProposal(req.params.id);
    p ? res.json(p) : res.status(404).json({ error: "no such proposal" });
  });
  r.post("/harness/proposals/:id/approve", (req, res) => {
    const p = harness.getProposal(req.params.id);
    if (!p) return res.status(404).json({ error: "no such proposal" });
    try { const a = harness.applyProposal(p, "owner"); res.json({ id: a.id, status: a.status, files: a.files.map(f => f.path), note: "restart grok-bot to load the changed code" }); }
    catch (e) { res.status(409).json({ error: e.message }); }
  });
  r.post("/harness/proposals/:id/reject", (req, res) => {
    const p = harness.getProposal(req.params.id);
    if (!p) return res.status(404).json({ error: "no such proposal" });
    if (p.status === "applied") return res.status(409).json({ error: "already applied" });
    res.json({ id: p.id, status: harness.reject(p) });
  });
  // ---------- agent nodes: one machine per agent ----------
  r.get("/nodes", async (_req, res) => {
    if (!nodes.enabled()) return res.json({ enabled: false, nodes: [] });
    try { res.json({ enabled: true, nodes: await nodes.listNodes(docker) }); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  r.post("/agents/:id/node", async (req, res) => {
    const a = getAgent(req.params.id);
    if (!a) return res.status(404).json({ error: "unknown agent" });
    if (!nodes.enabled()) return res.status(409).json({ error: "agent nodes are disabled (set AGENT_NODES=true)" });
    try { res.json(await nodes.ensureNode(docker, a)); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  r.delete("/agents/:id/node", async (req, res) => {
    if (!getAgent(req.params.id)) return res.status(404).json({ error: "unknown agent" });
    if (!nodes.enabled()) return res.status(409).json({ error: "agent nodes are disabled (set AGENT_NODES=true)" });
    try { res.json({ removed: await nodes.removeNode(docker, req.params.id) }); } catch (e) { res.status(502).json({ error: e.message }); }
  });
  r.get("/tools", (_req, res) => res.json((tools || []).map(t => ({ name: t.name, description: t.description || "", review: needsReview(t.name, {}) }))));
  r.get("/skills", (_req, res) => res.json({ recorded: listSkills().map(s => ({ name: s.name, description: s.description, steps: s.steps.length })), playbooks: loadPlaybooks().map(p => ({ name: p.name, description: p.description })) }));
  r.post("/skills", async (req, res) => {
    const { name, description, steps } = req.body || {};
    const bad = validateSkill(name, description, steps);
    if (bad) return res.status(400).json({ error: bad });
    await saveSkill(name, description, steps);
    if (Array.isArray(tools)) {
      const t = skillTool({ name, description: String(description || ""), steps });
      const i = tools.findIndex(x => x.name === t.name);
      if (i >= 0) tools[i] = t; else tools.push(t);
    }
    res.status(201).json({ ok: true, tool: `skill.${name}` });
  });
  r.get("/images/:file", (req, res) => {
    const file = String(req.params.file);
    if (!/^[\w.-]+\.png$/.test(file) || file.includes("..")) return res.status(400).json({ error: "bad file name" });
    try { res.type("image/png").send(readFileSync(`/output/${file}`)); }
    catch { res.status(404).json({ error: "no such image" }); }
  });

  return r;
}
