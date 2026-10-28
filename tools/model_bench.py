#!/usr/bin/env python3
"""Live model bench for AVRONE / Grok Bot agent orchestration.

No mocks: every score comes from real chat calls against a live Ollama server
(OpenAI-compatible /v1/chat/completions) and the `shell` tool REALLY executes
commands on this host. Models are scored on exactly what AVRONE needs:

  1. JSON actions  (30 pts) - the worker replies parse as a valid action every
     turn: {"tool": ..., "args": ...} / {"tools": [...]} / {"final": ...}.
     This is avrone.trinity.parse_action, ported 1:1.
  2. Tool use      (25 pts) - the model actually calls the provided shell tool
     (15) instead of guessing, and its final answer contains the correct
     computed value (10).
  3. Squad         (35 pts) - the PLANNER emits usable subtask JSON (10), both
     workers finish with real results (10), the LEAD merges a non-weak answer
     (15) (narration/thin-merge check ported 1:1, one retry like AVRONE).
  4. Deep wave     (10 pts) - the recursive review stage: 2 DEEP reviewers +
     DEEP LEAD produce the structured report with all six sections and a
     "Confidence:" line (verdict+confidence 5, all sections 5).

Protocols:
  --protocol json    AVRONE worker protocol (one fenced JSON block per turn).
  --protocol native  OpenAI tool_calls via the `tools` parameter (Grok Bot style).

Robustness - orchestration never degrades on failure:
  - health check + health-wait around every call, per-call retries, so a model
    server that drops mid-run (like llama3.2 did) is waited out, not fatal;
  - per-model exception isolation: one broken model never kills the bench;
  - missing models are pulled; a failed pull scores "unavailable", not a crash;
  - results are written incrementally so partial results always survive.

Prompts and protocol mirror avrone/trinity.py - keep the two in sync.

Usage:
  python3 tools/model_bench.py                       # default 4 models, json
  python3 tools/model_bench.py --models qwen2.5:3b --protocol native
  BENCH_MODELS=qwen2.5:3b,llama3.2:3b BENCH_DEEP=0 python3 tools/model_bench.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any

# --------------------------------------------------------------------------
# Config (env overridable)
# --------------------------------------------------------------------------
DEFAULT_MODELS = "qwen2.5:3b,llama3.2:3b,qwen3.5:4b,gemma3:4b"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------------------------
# AVRONE protocol - ported 1:1 from avrone/trinity.py (keep in sync)
# --------------------------------------------------------------------------
PLANNER_PROMPT = """You are the PLANNER in AVRONE, a multi-agent system.
Split the user's task into {n} independent angles that different agents can work
on IN PARALLEL (e.g. research, implementation, verification, devil's advocate).
Every angle must be useful alone; do not make one depend on another.
Reply with JSON only: {{"subtasks": [{{"role": "<short role name>", "focus": "<what this agent should do>"}}]}}"""

WORKER_PROMPT = """You are {name}, the {role} agent in AVRONE, working inside a real Linux
environment with a workspace directory. Overall task from the user:
{task}

Your focus: {focus}

{tools}
Reply with ONE fenced JSON block per turn, either a tool call:
```json
{{"tool": "<name>", "args": {{...}}}}
```
or, for independent calls that can run at the same time (up to {max_calls}), a batch:
```json
{{"tools": [{{"tool": "<name>", "args": {{...}}}}, {{"tool": "<name>", "args": {{...}}}}]}}
```
or, when you are done, your final result:
```json
{{"final": "<your complete findings, including any code, commands run and results>"}}
```
Be concrete. Verify claims with tools when you can. You have at most {steps} turns.
Working habits: if a skill fits your job, skill_load it first; for multi-part work, put
subtasks on task_board and update them; if a tool or package is missing, install it with
env_install (self-changes are allowed and logged) and carry on; never invent tool output."""

WORKER_PROMPT_NATIVE = """You are {name}, the {role} agent in AVRONE, working inside a real Linux
environment with a workspace directory. Overall task from the user:
{task}

Your focus: {focus}

{tools}
Call tools with the provided function-calling interface. When you are done, reply
with your final result as plain text (complete findings, including any commands run
and their results). Be concrete. Verify claims with tools when you can.
You have at most {steps} turns. Never invent tool output."""

LEAD_PROMPT = """You are the LEAD agent in AVRONE. Several agents worked the same task in
parallel from different angles. Compare their work like a study group:
- keep what is verified or agreed on,
- where they disagree, reason out which is right (say so briefly),
- drop anything unsupported,
then write ONE final answer for the user. Answer the task directly; do not
describe the agents unless it helps. You have no tools and no further turns:
never say you will check, inspect or verify something. Write the finished answer now,
with the concrete facts, numbers and exact strings the agents verified."""

DEEP_WORKER_PROMPT = """You are {name}, the {role} reviewer in AVRONE's DEEP ANALYSIS wave, working
inside a real Linux environment with a workspace directory. Someone already
answered the question below (the first wave). Your job is to stress-test and
extend that answer from your angle, not to rewrite it.

{task}

Your angle: {focus}

{tools}
Reply with ONE fenced JSON block per turn, either a tool call:
```json
{{"tool": "<name>", "args": {{...}}}}
```
or, when you are done, your final review:
```json
{{"final": "<your findings: each point, whether it holds, evidence and source URLs>"}}
```
Check claims with tools (fetch pages, run code) when you can and cite what you
opened. Say plainly what you could not verify. You have at most {steps} turns."""

DEEP_LEAD_PROMPT = """You are the DEEP LEAD in AVRONE. A first-wave answer to the user's question
was reviewed by a second wave of specialist reviewers (fact-checking, gaps,
counter-arguments, deeper detail, risks, sources). Weigh their reviews, keep
only what is supported, and write a markdown report with exactly these sections:

## Verdict
One of: Confirmed / Corrected / Extended, then "Confidence: High|Med|Low" and one sentence why.
## Corrections
Claims in the first answer that are wrong or outdated, each with the fix. "None" if none.
## Additions
What the first answer missed: edge cases, details, what the user should also know.
## Counterpoints
The strongest counter-arguments or alternatives, and how much weight they deserve.
## Sources
Primary sources and links the reviewers actually opened (bullet list).
## Bottom line
The corrected, complete answer in a few sentences."""

DEEP_ANGLES = [
    {"role": "Fact-Checker",
     "focus": "Verify each factual claim in the first answer with tools or the web. "
              "Flag anything wrong, unsupported or outdated, with the correct value and its source."},
    {"role": "Contrarian",
     "focus": "Build the strongest counter-arguments and alternative approaches or "
              "conclusions to the first answer."},
]

_NARRATION = re.compile(r"^\s*(I['’]ll|I will|I am|I'm|Let me|Checking|I am checking)\b", re.I)


def _weak_lead(answer: str, reports: str) -> bool:
    """A lead reply that narrates intent or is far thinner than the reports it merges."""
    a = (answer or "").strip()
    return bool(_NARRATION.match(a)) or (len(a) < 300 and len(reports) > 2000)


def parse_action(text: str) -> dict[str, Any] | None:
    """Pull the JSON action out of a model reply (fenced or bare)."""
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = [m.group(1)] if m else []
    b = re.search(r"\{.*\}", text, re.S)
    if b:
        candidates.append(b.group(0))
    for c in candidates:
        try:
            obj = json.loads(c)
            if isinstance(obj, dict) and ("tool" in obj or "final" in obj or "tools" in obj):
                return obj
        except json.JSONDecodeError:
            continue
    return None


def _normalize_subtasks(reply: str, n: int) -> list[dict[str, str]]:
    """Turn whatever the planner replied into 1..n clean {"role", "focus"} dicts."""
    raw: Any = []
    try:
        m = re.search(r"\{.*\}", reply or "", re.S)
        obj = json.loads(m.group(0)) if m else {}
        raw = obj.get("subtasks", []) if isinstance(obj, dict) else []
    except (json.JSONDecodeError, RecursionError):
        raw = []
    subtasks: list[dict[str, str]] = []
    for s in raw if isinstance(raw, list) else []:
        if not isinstance(s, dict) or not s.get("focus"):
            continue
        focus = s["focus"] if isinstance(s["focus"], str) else json.dumps(s["focus"], default=str)
        role = s.get("role")
        role = role.strip() if isinstance(role, str) and role.strip() else f"Agent{len(subtasks) + 1}"
        subtasks.append({"role": role[:60], "focus": focus[:2000]})
        if len(subtasks) >= n:
            break
    if not subtasks:
        subtasks = [{"role": f"Solver{i + 1}", "focus": "Solve the whole task independently."}
                    for i in range(n)]
    return subtasks


def _md_section(report: str, title: str) -> str:
    """Body of the '## <title>' section of a markdown report ('' if absent)."""
    m = re.search(rf"^##\s*{re.escape(title)}\s*$(.*?)(?=^##\s|\Z)", report or "", re.S | re.M | re.I)
    return m.group(1).strip() if m else ""


_CONF_RE = re.compile(r"confidence\s*[:=]?\s*\**\s*(high|medium|med|low)\b", re.I)


def _lead_confidence(report: str) -> str | None:
    m = _CONF_RE.search(_md_section(report, "Verdict") or report or "")
    if not m:
        return None
    v = m.group(1).lower()
    return "High" if v == "high" else "Low" if v == "low" else "Med"


# --------------------------------------------------------------------------
# The one real tool: shell (really executes on this host)
# --------------------------------------------------------------------------
SHELL_DOC = """Tools you may call (they run for real and return real output):
- shell: run a shell command in the workspace. args: {"cmd": "<command>"}"""

SHELL_NATIVE_SPEC = {
    "type": "function",
    "function": {
        "name": "shell",
        "description": "Run a shell command in the workspace and return its output.",
        "parameters": {
            "type": "object",
            "properties": {"cmd": {"type": "string", "description": "The shell command to run"}},
            "required": ["cmd"],
        },
    },
}


def run_shell(args: dict[str, Any]) -> str:
    """Execute a shell tool call for real (no mocks). Errors become tool output."""
    cmd = args.get("cmd") if isinstance(args, dict) else None
    if not isinstance(cmd, str) or not cmd.strip():
        return "ARG ERROR: shell expects {\"cmd\": \"<command>\"}"
    try:
        p = subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, timeout=20)
        out = (p.stdout or "") + (("\n[stderr] " + p.stderr) if p.stderr else "")
        out = out.strip() or f"[exit {p.returncode}, no output]"
        return out[:4000]
    except subprocess.TimeoutExpired:
        return "ERROR: command timed out after 20s"
    except Exception as e:  # never crash the loop on a bad call
        return f"ERROR: {type(e).__name__}: {e}"


# --------------------------------------------------------------------------
# Ollama client with health-wait + retries (survives server drops mid-run)
# --------------------------------------------------------------------------
class BenchError(Exception):
    pass


class Ollama:
    def __init__(self, base: str, health_wait: int, retries: int, chat_timeout: int):
        self.base = base.rstrip("/")
        self.v1 = self.base + "/v1"
        self.health_wait = health_wait
        self.retries = retries
        self.chat_timeout = chat_timeout

    # -- low level ----------------------------------------------------------
    def _raw(self, path: str, body: dict[str, Any] | None, timeout: int,
             method: str = "POST") -> Any:
        url = self.base + path
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())

    def healthy(self) -> bool:
        try:
            self._raw("/api/tags", None, 10, method="GET")
            return True
        except Exception:
            return False

    def wait_healthy(self, why: str) -> None:
        """Hold the run until the server answers again (bounded by health_wait)."""
        deadline = time.monotonic() + self.health_wait
        slept = 0.0
        while time.monotonic() < deadline:
            if self.healthy():
                if slept:
                    print(f"    [server back after {slept:.0f}s: {why}]", flush=True)
                return
            time.sleep(5)
            slept += 5
        raise BenchError(f"server unhealthy for {self.health_wait}s ({why})")

    # -- model management ---------------------------------------------------
    def has_model(self, model: str) -> bool:
        tags = self._raw("/api/tags", None, 30, method="GET")
        names = {m.get("name", "") for m in tags.get("models", [])}
        names |= {n.split(":")[0] for n in names}
        return model in names or model.split(":")[0] in {n.split(":")[0] for n in names}

    def pull(self, model: str, timeout: int) -> bool:
        """Stream-pull a model; True on success."""
        url = self.base + "/api/pull"
        req = urllib.request.Request(url, data=json.dumps({"name": model, "stream": True}).encode(),
                                     method="POST", headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                for line in r:
                    try:
                        ev = json.loads(line.decode())
                    except json.JSONDecodeError:
                        continue
                    if ev.get("error"):
                        print(f"    [pull error: {ev['error']}]", flush=True)
                        return False
                    if ev.get("status") == "success":
                        return True
            return True
        except Exception as e:
            print(f"    [pull failed: {type(e).__name__}: {e}]", flush=True)
            return False

    def ensure_model(self, model: str, pull_timeout: int) -> bool:
        if self.has_model(model):
            return True
        print(f"    pulling {model} ...", flush=True)
        return self.pull(model, pull_timeout)

    # -- chat ---------------------------------------------------------------
    def chat(self, model: str, messages: list[dict[str, Any]],
             tools: list[dict[str, Any]] | None = None) -> str:
        """One chat completion; retries through server drops instead of dying."""
        body: dict[str, Any] = {"model": model, "messages": messages, "stream": False}
        if tools:
            body["tools"] = tools
        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                res = self._raw("/v1/chat/completions", body, self.chat_timeout)
                msg = (res.get("choices") or [{}])[0].get("message", {})
                content = msg.get("content") or ""
                if tools:  # native mode: surface tool_calls for the loop
                    tcs = msg.get("tool_calls") or []
                    if tcs:
                        calls = []
                        for tc in tcs:
                            fn = (tc.get("function") or {})
                            try:
                                a = json.loads(fn.get("arguments") or "{}")
                            except json.JSONDecodeError:
                                a = {"_raw": fn.get("arguments")}
                            calls.append({"tool": fn.get("name") or "?", "args": a})
                        return json.dumps({"__native_tool_calls": calls}) + ("\n" + content if content else "")
                return content
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    raise BenchError(f"model {model} not found (404)")
                last = e
            except Exception as e:  # URLError, timeout, ConnectionReset, 5xx, ...
                last = e
            if attempt < self.retries:
                print(f"    [chat error ({type(last).__name__}); waiting for server, "
                      f"retry {attempt}/{self.retries}]", flush=True)
                self.wait_healthy(str(last))
                time.sleep(2 * attempt)
        raise BenchError(f"chat failed after {self.retries} tries: {last}")


# --------------------------------------------------------------------------
# Worker loop - the real AVRONE agent-loop semantics, bench-side
# --------------------------------------------------------------------------
NUDGE = ("Your last message was not valid JSON, so no tool ran. Resend ONLY one "
         "JSON object, either {\"tool\": ..., \"args\": ...} or {\"final\": ...}. "
         "If a field holds code or multi-line text, escape every newline as \\n and "
         "every quote as \\\" so it is strict JSON. No prose, no code fences.")


def parse_native(raw: str) -> dict[str, Any] | None:
    """A native-protocol reply: embedded tool_calls marker, else an action/final."""
    if "__native_tool_calls" in raw:
        try:
            obj = json.loads(raw.splitlines()[0])
            calls = obj.get("__native_tool_calls")
            if isinstance(calls, list) and calls:
                return {"tools": calls}
        except json.JSONDecodeError:
            pass
    act = parse_action(raw)
    if act is not None:
        return act
    txt = raw.strip()
    return {"final": txt} if txt else None


def worker_loop(ollama: Ollama, model: str, prompt: str, protocol: str,
                max_steps: int = 6, max_calls: int = 4) -> dict[str, Any]:
    """Run one AVRONE-style agent loop with the real shell tool.

    Returns {turns, valid, shell_used, result}. Malformed actions are nudged
    (max 2, exactly like AVRONE), prose is accepted as the result, out-of-turns
    asks for a plain-text final. Failures become '[name failed: ...]'.
    """
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
    native = protocol == "native"
    tools = [SHELL_NATIVE_SPEC] if native else None
    turns = valid = shell_used = 0
    nudges = 0
    result = ""
    try:
        for step in range(max_steps):
            reply = ollama.chat(model, messages, tools=tools)
            turns += 1
            action = parse_native(reply) if native else parse_action(reply)
            if action is None:
                looks_like_action = ('"tool"' in reply or '"final"' in reply
                                     or re.search(r"```(?:json)?\s*\{", reply))
                if looks_like_action and nudges < 2:
                    nudges += 1
                    messages.append({"role": "assistant", "content": reply})
                    messages.append({"role": "user", "content": NUDGE})
                    continue
                result = reply.strip()  # genuine prose answer: accept it
                break
            valid += 1
            if "final" in action:
                result = str(action["final"])
                break
            if "tools" in action and "tool" not in action:
                calls = action.get("tools")
                if not isinstance(calls, list) or not calls:
                    messages.append({"role": "assistant", "content": reply})
                    messages.append({"role": "user", "content":
                                     'ERROR: "tools" must be a non-empty list of '
                                     '{"tool": ..., "args": ...} objects. Nothing ran.'})
                    continue
                dropped = max(0, len(calls) - max_calls)
                calls = calls[:max_calls]
                outs = [_one_call(c) for c in calls]
                parts = [f"TOOL RESULT [{i + 1}/{len(outs)}] ({t}):\n{o}"
                         for i, (t, o) in enumerate(outs)]
                if dropped:
                    parts.append(f"NOTE: {dropped} more call(s) were skipped (limit "
                                 f"{max_calls} per turn); send them next turn if still needed.")
                messages.append({"role": "assistant", "content": reply})
                messages.append({"role": "user", "content": "\n\n".join(parts)})
                continue
            tool, out = _one_call(action)
            messages.append({"role": "assistant", "content": reply})
            messages.append({"role": "user", "content": f"TOOL RESULT ({tool}):\n{out}"})
        else:
            messages.append({"role": "user", "content":
                             "Out of turns. Give your final result now as plain text."})
            result = ollama.chat(model, messages, tools=tools).strip()
    except BenchError as e:
        return {"turns": turns, "valid": valid, "shell_used": shell_used,
                "result": f"[worker failed: {e}]"}
    return {"turns": turns, "valid": valid, "shell_used": shell_used, "result": result}


def _one_call(call: Any) -> tuple[str, str]:
    """Execute one call against the real shell tool (unknown tools error, never crash)."""
    if not isinstance(call, dict):
        return "?", "ERROR: each call must be a {\"tool\": ..., \"args\": ...} object"
    tool = call.get("tool")
    args = call.get("args") if isinstance(call.get("args"), dict) else {}
    if tool == "shell":
        return "shell", run_shell(args)
    return str(tool), f"ERROR: unknown tool {tool}"


# --------------------------------------------------------------------------
# Stages
# --------------------------------------------------------------------------
TOOL_TASK = ("Compute the product of 1729 and 31 by actually running the shell "
             "tool, then report the product in your final result.")
TOOL_FOCUS = "Compute 1729 * 31 with the shell tool and report the exact product."
SQUAD_TASK = ("Compute the product of 1729 and 31 AND the difference 2026 - 731, "
              "verify both with the shell tool, and report both exact numbers.")
DEEP_TASK = SQUAD_TASK


def stage_actions_and_tool(ollama: Ollama, model: str, protocol: str,
                           max_steps: int) -> dict[str, Any]:
    """Stages 1+2: JSON actions every turn + real tool use with a verifiable value."""
    if protocol == "native":
        prompt = WORKER_PROMPT_NATIVE.format(name="Bench-Worker", role="solver",
                                            task=TOOL_TASK, focus=TOOL_FOCUS,
                                            tools=SHELL_DOC, steps=max_steps)
    else:
        prompt = WORKER_PROMPT.format(name="Bench-Worker", role="solver", task=TOOL_TASK,
                                      focus=TOOL_FOCUS, tools=SHELL_DOC,
                                      max_calls=4, steps=max_steps)
    r = worker_loop(ollama, model, prompt, protocol, max_steps=max_steps)
    json_pts = round(30 * (r["valid"] / r["turns"]), 1) if r["turns"] else 0
    tool_pts = (15 if r["shell_used"] else 0) + (10 if "53599" in r["result"] else 0)
    return {"pts": json_pts + tool_pts, "json_pts": json_pts,
            "turns": r["turns"], "valid": r["valid"], "shell_used": r["shell_used"],
            "final_has_value": "53599" in r["result"], "result": r["result"][:400]}


def stage_squad(ollama: Ollama, model: str, protocol: str, max_steps: int) -> dict[str, Any]:
    """Stage 3: PLAN -> 2 workers in parallel -> LEAD merge (weak-lead retry once)."""
    reply = ollama.chat(model, [{"role": "user", "content":
                                 PLANNER_PROMPT.format(n=2) + "\n\nTask: " + SQUAD_TASK}])
    subtasks = _normalize_subtasks(reply, 2)
    try:
        m = re.search(r"\{.*\}", reply, re.S)
        obj = json.loads(m.group(0)) if m else {}
        model_planned = (isinstance(obj, dict) and isinstance(obj.get("subtasks"), list)
                         and any(isinstance(s, dict) and s.get("focus") for s in obj["subtasks"]))
    except (json.JSONDecodeError, RecursionError):
        model_planned = False
    planner_pts = 10 if model_planned else 0
    tpl = WORKER_PROMPT_NATIVE if protocol == "native" else WORKER_PROMPT
    prompts = []
    for i, s in enumerate(subtasks[:2]):
        if protocol == "native":
            p = tpl.format(name=f"W{i + 1}", role=s["role"], task=SQUAD_TASK,
                           focus=s["focus"], tools=SHELL_DOC, steps=max_steps)
        else:
            p = tpl.format(name=f"W{i + 1}", role=s["role"], task=SQUAD_TASK,
                           focus=s["focus"], tools=SHELL_DOC, max_calls=4, steps=max_steps)
        prompts.append(p)
    with ThreadPoolExecutor(max_workers=2) as ex:
        reps = list(ex.map(lambda p: worker_loop(ollama, model, p, protocol,
                                                 max_steps=max_steps)["result"], prompts))
    ok = [not r.startswith("[worker failed:") and r.strip() for r in reps]
    workers_pts = 10 if len(ok) == 2 and all(ok) else (5 if any(ok) else 0)
    reports = "\n\n---\n\n".join(f"[Worker {i + 1}]\n{r}" for i, r in enumerate(reps))
    lead_msgs = [{"role": "user", "content":
                  LEAD_PROMPT + "\n\nTask: " + SQUAD_TASK +
                  "\n\nWorker reports:\n" + reports}]
    lead = ollama.chat(model, lead_msgs).strip()
    lead_pts = 15
    if _weak_lead(lead, reports):  # exactly one retry, like AVRONE
        lead_msgs.append({"role": "assistant", "content": lead})
        lead_msgs.append({"role": "user", "content":
                          "That answer narrates intent or is far thinner than the reports. "
                          "Write the finished merged answer now, no narration."})
        lead = ollama.chat(model, lead_msgs).strip()
        lead_pts = 15 if not _weak_lead(lead, reports) else 5
    merged = ("53599" in lead and "1295" in lead)
    return {"pts": planner_pts + workers_pts + lead_pts,
            "planner_pts": planner_pts, "workers_pts": workers_pts, "lead_pts": lead_pts,
            "subtasks": subtasks, "merged_values": merged, "lead": lead[:400]}


def stage_deep(ollama: Ollama, model: str, protocol: str, first_answer: str,
               max_steps: int) -> dict[str, Any]:
    """Stage 4: the recursive review wave - 2 reviewers + DEEP LEAD report."""
    prompts = []
    for i, ang in enumerate(DEEP_ANGLES[:2]):
        prompts.append(DEEP_WORKER_PROMPT.format(
            name=f"R{i + 1}", role=ang["role"], task=DEEP_TASK, focus=ang["focus"],
            tools=SHELL_DOC, steps=min(3, max_steps)))
    with ThreadPoolExecutor(max_workers=2) as ex:
        reps = list(ex.map(lambda p: worker_loop(ollama, model, p, protocol,
                                                 max_steps=min(3, max_steps))["result"], prompts))
    reports = "\n\n---\n\n".join(f"[{DEEP_ANGLES[i]['role']}]\n{r}"
                                 for i, r in enumerate(reps))
    report = ollama.chat(model, [{"role": "user", "content":
                                  DEEP_LEAD_PROMPT + "\n\nTask: " + DEEP_TASK +
                                  "\n\nFirst-wave answer:\n" + first_answer +
                                  "\n\nReviewer reports:\n" + reports}]).strip()
    sections = [t for t in ("Verdict", "Corrections", "Additions",
                            "Counterpoints", "Sources", "Bottom line")
                if _md_section(report, t)]
    conf = _lead_confidence(report)
    return {"pts": (5 if len(sections) == 6 else round(5 * len(sections) / 6, 1))
            + (5 if conf else 0),
            "sections": len(sections), "confidence": conf, "report": report[:400]}


# --------------------------------------------------------------------------
# Per-model bench + main
# --------------------------------------------------------------------------
def bench_model(ollama: Ollama, model: str, protocol: str, deep: bool,
                max_steps: int, pull_timeout: int) -> dict[str, Any]:
    t0 = time.monotonic()
    res: dict[str, Any] = {"model": model, "protocol": protocol, "available": True,
                           "score": None, "stages": {}, "error": None}
    if not ollama.ensure_model(model, pull_timeout):
        res.update(available=False, error="pull failed / model unavailable")
        return res
    ollama.wait_healthy("before model run")

    s1 = stage_actions_and_tool(ollama, model, protocol, max_steps)
    res["stages"]["actions_tool"] = s1
    s2 = stage_squad(ollama, model, protocol, max_steps)
    res["stages"]["squad"] = s2
    if deep:
        first_answer = s2.get("lead") or s1.get("result") or ""
        s3 = stage_deep(ollama, model, protocol, first_answer, max_steps)
        res["stages"]["deep"] = s3
    res["score"] = round(sum(s["pts"] for s in res["stages"].values()), 1)
    res["duration_s"] = round(time.monotonic() - t0, 1)
    return res


def write_results(path: str, results: dict[str, Any]) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def main() -> int:
    ap = argparse.ArgumentParser(description="Live AVRONE/Grok Bot model bench (no mocks)")
    ap.add_argument("--base", default=os.environ.get("BENCH_BASE") or "http://127.0.0.1:11434")
    ap.add_argument("--models", default=os.environ.get("BENCH_MODELS") or DEFAULT_MODELS,
                    help="comma-separated Ollama model tags")
    ap.add_argument("--protocol", default=os.environ.get("BENCH_PROTOCOL") or "json",
                    choices=["json", "native"])
    ap.add_argument("--out", default=os.environ.get("BENCH_OUT") or "bench_results.json")
    ap.add_argument("--health-wait", type=int,
                    default=_env_int("BENCH_HEALTH_WAIT", 300))
    ap.add_argument("--retries", type=int, default=_env_int("BENCH_RETRIES", 3))
    ap.add_argument("--chat-timeout", type=int, default=_env_int("BENCH_CHAT_TIMEOUT", 300))
    ap.add_argument("--pull-timeout", type=int, default=_env_int("BENCH_PULL_TIMEOUT", 1800))
    ap.add_argument("--max-steps", type=int, default=_env_int("BENCH_STEPS", 6))
    ap.add_argument("--no-deep", action="store_true",
                    default=os.environ.get("BENCH_DEEP", "1") == "0")
    args = ap.parse_args()

    models = [m.strip() for m in args.models.split(",") if m.strip()]
    ollama = Ollama(args.base, args.health_wait, args.retries, args.chat_timeout)
    results: dict[str, Any] = {"protocol": args.protocol, "base": args.base,
                               "started": datetime.now(timezone.utc).isoformat(),
                               "models": []}
    print(f"AVRONE live model bench | protocol={args.protocol} | models={models}")
    ollama.wait_healthy("bench start")

    for model in models:
        print(f"\n=== {model} ===", flush=True)
        try:
            r = bench_model(ollama, model, args.protocol, not args.no_deep,
                            args.max_steps, args.pull_timeout)
        except Exception as e:  # per-model isolation: never kill the bench
            r = {"model": model, "protocol": args.protocol, "available": True,
                 "score": None, "stages": {}, "error": f"{type(e).__name__}: {e}"}
        results["models"].append(r)
        write_results(args.out, results)
        if r.get("score") is not None:
            print(f"    score {r['score']}/100 in {r.get('duration_s', '?')}s "
                  f"(actions+tool {r['stages'].get('actions_tool', {}).get('pts')}, "
                  f"squad {r['stages'].get('squad', {}).get('pts')}, "
                  f"deep {r['stages'].get('deep', {}).get('pts', 0)})")
        else:
            print(f"    unavailable: {r.get('error')}")

    scored = [(m["score"], -(m.get("duration_s") or 0), m["model"])
              for m in results["models"] if m.get("score") is not None]
    print("\n" + "=" * 68)
    print(f"{'model':<18}{'score':>8}{'actions+tool':>14}{'squad':>8}{'deep':>7}{'secs':>9}")
    for m in results["models"]:
        st = m.get("stages", {})
        if m.get("score") is None:
            print(f"{m['model']:<18}{'-':>8}   ({m.get('error') or 'unavailable'})")
        else:
            print(f"{m['model']:<18}{m['score']:>8}"
                  f"{st.get('actions_tool', {}).get('pts', 0):>14}"
                  f"{st.get('squad', {}).get('pts', 0):>8}"
                  f"{st.get('deep', {}).get('pts', 0):>7}"
                  f"{m.get('duration_s', 0):>9}")
    if scored:
        scored.sort(reverse=True)
        print(f"\nWINNER: {scored[0][2]} ({scored[0][0]}/100)")
    print(f"results: {args.out}")
    return 0 if results["models"] else 1


if __name__ == "__main__":
    sys.exit(main())
