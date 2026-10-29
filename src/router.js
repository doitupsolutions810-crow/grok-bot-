import { Router } from "express";
import { readFileSync } from "node:fs";
import {
  loadAgents, listBots, findAgent, runAgent, runOrchestrated,
  thinkAnswer, deepSearch, runSquad, runDeep,
  governor, replay, runs, dispatch, createBot
} from "./agents/index.js";
import { remember, memoryContext } from "./memory/store.js";
import { search, ingest } from "./rag/index.js";
import { addTask, listTasks, runTask, setTaskRunner } from "./tasks/scheduler.js";
import { issueToken, authRequired } from "./middleware/auth.js";
import { agentsCrud } from "./middleware/agents-crud.js";
import { pending, decide, takeHeld } from "./middleware/approvals.js";
import { asText } from "./memory/store.js";
import {
  streamChat, queryTraces, ledger, recordFeedback, recentFeedback,
  sseStart, sseNote, sseDone
} from "./observability/traces.js";
import { transcribe, speak } from "./voice/voice.js";
import { visionTool } from "./tools/vision.js";
import { outputDir } from "./paths.js";

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
    const out = await runAgent(agent, ctx, tools);
    // Auto Review paused the thread: tell the user how to release or reject it instead of crashing.
    const answer = out && out.pendingApproval != null
      ? `Auto Review is holding a risky command for your approval (#${out.pendingApproval}). `
        + `Approve or reject it in the console's Approvals panel, or POST /api/approvals/${out.pendingApproval}/decision {"approve":true|false}.`
      : out;
    await remember(session, "user", message);
    await remember(session, "assistant", answer);
    return { agent, answer, pendingApproval: out && out.pendingApproval != null ? out.pendingApproval : undefined };
  };

  r.get("/health", (req, res) => res.json({ ok: true, uptime: process.uptime() }));
  r.get("/docker/containers", async (req, res) => {
    const list = await docker.listContainers({ all: true });
    res.json(list.map(c => ({ id: c.Id.slice(0, 12), names: c.Names, image: c.Image, state: c.State })));
  });
  r.get("/traces", (req, res) => res.json(queryTraces(Number(req.query.limit) || 50)));
  r.get("/ledger", (req, res) => res.json(ledger()));

  // Auth (enable r.use(authRequired) below for exposed deployments)
  // Token minting requires the app password when auth is enabled (the gate in server.js enforces it).
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
    const { runId = "", comment = "", good = true } = req.body || {};
    res.json({ ok: true, id: recordFeedback({ runId, comment, good }) });
  });
  r.get("/feedback", (req, res) => res.json(recentFeedback(Number(req.query.limit) || 5)));

  // ---------- teammates (registry-backed CRUD + bots API) ----------
  agentsCrud(r);
  r.get("/bots", (req, res) => res.json(listBots()));
  r.post("/bots", (req, res) => {
    const { name, job, tools: botTools, model, mode, review, emoji, trigger } = req.body || {};
    if (!name || !job) return res.status(400).json({ error: "name and job required" });
    const bot = createBot({ name, job, tools: botTools, model, mode, review, emoji, trigger });
    res.status(201).json({ ok: true, bot });
  });

  // ---------- approvals (Auto Review) ----------
  r.get("/approvals", (req, res) => res.json(pending()));
  r.post("/approvals/:id/decision", async (req, res) => {
    const id = Number(req.params.id);
    const approve = !!(req.body || {}).approve;
    const held = takeHeld(id);          // claim exactly once → idempotent approve
    decide(id, approve);
    if (!approve || !held) return res.json({ ok: true, approved: approve, resumed: false });
    // Resume the paused thread: execute the held call, then continue the loop
    let result;
    try {
      const tool = tools.find(t => t.name === held.call.function.name);
      result = tool ? await tool.run(JSON.parse(held.call.function.arguments || "{}"), held.ctx) : { error: "unknown tool" };
    } catch (e) { result = { error: e.message }; }
    held.messages.push({ role: "tool", tool_call_id: held.call.id, content: JSON.stringify(result) });
    const answer = await runAgent(held.agent, "", tools, { resume: held.messages, runId: held.ctx?.run?.runId, agentName: held.ctx?.agent });
    res.json({ ok: true, approved: true, resumed: true, answer: asText(answer), ...(answer && answer.pendingApproval != null ? { pendingApproval: answer.pendingApproval } : {}) });
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
    if (!message) return res.status(400).json({ error: "message required" });
    const agent = agentId === "team" ? dispatch(message) : find(agentId);
    const ctx = buildContext(session, message);

    let answer;
    let extra = {};
    if (mode === "squad" || mode === "heavy") {           // legacy "heavy" aliases the Avrone squad
      const notes = [];
      answer = await runSquad(agent, ctx, tools, { onNote: n => notes.push(n.note) });
      extra = { mode: "squad", notes };
    } else if (mode === "deep") {
      const out = await runDeep(agent, ctx, tools, { rounds, firstAnswer, onNote: () => {} });
      answer = out.answer;
      extra = { mode: "deep", bottomLine: out.bottomLine, converged: out.converged, rounds: out.rounds, confidence: out.confidence };
    } else if (mode === "think") {
      answer = await thinkAnswer(message);
    } else if (mode === "deepsearch") {
      answer = (await deepSearch(message, tools.find(t => t.name === "browser"))).synthesis;
    } else {
      const out = await runWithMemory(agent.id, session, message);
      return res.json({ agentId: agent.id, mode, answer: out.answer, ...(out.pendingApproval != null ? { pendingApproval: out.pendingApproval } : {}) });
    }
    await remember(session, "user", message);
    await remember(session, "assistant", answer);
    res.json({ agentId: agent.id, ...extra, answer });
  });

  // Real streaming: chat pipes Ollama tokens; squad/deep stream {note} progress
  r.post("/chat/stream", async (req, res) => {
    const { agentId = "grok-main", message, session = "default", mode = "chat", rounds, firstAnswer } = req.body || {};
    if (!message) return res.status(400).json({ error: "message required" });
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
            rounds, firstAnswer, onNote: n => sseNote(res, { note: n.note })
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
    res.json(await tool.run(req.body || {}));
  });
  r.post("/rag/ingest", async (req, res) => { await ingest(req.body.path); res.json({ ok: true }); });
  r.post("/rag/search", async (req, res) => res.json(await search(req.body.query)));
  r.post("/vision", async (req, res) =>
    res.json({ description: await visionTool.run({ imageBase64: req.body.imageBase64, question: req.body.question }) }));
  r.post("/voice/stt", async (req, res) =>
    res.json({ text: await transcribe(Buffer.from(req.body.audioBase64, "base64")) }));
  r.get("/voice/tts", async (req, res) =>
    res.json(await speak(String(req.query.text || "").slice(0, 1000))));
  r.get("/tasks", (req, res) => res.json(listTasks()));
  r.post("/tasks", (req, res) => res.json({ id: addTask(req.body) }));
  r.post("/tasks/:id/run", async (req, res) => { await runTask(+req.params.id); res.json({ ok: true }); });
  r.get("/images/:file", (req, res) =>
    res.type("image/png").send(readFileSync(`${outputDir()}/${req.params.file}`)));

  return r;
}
