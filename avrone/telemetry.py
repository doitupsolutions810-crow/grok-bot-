"""Telemetry + System Map: AVRONE traces its own nodes.

Nodes are the parts of AVRONE itself: the core, the model providers, the
runner (environment), every tool (builtin, plugin, MCP server) and every agent
that has run. Edges are the calls that flowed between them, built from the
Eternal CodeX event logs. Nothing here probes external networks.
"""
from __future__ import annotations

import json
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .trinity import TrinityCore


def _iter_events(log_dir: Path, since: float, max_files: int = 200):
    files = sorted(log_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)[:max_files]
    for p in files:
        if p.stat().st_mtime < since:
            continue
        for line in p.read_text().splitlines():
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("ts", 0) >= since:
                yield ev


def telemetry(core: "TrinityCore", window_s: float = 86400) -> dict[str, Any]:
    """Aggregate metrics over the last window_s seconds."""
    since = time.time() - window_s
    runs: dict[str, dict[str, Any]] = {}
    tool_calls: Counter[str] = Counter()
    tool_errors: Counter[str] = Counter()
    agent_roles: Counter[str] = Counter()
    errors = 0
    pending_calls: dict[tuple[str, str], tuple[str, float]] = {}
    tool_latency: dict[str, list[float]] = defaultdict(list)
    throttles: list[dict[str, Any]] = []
    resumes = 0
    net_place: Counter[str] = Counter()
    net_fallback = 0

    for ev in _iter_events(core.codex.log_dir, since):
        rid, kind, agent, data, ts = ev.get("run_id"), ev.get("kind"), ev.get("agent", ""), ev.get("data", {}), ev.get("ts", 0)
        if kind == "run.start":
            runs[rid] = {"run_id": rid, "mode": data.get("mode"), "start": ts, "end": None,
                         "prompt": str(data.get("prompt", ""))[:120]}
        elif kind == "run.done" and rid in runs:
            runs[rid]["end"] = ts
        elif kind == "agent.spawn":
            agent_roles[str(data.get("role", "?"))] += 1
        elif kind == "tool.call":
            tool = str(data.get("tool"))
            tool_calls[tool] += 1
            pending_calls[(rid, agent)] = (tool, ts)
        elif kind == "tool.result":
            tool = str(data.get("tool"))
            if str(data.get("output", "")).startswith("ERROR"):
                tool_errors[tool] += 1
            started = pending_calls.pop((rid, agent), None)
            if started and started[0] == tool:
                tool_latency[tool].append(ts - started[1])
        elif kind == "error":
            errors += 1
        elif kind == "governor.throttle":
            throttles.append({"run_id": rid, "ts": ts, "workers": data.get("workers"),
                              "parallel": data.get("parallel"), "reason": data.get("reason")})
        elif kind == "checkpoint.resume":
            resumes += 1
        elif kind == "fleet.netsquad_place":
            net_place[str(data.get("node", "?"))] += 1
        elif kind == "fleet.netsquad_fallback":
            net_fallback += 1

    done = [r for r in runs.values() if r["end"]]
    durations = sorted(r["end"] - r["start"] for r in done)

    def pct(xs: list[float], p: float) -> float | None:
        return round(xs[min(len(xs) - 1, int(p * len(xs)))], 2) if xs else None

    return {
        "window_s": window_s,
        "runs": {"total": len(runs), "completed": len(done), "running": len(runs) - len(done),
                 "by_mode": dict(Counter(r["mode"] for r in runs.values())),
                 "p50_s": pct(durations, 0.5), "p95_s": pct(durations, 0.95)},
        "agents": {"spawned": sum(agent_roles.values()), "by_role": dict(agent_roles.most_common(20)),
                   "active_now": [n for n, a in core.active.items() if a.get("status") == "working"]},
        "tools": {t: {"calls": c, "errors": tool_errors.get(t, 0),
                      "avg_s": round(sum(tool_latency[t]) / len(tool_latency[t]), 2) if tool_latency[t] else None}
                  for t, c in tool_calls.most_common()},
        "errors": errors,
        "recent_runs": sorted(runs.values(), key=lambda r: r["start"], reverse=True)[:10],
        "node": node_health(core),
        "fleet_nodes": fleet_health(core),
        "netsquad": {"placements": sum(net_place.values()), "by_node": dict(net_place.most_common()),
                     "fallbacks": net_fallback},
        "resilience": {"throttles": len(throttles), "checkpoint_resumes": resumes,
                       "recent_throttles": sorted(throttles, key=lambda t: t["ts"], reverse=True)[:5]},
    }


def node_health(core: "TrinityCore") -> dict[str, Any]:
    """Governor state + this node's health (load, memory, disk, temperature). Never raises."""
    try:
        gov = getattr(core, "governor", None)
        if gov is None:
            from .governor import Governor
            gov = Governor.from_settings(core.settings)
        return gov.state()
    except Exception as e:
        return {"enabled": False, "error": f"{type(e).__name__}: {e}"[:200]}


def fleet_health(core: "TrinityCore") -> list[dict[str, Any]]:
    """Health of each fleet child (status, governor state, routing score, eligibility). Never raises."""
    try:
        fleet = getattr(core, "fleet", None)
        if fleet is None or not getattr(fleet, "enabled", False):
            return []
        rows = fleet.health_table()
        return rows if isinstance(rows, list) else []
    except Exception:
        return []


