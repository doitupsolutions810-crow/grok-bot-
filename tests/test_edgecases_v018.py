"""v0.18 edgecases lane: agent spawning, per-agent environments and fleet dispatch.

Each test pins one edge case: either a regression test for a bug fixed in v0.18, or an
assertion of the current (safe) behaviour where probing found no bug.
"""
import asyncio
import json
import multiprocessing as mp
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx
import pytest

from avrone import agentfs, agentpack, memstore
from avrone import fleet as fleet_mod
from avrone import tools_extra as tx
from avrone.agentfs import AgentFSError
from avrone.agentfs_tools import quota_write
from avrone.checkpoint import Checkpoint
from avrone.codex import Codex
from avrone.config import Settings
from avrone.fleet import FleetManager
from avrone.sovereign import LocalRunner
from avrone.tools import Tool, builtin_registry
from avrone.trinity import TrinityCore


def run(c):
    return asyncio.run(c)


def _fence(obj):
    return "```json\n" + json.dumps(obj) + "\n```"


def _role(messages):
    """The role an agent was spawned with, read back from its system prompt."""
    sys = messages[0]["content"]
    if "PLANNER" in sys:
        return "planner"
    if sys.startswith("You are the LEAD") or sys.startswith("You are the DEEP LEAD"):
        return "lead"
    # "You are Name-3, the <role> agent ..." / "... the <role> reviewer ..."
    return sys.split(", the ", 1)[1].split(" ", 1)[0]


class FnLLM:
    """Async LLM whose reply is fn(role, messages); yields to the loop on every call."""

    def __init__(self, fn, delay=0.01):
        self.fn, self.delay = fn, delay
        self.calls = 0

    async def chat(self, messages, **kw):
        self.calls += 1
        await asyncio.sleep(self.delay)
        return self.fn(_role(messages), messages)


def _core(tmp_path, llm, tools=None, **kw):
    s = Settings()
    s.data_dir = tmp_path / "d"
    s.workspace = tmp_path / "ws"
    s.max_steps = 6
    for k, v in kw.items():
        setattr(s, k, v)
    return TrinityCore(s, llm, LocalRunner(s), Codex(s.data_dir), tools=tools)


def _planner(*roles):
    return json.dumps({"subtasks": [{"role": r, "focus": f"focus {i}"} for i, r in enumerate(roles)]})


# =============================================================== spawn / governor / semaphore
def test_batch_spawns_max_parallel_1_depth_2_no_deadlock(tmp_path):
    """Every agent spawns two children in ONE batch, two levels deep, with a single model slot.

    Not a bug: the model semaphore is held only for the duration of one chat call (never across
    a tool call), so parents waiting on children hold no slot and the run completes."""
    def fn(role, msgs):
        if role == "planner":
            return _planner("Root", "Root2")
        if role == "lead":
            return "merged " + "x" * 400
        first = len(msgs) == 2
        if role.startswith("Root") and first:
            return _fence({"tools": [{"tool": "spawn", "args": {"role": "Mid", "task": "m"}},
                                     {"tool": "spawn", "args": {"role": "Mid", "task": "m"}}]})
        if role == "Mid" and first:
            return _fence({"tools": [{"tool": "spawn", "args": {"role": "Leaf", "task": "l"}},
                                     {"tool": "spawn", "args": {"role": "Leaf", "task": "l"}}]})
        if role == "Leaf":
            return _fence({"final": "leaf ok"})
        return _fence({"final": f"{role} ok"})

    core = _core(tmp_path, FnLLM(fn), max_parallel=1, max_spawn_depth=2, squad_size=2)
    core._worker_limit = lambda run_id, n: 1  # governor also throttles the squad to one worker
    res = run(asyncio.wait_for(core.squad("t", n=2), 20))
    assert [a["result"] for a in res["agents"]] == ["Root ok", "Root2 ok"]
    spawned = [a for a in core.active.values()]
    assert sum(a["depth"] == 2 for a in spawned) == 8  # 2 roots x 2 mids x 2 leaves
    assert all(a["status"] == "done" for a in spawned)
    assert core._sem._value == 1


