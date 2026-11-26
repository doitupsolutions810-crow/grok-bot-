import { Router } from "express";
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
import {
  streamChat, queryTraces, ledger, recordFeedback, recentFeedback,
  sseStart, sseNote, sseDone
} from "./observability/traces.js";
import { transcribe, speak } from "./voice/voice.js";
import { visionTool } from "./tools/vision.js";

// RAG may only read project files, never system pseudo-files or app secrets
export const RAG_ROOTS = (process.env.RAG_ROOTS || "/workspace,/app/docs").split(",").map(x => x.trim()).filter(Boolean);
export function ragPath(p) {
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  const abs = resolvePath(p);
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
    await streamChat(res, agent, ctx, tools);
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
    res.json(await search(q.slice(0, 4000)));
  });
  r.post("/vision", async (req, res) => {
    const { imageBase64, question } = req.body || {};
    if (typeof imageBase64 !== "string" || !imageBase64) return res.status(400).json({ error: "imageBase64 required" });
    res.json({ description: await visionTool.run({ imageBase64, question: typeof question === "string" ? question : undefined }) });
  });
  r.post("/voice/stt", async (req, res) => {
    const a = (req.body || {}).audioBase64;
    if (typeof a !== "string" || !a) return res.status(400).json({ error: "audioBase64 required" });
    res.json({ text: await transcribe(Buffer.from(a, "base64")) });
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
  r.get("/images/:file", (req, res) => {
    const file = String(req.params.file);
    if (!/^[\w.-]+\.png$/.test(file) || file.includes("..")) return res.status(400).json({ error: "bad file name" });
    try { res.type("image/png").send(readFileSync(`/output/${file}`)); }
    catch { res.status(404).json({ error: "no such image" }); }
  });

  return r;
}