def system_map(core: "TrinityCore", window_s: float = 86400) -> dict[str, Any]:
    """Graph of AVRONE's own nodes and the traffic between them."""
    s = core.settings
    nodes: dict[str, dict[str, Any]] = {}
    edges: Counter[tuple[str, str]] = Counter()

    def node(nid: str, kind: str, label: str, **meta: Any) -> None:
        nodes.setdefault(nid, {"id": nid, "kind": kind, "label": label, **meta})

    node("core", "core", "Trinity Core")
    node("codex", "store", "Eternal CodeX", path=str(core.codex.log_dir))
    node("runner", "runner", f"Sovereign OS ({core.runner.kind})", workspace=str(core.runner.workspace))
    model = getattr(s, "llm_model", "?")
    node("model:worker", "model", f"Worker model: {model}", base_url=getattr(s, "llm_base_url", ""))
    lead = getattr(s, "lead_model", "") or model
    node("model:lead", "model", f"Lead model: {lead}")
    edges[("core", "codex")] += 1
    edges[("core", "runner")] += 1

    sources: dict[str, str] = {}
    for t in core.tools.list():
        src = t["source"]
        sources[t["name"]] = src
        group = "tools:builtin" if src == "builtin" else f"tools:{src}"
        node(group, "toolgroup", src if src != "builtin" else "Built-in tools")
        node(f"tool:{t['name']}", "tool", t["name"], source=src)
        edges[(group, f"tool:{t['name']}")] += 0
        edges[("core", group)] += 0

    fleet = getattr(core, "fleet", None)
    if fleet is not None and fleet.enabled:
        node("fleet", "fleet", f"Fleet node: {fleet.node_id}")
        edges[("core", "fleet")] += 0
        if fleet.parent:
            node("fleet:parent", "node", f"Parent: {fleet.parent}")
            edges[("fleet", "fleet:parent")] += 1
        from .presence import flatten

        for n in fleet.list_nodes():
            hs = fleet.node_state(n) if hasattr(fleet, "node_state") else "unknown"
            hs = hs if isinstance(hs, str) else "unknown"
            label = f"{n['node_id']} ({n['status']}" + (f", {hs})" if hs not in ("unknown",) else ")")
            node(f"node:{n['node_id']}", "node", label, url=n["url"])
            edges[("fleet", f"node:{n['node_id']}")] += 1
            pres = n.get("presence") or {"node_id": n["node_id"], "children": {}, "agents": []}
            for row in flatten(pres):
                nid = row["node_id"]
                node(f"node:{nid}", "node", nid)
                parent_route = row["route"].rsplit("/", 1)[0] if "/" in row["route"] else ""
                if row["route"]:
                    parent = parent_route.rsplit("/", 1)[-1] if parent_route else n["node_id"]
                    edges[(f"node:{parent}", f"node:{nid}")] += 1
                for a in row["agents"]:
                    if a.get("status") == "working":
                        node(f"ragent:{nid}/{a['name']}", "agent", f"{a['name']}@{nid}")
                        edges[(f"node:{nid}", f"ragent:{nid}/{a['name']}")] += 1

    since = time.time() - window_s
    for ev in _iter_events(core.codex.log_dir, since):
        kind, agent, data = ev.get("kind"), ev.get("agent", ""), ev.get("data", {})
        if kind == "agent.spawn":
            role = str(data.get("role", "Agent"))
            node(f"role:{role}", "agent", role)
            parent = data.get("parent")
            edges[(f"role:{parent.rsplit('-', 1)[0]}" if parent else "core", f"role:{role}")] += 1
            edges[(f"role:{role}", "model:worker")] += 1
        elif kind == "tool.call":
            tool = str(data.get("tool"))
            role = agent.rsplit("-", 1)[0]
            node(f"role:{role}", "agent", role)
            node(f"tool:{tool}", "tool", tool, source=sources.get(tool, "unknown"))
            edges[(f"role:{role}", f"tool:{tool}")] += 1
            if tool in ("shell", "python", "git", "docker_run"):
                edges[(f"tool:{tool}", "runner")] += 1
        elif kind == "lead.merge":
            edges[("core", "model:lead")] += 1
        elif kind == "fleet.netsquad_place":  # a squad subtask placed on a remote node (netsquad)
            nid = str(data.get("node", "?"))
            node(f"node:{nid}", "node", nid)
            nodes[f"node:{nid}"]["netsquad"] = nodes[f"node:{nid}"].get("netsquad", 0) + 1
            edges[("fleet" if "fleet" in nodes else "core", f"node:{nid}")] += 1

    # fix parent edges that point at an unknown role node
    out_edges = []
    for (a, b), w in edges.items():
        if a not in nodes:
            node(a, "agent", a.split(":", 1)[-1])
        out_edges.append({"from": a, "to": b, "weight": w})
    return {"nodes": list(nodes.values()), "edges": out_edges}


def to_mermaid(graph: dict[str, Any], min_weight: int = 0) -> str:
    """Render the system map as a Mermaid flowchart (paste into GitHub/markdown)."""
    def mid(x: str) -> str:
        return "n_" + "".join(c if c.isalnum() else "_" for c in x)
    lines = ["flowchart LR"]
    for n in graph["nodes"]:
        label = n["label"].replace('"', "'")
        lines.append(f'  {mid(n["id"])}["{label}"]')
    for e in graph["edges"]:
        if e["weight"] >= min_weight:
            w = f"|{e['weight']}|" if e["weight"] else ""
            lines.append(f"  {mid(e['from'])} -->{w} {mid(e['to'])}")
    return "\n".join(lines)