def test_spawn_beyond_max_depth_refused_inside_batch(tmp_path):
    def fn(role, msgs):
        if len(msgs) == 2 and role in ("Assistant", "Kid"):
            return _fence({"tools": [{"tool": "spawn", "args": {"role": "Kid", "task": "k"}}]})
        last = msgs[-1]["content"]
        return _fence({"final": last[:200]})
    core = _core(tmp_path, FnLLM(fn), max_spawn_depth=1)
    res = run(core.chat("t"))
    # depth-1 Kid's own spawn was refused, which surfaces in its final
    assert "max sub-agent depth reached" in res["answer"]


# =============================================================== cancellation
def test_cancel_squad_mid_run_no_ghosts_and_checkpoint_clean(tmp_path):
    gate = {"n": 0}

    def fn(role, msgs):
        if role == "planner":
            return _planner("Fast", "Slow")
        if role == "Fast":
            return _fence({"final": "fast result"})
        if role == "Slow" and len(msgs) == 2:
            return _fence({"tools": [{"tool": "spawn", "args": {"role": "Child", "task": "c"}}]})
        if role == "Child":
            return _fence({"tool": "hang", "args": {}})
        return _fence({"final": "never"})

    reg = builtin_registry()

    async def hang(ctx, args):
        gate["n"] += 1
        await asyncio.sleep(3600)
        return "unreachable"
    reg.register(Tool("hang", "hang", "{}", hang))
    core = _core(tmp_path, FnLLM(fn), tools=reg)
    ck_path = tmp_path / "ck.json"

    async def main():
        t = asyncio.create_task(core.squad("t", n=2, checkpoint=ck_path))
        for _ in range(500):
            await asyncio.sleep(0.01)
            if gate["n"]:
                break
        assert gate["n"] == 1
        names = {a["role"]: n for n, a in core.active.items()}
        core.message_agent(names["Child"], "hello")  # pending inbox at cancel time
        t.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t
    run(main())
    assert core.active and all(a["status"] == "done" for a in core.active.values())
    assert core.inbox == {}
    steps = json.loads(ck_path.read_text())["steps"]
    assert steps.get("worker.0") == "fast result"
    assert "worker.1" not in steps and "result" not in steps
    # nothing is still accepting messages
    assert not any(core.message_agent(n, "x") for n in core.active)


# =============================================================== agent id collisions
def _whoami_reg():
    reg = builtin_registry()

    async def whoami(ctx, args):
        return json.dumps({"agent_id": ctx.agent_id, "dir": str(ctx.agent_dir), "ns": tx._mem_ns(ctx)})
    reg.register(Tool("whoami", "who", "{}", whoami))
    return reg


def _whoami_fn(*roles):
    def fn(role, msgs):
        if role == "planner":
            return _planner(*roles)
        if role == "lead":
            return "merged " + "x" * 400
        if len(msgs) == 2:
            return _fence({"tool": "whoami", "args": {}})
        return _fence({"final": msgs[-1]["content"].split("\n", 1)[1]})
    return fn


def test_colliding_roles_in_one_squad_get_distinct_dirs_and_memory(tmp_path):
    core = _core(tmp_path, FnLLM(_whoami_fn("Builder!", "Builder?", "builder")), tools=_whoami_reg())
    res = run(core.squad("t", n=3))
    who = [json.loads(a["result"]) for a in res["agents"]]
    ids = [w["agent_id"] for w in who]
    assert len(set(ids)) == 3, ids
    assert len({w["dir"] for w in who}) == 3
    assert len({w["ns"] for w in who}) == 3
    assert sorted(ids) == ["builder", "builder-2", "builder-3"]
    for w in who:
        assert agentfs.sanitize_agent_id(w["agent_id"]) == w["agent_id"]
        assert memstore.is_local(w["ns"])
        assert Path(w["dir"]).parent == agentfs.agents_root(tmp_path / "ws")
    # active entries carry the claimed id (fleet.idle_agents reads it to protect live homes)
    assert sorted(a["agent_id"] for a in core.active.values()) == sorted(ids)


