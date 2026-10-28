// Trinity — ported from Avrone (trinity.py). The orchestration core.
//   PLAN  : an LLM planner decomposes the request into 2-4 self-contained subtasks
//   SQUAD : subtasks run in parallel as REAL agents (full tool loops), failure-isolated
//   LEAD  : a lead agent merges findings into one definitive answer; weak merges retry
//   DEEP  : waves of adversarial reviewers critique a draft until corrections converge
// Parallelism is governor-gated, and every step is written to the Eternal CodeX.

import { chatRoute } from "../llm/router.js";
import { runAgent } from "./runtime.js";
import { governor } from "./governor.js";
import { emit, newRunId, replay, runs } from "./codex.js";

const SQUAD_N = () => Math.max(1, Number(process.env.GROK_SQUAD_N) || 4);
const SQUAD_STEPS = () => Math.max(1, Number(process.env.GROK_SQUAD_STEPS) || 12);
const DEEP_ROUNDS = () => Math.max(1, Number(process.env.GROK_DEEP_ROUNDS) || 3);

const PLANNER_PROMPT = `You are the squad planner. Break the user's request into 2-4 independent, self-contained subtasks that different workers can execute in parallel without talking to each other. Reply with ONLY a JSON array of short task strings. No prose, no markdown fences.`;

const LEAD_PROMPT = `You are the squad lead. Merge the workers' findings below into ONE definitive answer to the user's request. Resolve contradictions, drop unsupported claims, keep any citations (URLs). Do NOT narrate what workers said — give the merged conclusion itself, directly.`;

export const DEEP_ANGLES = [
  "a skeptical fact-checker hunting for false or unsupported claims",
  "a missing-context reviewer finding what the answer should cover but doesn't",
  "a security and privacy reviewer looking for unsafe advice or leaked data",
  "a precision editor fixing imprecise wording, numbers, and units",
  "a practical operator judging whether the answer is actually actionable",
  "a contrary-minded reviewer arguing the strongest case against the answer"
];

// ---------- planning ----------
export function normalizeSubtasks(reply, { fallback = 3, max = 4 } = {}) {
  const text = String(reply || "");
  let items = [];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) items = parsed.filter(s => typeof s === "string" && s.trim()).map(s => s.trim());
    } catch { /* planner produced invalid JSON — fall through */ }
  }
  // dedupe case-insensitively
  const seen = new Set();
  items = items.filter(t => {
    const k = t.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (!items.length) {
    // Planner failed to produce JSON: fall back to N independent solvers of the same problem
    return Array.from({ length: fallback }, (_, i) =>
      `Independently research and answer part ${i + 1} of the request: "${text.slice(0, 200) || "the request"}".`);
  }
  return items.slice(0, max);
}

// ---------- lead quality gate ----------
export function weakLead(text, workers = 3) {
  const t = String(text || "").trim();
  if (!t) return "empty";
  const words = t.split(/\s+/).filter(Boolean).length;
  if (words < 10) return "thin";
  const sentences = t.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length >= 2) {
    const narration = sentences.filter(s =>
      /\b(said|says|reported|reports|answered|mentions|mentioned|replied|responded|wrote|stated|responded)\b/i.test(s)).length;
    if (narration / sentences.length >= 0.6) return "narration";
  }
  return null;
}

// ---------- markdown helpers ----------
export function mdSection(md, name = "Bottom line") {
  const m = String(md || "").match(
    new RegExp(`^#{2,3}\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s|\\s*$)`, "im"));
  return m ? m[1].trim() : "";
}

export function parseCorrections(text) {
  return String(text || "")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .filter(l => /\b(correction|wrong|fix(ed)?|update|instead|should be|actually)\b/i.test(l));
}

// ---------- concurrency ----------
async function pool(items, lanes, fn) {
  const out = new Array(items.length);
  let i = 0;
  const n = Math.max(1, Math.min(lanes || 1, items.length));
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}