def test_memory_namespace_collision_across_distinct_dir_ids(tmp_path):
    # "Fact-Checker" -> dir fact-checker; "FactChecker" -> dir factchecker; both names map to
    # memory namespace "factchecker" without the fix.
    core = _core(tmp_path, FnLLM(_whoami_fn("Fact-Checker", "FactChecker")), tools=_whoami_reg())
    who = [json.loads(a["result"]) for a in run(core.squad("t", n=2))["agents"]]
    assert who[0]["ns"] != who[1]["ns"]


def test_same_role_across_runs_keeps_persistence(tmp_path):
    reg = _whoami_reg()
    core = _core(tmp_path, FnLLM(_whoami_fn("Builder!")), tools=reg)
    first = json.loads(run(core.squad("t", n=1))["agents"][0]["result"])
    core2 = _core(tmp_path, FnLLM(_whoami_fn("Builder?")), tools=reg)
    second = json.loads(run(core2.squad("t", n=1))["agents"][0]["result"])
    assert first == second and first["agent_id"] == "builder" and first["ns"] == "builder"


def test_sequential_same_role_in_one_run_shares_home(tmp_path):
    """Two Helpers spawned one after the other (not concurrently) are the same persistent agent."""
    def fn(role, msgs):
        if role == "Assistant" and len(msgs) == 2:
            return _fence({"tool": "spawn", "args": {"role": "Helper", "task": "a"}})
        if role == "Assistant" and len(msgs) == 4:
            return _fence({"tool": "spawn", "args": {"role": "Helper", "task": "b"}})
        if role == "Helper" and len(msgs) == 2:
            return _fence({"tool": "whoami", "args": {}})
        if role == "Helper":
            return _fence({"final": msgs[-1]["content"].split("\n", 1)[1]})
        return _fence({"final": "done"})
    core = _core(tmp_path, FnLLM(fn), tools=_whoami_reg())
    run(core.chat("t"))
    ids = [a["agent_id"] for a in core.active.values() if a["role"] == "Helper"]
    # ctxspawn (v0.18) names a child home <parent id>-<role>; still one persistent home
    assert ids == ["assistant-helper", "assistant-helper"]


def test_explicit_agent_id_busy_home_not_migrated(tmp_path, monkeypatch):
    """fleet.idle_agents must see a working agent whose agent_id differs from its role."""
    monkeypatch.setenv("AVRONE_FLEET_TOKEN", "tok")
    seen = {}

    def fn(role, msgs):
        if len(msgs) == 2:
            return _fence({"tool": "peek", "args": {}})
        return _fence({"final": "ok"})
    reg = builtin_registry()

    async def peek(ctx, args):
        monkeypatch.setattr("avrone.agentcontainer.idle_secs", lambda: 0)
        seen["idle"] = fm.idle_agents(now=time.time() + 10_000)
        return "peeked"
    reg.register(Tool("peek", "p", "{}", peek))
    core = _core(tmp_path, FnLLM(fn), tools=reg)
    fm = FleetManager(core, tmp_path / "d")
    agentfs.agent_dir(tmp_path / "ws", "other-home")
    run(core.run_agent("r1", "Worker", "t", agent_id="custom-home"))
    assert "custom-home" not in seen["idle"]
    assert "other-home" in seen["idle"]


# =============================================================== quota races
def _ctx(tmp_path, aid="a1"):
    d = agentfs.agent_dir(tmp_path / "ws", aid)
    core = SimpleNamespace(codex=None)
    return SimpleNamespace(core=core, run_id="r", name="A-1", agent_id=aid, agent_dir=d), d


def test_quota_race_threads_never_exceed_quota(tmp_path, monkeypatch):
    monkeypatch.setenv("AVRONE_AGENT_FS_QUOTA_MB", "1")
    ctx, root = _ctx(tmp_path)
    chunk = b"x" * (300 * 1024)
    ok, refused = [], []
    barrier = threading.Barrier(8)

    def w(i):
        barrier.wait()
        try:
            quota_write(ctx, root, root / f"f{i}.bin", chunk)
            ok.append(i)
        except AgentFSError:
            refused.append(i)
    ts = [threading.Thread(target=w, args=(i,)) for i in range(8)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert len(ok) == 3 and len(refused) == 5
    from avrone.agentfs_tools import dir_usage
    assert dir_usage(root) <= 1024 * 1024
    assert not list(root.glob(".*tmp*"))


def test_quota_race_batch_fs_write_and_write_file(tmp_path, monkeypatch):
    monkeypatch.setenv("AVRONE_AGENT_FS_QUOTA_MB", "1")
    big = "y" * (400 * 1024)

    def fn(role, msgs):
        if len(msgs) == 2:
            return _fence({"tools": [{"tool": "fs_write", "args": {"path": "a", "content": big}},
                                     {"tool": "write_file", "args": {"path": "b", "content": big}},
                                     {"tool": "fs_write", "args": {"path": "c", "content": big}},
                                     {"tool": "write_file", "args": {"path": "d", "content": big}}]})
        return _fence({"final": "ok"})
    reg = builtin_registry()
    from avrone.agentfs_tools import register_agent_fs_tools, dir_usage
    register_agent_fs_tools(reg)
    core = _core(tmp_path, FnLLM(fn), tools=reg)
    run(core.run_agent("r1", "Writer", "t"))
    d = agentfs.agents_root(tmp_path / "ws") / "writer"
    assert dir_usage(d) <= 1024 * 1024
    assert len([p for p in d.iterdir() if p.is_file()]) == 2


# =============================================================== fleet routing
@pytest.fixture
def fm(tmp_path, monkeypatch):
    for k in ("AVRONE_FLEET_MAX_HOPS", "AVRONE_FLEET_ALLOW", "AVRONE_FLEET_PARENT"):
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("AVRONE_FLEET_TOKEN", "tok")
    monkeypatch.setenv("AVRONE_NODE_ID", "root")
    c = MagicMock()
    c.active = {}
    c.codex.emit = MagicMock()
    c.fleet_hops = 0
    f = FleetManager(c, tmp_path)
    c.fleet = f
    return f


def _add(fm, nid, url=None):
    fm.nodes[nid] = {"node_id": nid, "url": url or f"http://{nid}.test", "last_seen": time.time(),
                     "load": 0, "capabilities": {"runner": "local"}, "children": []}


def _transport(monkeypatch, handler):
    calls = []

    def h(req):
        calls.append(req)
        return handler(req)
    monkeypatch.setattr(fleet_mod, "HTTP_TRANSPORT", httpx.MockTransport(h))
    return calls


def _ctx_fleet(fm):
    return SimpleNamespace(core=fm.core, run_id="run1", name="Lead-1", depth=0)


def test_route_to_self_refused(fm, monkeypatch):
    calls = _transport(monkeypatch, lambda r: httpx.Response(200, json={"answer": "x"}))
    with pytest.raises(RuntimeError, match="unknown node 'root'"):
        run(fm.dispatch(["root"], "chat", "p", 0))
    with pytest.raises(ValueError, match="collides"):
        fm.register({"node_id": "root", "url": "http://x.test"})
    assert calls == []


def test_a_b_a_loop_bounded_by_hops(fm, monkeypatch):
    """A -> B -> A ... each hop increments; a node at hops == max may run locally but never forward."""
    _add(fm, "b")
    sent = []

    def h(req):
        sent.append(json.loads(req.content))
        return httpx.Response(200, json={"answer": "ok", "path": ["b"]})
    _transport(monkeypatch, h)
    m = fm.max_hops
    run(fm.dispatch(["b", "root", "b"], "chat", "p", m - 1))
    assert sent[-1]["hops"] == m and sent[-1]["route"] == ["root", "b"]
    # the receiving node now holds hops == max: forwarding is refused before any request
    with pytest.raises(PermissionError, match="max fleet hops"):
        run(fm.handle_run({"route": ["b"], "hops": m, "mode": "chat", "prompt": "p", "from": "b"}))
    assert len(sent) == 1
    with pytest.raises(PermissionError):
        run(fm.handle_run({"route": [], "hops": m + 1, "mode": "chat", "prompt": "p", "from": "b"}))


def test_hops_exactly_at_limit_runs_locally(fm):
    async def chat(prompt):
        return {"run_id": "r9", "answer": "local"}
    fm.core.chat = chat
    out = run(fm.handle_run({"route": [], "hops": fm.max_hops, "mode": "chat", "prompt": "p", "from": "b"}))
    assert out["answer"] == "local"


def test_broadcast_duplicate_targets_normalized(fm, monkeypatch):
    _add(fm, "good")
    calls = _transport(monkeypatch, lambda r: httpx.Response(200, json={"answer": "yay"}))
    out = run(fleet_mod.t_remote_broadcast(_ctx_fleet(fm), {
        "task": "t", "nodes": ["good", "good/", "/good", " good ", "good//"]}))
    assert len(calls) == 1 and out.count("## good") == 1


def test_broadcast_empty_target_never_becomes_auto(fm, monkeypatch):
    _add(fm, "good")
    calls = _transport(monkeypatch, lambda r: httpx.Response(200, json={"answer": "yay"}))
    out = run(fleet_mod.t_remote_broadcast(_ctx_fleet(fm), {"task": "t", "nodes": ["", "/", "  "]}))
    assert calls == [] and out == "ERROR: no online nodes"


# =============================================================== message_agent
def test_message_agent_finished_agent_and_counter(tmp_path):
    core = _core(tmp_path, FnLLM(lambda r, m: _fence({"final": "x"})))
    names = [core._name("Builder") for _ in range(3)]
    assert names == ["Builder-1", "Builder-2", "Builder-3"]
    core._counter = 2 ** 70  # Python ints never wrap: names keep growing, never reused
    assert core._name("Builder") == f"Builder-{2 ** 70 + 1}"
    run(core.run_agent("r", "Builder", "t"))
    done = [n for n, a in core.active.items() if a["role"] == "Builder"][0]
    assert core.message_agent(done, "late") is False and done not in core.inbox
    assert core.message_agent("nobody-1", "x") is False


def test_message_during_last_turn_is_audited_not_silently_dropped(tmp_path):
    holder = {}

    def fn(role, msgs):
        # a message lands while the agent is producing its final reply
        holder["core"].message_agent(holder["name"], "too late")
        return _fence({"final": "x"})
    core = _core(tmp_path, FnLLM(fn))
    holder["core"] = core
    holder["name"] = f"Builder-{core._counter + 1}"
    run(core.run_agent("rX", "Builder", "t"))
    kinds = [e for e in core.codex.replay("rX") if e["kind"] == "agent.message_dropped"]
    assert len(kinds) == 1 and kinds[0]["data"].get("count") == 1
    assert core.inbox == {}


# =============================================================== memstore crash safety
def _mp_writer(path, ns, n):
    st = memstore.MemoryStore(Path(path))
    for i in range(n):
        st.save(ns, f"k{i}", f"v{i}")


def test_memstore_multiprocess_writers(tmp_path):
    p = tmp_path / "memory.jsonl"
    ctx = mp.get_context("fork")
    procs = [ctx.Process(target=_mp_writer, args=(str(p), f"ns{j}", 40)) for j in range(4)]
    [x.start() for x in procs]
    [x.join(30) for x in procs]
    assert all(x.exitcode == 0 for x in procs)
    spaces = memstore.MemoryStore(p).namespaces()
    assert all(len(spaces[f"ns{j}"]) == 40 for j in range(4))
    for line in p.read_text().splitlines():
        json.loads(line)


def test_memstore_crash_mid_rewrite_keeps_old_file(tmp_path, monkeypatch):
    monkeypatch.setenv("AVRONE_MEMORY_MAX_ENTRIES", "2")
    p = tmp_path / "memory.jsonl"
    st = memstore.MemoryStore(p)
    st.save("a", "k1", "v1")
    st.save("a", "k2", "v2")
    before = p.read_text()
    real = memstore.os.replace

    def boom(*a):
        raise OSError("power cut")
    monkeypatch.setattr(memstore.os, "replace", boom)
    with pytest.raises(OSError):
        st.save("a", "k3", "v3")  # evicts -> rewrite -> crash before the swap
    monkeypatch.setattr(memstore.os, "replace", real)
    assert p.read_text() == before
    assert set(st.load("a")) == {"k1", "k2"}


def test_memstore_torn_append_does_not_eat_next_record(tmp_path):
    p = tmp_path / "memory.jsonl"
    st = memstore.MemoryStore(p)
    st.save("a", "k1", "v1")
    with p.open("a") as f:
        f.write('{"ns": "a", "key": "torn", "val')  # crash mid-append: no newline
    st.save("a", "k2", "v2")
    assert set(st.load("a")) == {"k1", "k2"}


# =============================================================== agentpack
def test_agentpack_empty_agent_roundtrip(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    agentfs.agent_dir(src / "ws", "empty")
    bundle, man = agentpack.export_pack(src / "ws", src / "d", "empty", "n1")
    assert man["files"] == [] and man["memory"]["entries"] == 0 and man["created"] == 0
    res = agentpack.import_pack(dst / "ws", dst / "d", bundle, "n2")
    assert res["files"] == 0 and res["memory"]["merged"] == 0
    assert (agentfs.agents_root(dst / "ws") / "empty").is_dir()
    # a missing (never-created) agent exports the same empty pack
    b2, _ = agentpack.export_pack(src / "ws", src / "d", "ghost", "n1")
    assert agentpack.read_pack(b2)[0]["files"] == []


def test_agentpack_zero_memory_with_files(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    d = agentfs.agent_dir(src / "ws", "bob")
    (d / "notes.txt").write_text("hi")
    bundle, man = agentpack.export_pack(src / "ws", src / "d", "bob", "n1")
    assert man["memory"]["namespaces"] == []
    res = agentpack.import_pack(dst / "ws", dst / "d", bundle, "n2")
    assert res["files"] == 1 and not (dst / "d" / "memory.jsonl").exists()


def test_agentpack_exactly_at_quota(tmp_path, monkeypatch):
    import os as _os
    monkeypatch.setenv("AVRONE_AGENT_FS_QUOTA_MB", "1")
    src, dst = tmp_path / "src", tmp_path / "dst"
    d = agentfs.agent_dir(src / "ws", "full")
    (d / "a.bin").write_bytes(_os.urandom(1024 * 1024 - 10))
    (d / "b.bin").write_bytes(_os.urandom(10))
    bundle, man = agentpack.export_pack(src / "ws", src / "d", "full", "n1")
    assert man["total_bytes"] == 1024 * 1024
    res = agentpack.import_pack(dst / "ws", dst / "d", bundle, "n2")
    assert res["files"] == 2
    (d / "c.bin").write_bytes(b"1")
    with pytest.raises(agentpack.PackError, match="over the agent-fs quota"):
        agentpack.export_pack(src / "ws", src / "d", "full", "n1")


# =============================================================== checkpoint
def test_checkpoint_unicode_and_huge_task(tmp_path):
    task = "задача 🚀 \u202e\u0000 " + "長" * 200_000 + " \ud800"
    calls = {"n": 0}

    def fn(role, msgs):
        calls["n"] += 1
        if role == "planner":
            return _planner("Uni")
        if role == "lead":
            return "結論 " + "x" * 400
        return _fence({"final": "результат ✓"})
    p = tmp_path / "ck.json"
    core = _core(tmp_path, FnLLM(fn))
    r1 = run(core.squad(task, n=1, checkpoint=p))
    json.loads(p.read_text(encoding="utf-8"))
    n = calls["n"]
    r2 = run(_core(tmp_path, FnLLM(fn)).squad(task, n=1, checkpoint=p))
    assert r2 == r1 and calls["n"] == n  # resumed from the finished result, nothing re-run


def test_checkpoint_resume_after_squad_size_change(tmp_path):
    def fn(role, msgs):
        if role == "planner":
            n = int(msgs[0]["content"].split("into ", 1)[1].split(" ", 1)[0])
            return _planner(*[f"W{i}" for i in range(n)])
        if role == "lead":
            return "merged " + "x" * 400
        return _fence({"final": f"{role} done"})
    p = tmp_path / "ck.json"
    core = _core(tmp_path, FnLLM(fn), squad_size=2)
    run(core.squad("t", checkpoint=p))
    core2 = _core(tmp_path, FnLLM(fn), squad_size=3)
    r = run(core2.squad("t", checkpoint=p))
    assert len(r["agents"]) == 3  # size changed -> fresh run, not the stale 2-worker result


def test_deep_resume_after_squad_size_change_does_not_mix_stale_reviews(tmp_path):
    """Deep without a first answer runs a first-wave squad sized by settings.squad_size. If that
    size changes before a resume, the first wave re-runs: cached reviews of the OLD first answer
    must not be reused against the new one."""
    briefs = []

    def fn(role, msgs):
        if role == "planner":
            n = int(msgs[0]["content"].split("into ", 1)[1].split(" ", 1)[0])
            return _planner(*[f"W{i}" for i in range(n)])
        if role == "lead" and "DEEP LEAD" in msgs[0]["content"]:
            return "## Verdict\nConfirmed. Confidence: High\n## Corrections\nNone\n## Bottom line\nok"
        if role == "lead":
            return f"FIRST ANSWER size={msgs[1]['content'].count('### Agent')} " + "x" * 400
        if "FIRST-WAVE ANSWER" in msgs[0]["content"]:
            briefs.append(msgs[0]["content"])
            return _fence({"final": "review of " + msgs[0]["content"].split("size=", 1)[1][:1]})
        return _fence({"final": f"{role} done"})
    p = tmp_path / "ck.json"
    core = _core(tmp_path, FnLLM(fn), squad_size=2, deep_squad_size=1)
    r1 = run(core.deep("q", checkpoint=p, rounds=1))
    assert "size=2" in r1["first_answer"] and r1["agents"][0]["result"] == "review of 2"
    # simulate a crash before the final result was stored, then resume with a bigger squad
    data = json.loads(p.read_text())
    data["steps"].pop("result")
    data["steps"].pop("rounds")
    p.write_text(json.dumps(data))
    core2 = _core(tmp_path, FnLLM(fn), squad_size=3, deep_squad_size=1)
    r2 = run(core2.deep("q", checkpoint=p, rounds=1))
    assert "size=3" in r2["first_answer"]
    assert r2["agents"][0]["result"] == "review of 3"


def test_checkpoint_never_marks_failed_step_done(tmp_path):
    ck = Checkpoint(tmp_path / "c.json")

    def fn(role, msgs):
        raise RuntimeError("model down")
    core = _core(tmp_path, FnLLM(fn))

    async def failing():
        return "[X-1 failed: boom]"
    assert run(core._ck_step(ck, "worker.0", failing)).startswith("[X-1 failed")
    assert ck.get("worker.0") is None