// ---------- SQUAD ----------
export async function runSquad(agent, question, tools, { onNote, runId } = {}) {
  runId = runId || newRunId();
  emit(runId, "run.start", { mode: "squad", question });

  // 1. PLAN
  const planReply = await chatRoute(
    [{ role: "system", content: PLANNER_PROMPT }, { role: "user", content: question }],
    [], { mode: "think" });
  const subtasks = normalizeSubtasks(planReply.content, { fallback: SQUAD_N() });
  emit(runId, "plan.ready", { subtasks });
  onNote?.({ note: `Plan ready: ${subtasks.length} subtask${subtasks.length === 1 ? "" : "s"}` });

  // 2. SQUAD — real agents in parallel, governor-gated, failure-isolated
  const results = await pool(subtasks, governor.target(), async (sub, i) => {
    emit(runId, "agent.spawn", { agent: `worker-${i + 1}`, task: sub });
    try {
      const answer = await runAgent(
        { ...agent, id: `worker-${i + 1}`, name: `Worker ${i + 1}` },
        `${sub}\n\n(Context: original request was "${question}")`,
        tools, { maxSteps: SQUAD_STEPS(), runId, agentName: `worker-${i + 1}` });
      emit(runId, "agent.done", { agent: `worker-${i + 1}` });
      return { ok: true, answer };
    } catch (e) {
      emit(runId, "error", { agent: `worker-${i + 1}`, error: e.message });
      return { ok: false, error: e.message };
    }
  });

  const okCount = results.filter(r => r.ok).length;
  onNote?.({ note: `Workers done: ${okCount}/${subtasks.length}` });

  const findings = results.map((r, i) =>
    `### Worker ${i + 1} — ${subtasks[i]}\n${r.ok ? r.answer : `(failed: ${r.error}) — subtask remains unhandled`}`
  ).join("\n\n");
  if (okCount < subtasks.length) onNote?.({ note: `${subtasks.length - okCount} worker(s) failed — lead will work around the gap` });

  // 3. LEAD — merge; weak merges get one retry
  const findingsFor = () => [
    { role: "system", content: LEAD_PROMPT },
    { role: "user", content: `Original request: ${question}\n\nWorker findings:\n${findings}` }
  ];
  let lead = (await chatRoute(findingsFor(), [], { mode: "think" })).content;
  const weak = weakLead(lead, subtasks.length);
  if (weak) {
    emit(runId, "lead.retry", { reason: weak });
    onNote?.({ note: `Lead summary was weak (${weak}) — asking for a real merge` });
    lead = (await chatRoute(findingsFor().concat(
      [{ role: "user", content: "Your previous merge was rejected: it narrated workers instead of giving the merged answer. Give the definitive answer directly." }]),
      [], { mode: "think" })).content;
  }
  emit(runId, "lead.merge", { weak: weak || null });
  emit(runId, "run.done", { mode: "squad", workers: `${okCount}/${subtasks.length}` });
  return lead;
}

// ---------- DEEP ----------
export async function runDeep(agent, question, tools, { rounds, firstAnswer, onNote, runId } = {}) {
  runId = runId || newRunId();
  const maxRounds = rounds || DEEP_ROUNDS();
  emit(runId, "run.start", { mode: "deep", question });

  // Draft answer: reuse the chat answer if the caller already produced one
  const draft = firstAnswer || await runAgent(agent, question, tools, { runId, agentName: agent.id });
  emit(runId, "agent.done", { agent: agent.id, phase: "draft" });

  let report = "";
  let converged = false;
  let corrections = [];
  let failedTotal = 0;
  let round = 0;

  for (round = 1; round <= maxRounds; round++) {
    // Wave of adversarial reviewers — real agents, governor-gated
    const n = Math.min(governor.target(), DEEP_ANGLES.length);
    const angles = DEEP_ANGLES.slice(0, n);
    const reviews = await pool(angles, governor.target(), async (angle, i) => {
      emit(runId, "agent.spawn", { agent: `reviewer-${i + 1}`, role: angle });
      try {
        return { ok: true, text: await runAgent(
          { ...agent, id: `reviewer-${i + 1}`, name: `Reviewer ${i + 1}` },
          `Review the draft answer below as ${angle}. List concrete corrections (one per line, prefixed with "Correction:") or reply "no corrections".\n\nDraft:\n${draft}`,
          tools, { maxSteps: 6, runId, agentName: `reviewer-${i + 1}` }) };
      } catch (e) {
        emit(runId, "error", { agent: `reviewer-${i + 1}`, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    const failed = reviews.filter(r => !r.ok).length;
    failedTotal += failed;
    const merged = reviews.map((r, i) => `Reviewer ${i + 1} (${angles[i]}): ${r.ok ? r.text : `(failed: ${r.error})`}`).join("\n\n");

    // Lead consolidates the wave into a report
    report = (await chatRoute([
      { role: "system", content: `You are the deep review lead. Consolidate the reviewers' feedback on the draft into a report with EXACTLY these sections: "## Verdict" (converged or needs-work), "## Corrections" (one per line, prefixed with "Correction:", or "none"), "## Bottom line" (the corrected bottom-line answer) and a final "Confidence: N%" line with your confidence in the answer (0-100).` },
      { role: "user", content: `Question: ${question}\n\nDraft answer:\n${draft}\n\nReviewer feedback:\n${merged}` }
    ], [], { mode: "think" })).content;
    emit(runId, "deep.lead.report", { round });

    corrections = parseCorrections(mdSection(report, "Corrections"));
    converged = corrections.length === 0;
    onNote?.({ note: `Deep round ${round}: ${failed} reviewer failure(s), ${corrections.length} correction(s), ${converged ? "converged" : "revising"}` });
    if (converged) break;
  }

  // Confidence: lead's own number, penalized by reviewer failures and unconverged rounds
  const parsed = Number((report.match(/confidence\s*:?\s*(\d{1,3})/i) || [])[1]);
  let confidence = Number.isFinite(parsed) ? parsed : 70;
  confidence -= 5 * failedTotal;
  if (!converged) confidence -= 10 * round;
  confidence = Math.max(5, Math.min(95, Math.round(confidence)));

  const bottomLine = mdSection(report, "Bottom line");
  emit(runId, "run.done", { mode: "deep", converged, rounds: round, confidence });
  return { answer: report, bottomLine, converged, rounds: round, confidence, corrections };
}

export { replay, runs };
