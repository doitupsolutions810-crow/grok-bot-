"""netsquad: squad mode dispatched into the node network (AVRONE_SQUAD_DISPATCH)."""
import asyncio
import json
import time

import httpx
import pytest

import avrone.fleet as fleet_mod
from avrone.codex import Codex
from avrone.config import Settings
from avrone.fleet import (FleetManager, GatewayRefused, bridge_export, bridge_merge, cap_bridge_posts,
                          kind_capabilities, sign, squad_dispatch)
from avrone.governor import Governor
from avrone.sovereign import LocalRunner
from avrone.trinity import TrinityCore

ENV = ("AVRONE_FLEET_ALLOW", "AVRONE_FLEET_REQUIRE_ALLOW", "AVRONE_FLEET_OFFLOAD", "AVRONE_SQUAD_DISPATCH",
       "AVRONE_NET_WORKER_MODE", "AVRONE_NET_SUBSQUAD", "AVRONE_NET_MAX_NODES", "AVRONE_NET_MAX_REMOTE_AGENTS",
       "AVRONE_FLEET_MAX_HOPS", "AVRONE_FLEET_PRIVILEGED", "AVRONE_PRIVILEGED_NODES")
COOL = {"state": "ok", "headroom": 1.0, "load": 0.1, "temp_c": 45.0, "active_agents": 0}
WARM = {"state": "ok", "headroom": 1.0, "load": 0.9, "temp_c": 60.0, "active_agents": 3}
HOT = {"state": "hot", "headroom": 0.1, "load": 0.5, "temp_c": 84.0, "active_agents": 0}


def run(coro):
    return asyncio.run(coro)


def add(fm, nid, health=None, net=True, age=0.0):
    caps = {"runner": "local", "tools": ["shell"]}
    if net:
        caps["squad:net"] = True
    fm.nodes[nid] = {"node_id": nid, "url": f"http://{nid}.test", "last_seen": time.time() - age, "load": 0,
                     "capabilities": caps, "children": [], "health": health or COOL}


def sensors(temp):
    return {"load": lambda: 0.2, "mem_pct": lambda: 30.0, "disk_free_pct": lambda: 60.0, "temp_c": lambda: temp}


class TrackLLM:
    def __init__(self, n):
        self.n, self.workers, self.lead_inputs = n, 0, []

    async def chat(self, messages, **kw):
        sys = messages[0]["content"]
        if "PLANNER" in sys:
            return json.dumps({"subtasks": [{"role": f"W{i}", "focus": f"focus-{i}"} for i in range(self.n)]})
        if kw.get("lead"):
            self.lead_inputs.append(messages[1]["content"])
            return "LEAD " + "x" * 400
        self.workers += 1
        await asyncio.sleep(0.005)
        return '{"final": "ok"}'


@pytest.fixture
def make(tmp_path, monkeypatch):
    monkeypatch.setenv("AVRONE_FLEET_TOKEN", "tok")
    for k in ENV:
        monkeypatch.delenv(k, raising=False)
    counter = {"i": 0}

    def _make(n=4, temp=40.0, node="root"):
        counter["i"] += 1
        monkeypatch.setenv("AVRONE_NODE_ID", node)
        s = Settings()
        base = tmp_path / f"c{counter['i']}"
        s.data_dir, s.workspace, s.max_parallel, s.governor = base / "d", base / "ws", 6, True
        llm = TrackLLM(n)
        c = TrinityCore(s, llm, LocalRunner(s), Codex(s.data_dir))
        c.governor = Governor(6, min_parallel=1, thermal_max_c=85, readers=sensors(temp), ttl_s=0)
        c.fleet = FleetManager(c, base / "fleet")
        return c, llm
    return _make


def remote(monkeypatch, handler):
    calls = []

    async def h(req):
        calls.append(json.loads(req.content))
        r = handler(req)
        return await r if asyncio.iscoroutine(r) else r
    monkeypatch.setattr(fleet_mod, "HTTP_TRANSPORT", httpx.MockTransport(h))
    return calls


def ok_handler(req):
    host = req.url.host.split(".")[0]
    return httpx.Response(200, json={"node": host, "path": [host], "answer": f"remote:{host}", "netsquad": True})


def events(core, kind):
    path = core.codex.log_dir / "fleet.jsonl"
    if not path.exists():
        return []
    return [e for e in map(json.loads, path.read_text().splitlines()) if e["kind"] == kind]


# ---------------------------------------------------------------- default / placement
def test_local_default_unchanged(make, monkeypatch):
    core, llm = make()
    add(core.fleet, "edge")
    calls = remote(monkeypatch, ok_handler)
    out = run(core.squad("task", n=4, run_id="loc"))
    assert [a["result"] for a in out["agents"]] == ["ok"] * 4 and calls == [] and llm.workers == 4
    assert all("node" not in a for a in out["agents"]) and events(core, "fleet.netsquad_place") == []
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "bogus")
    assert squad_dispatch() == "local" and core.fleet.squad_dispatch() == "local"
    run(core.squad("task", n=2, run_id="loc2"))
    assert calls == []
    core.fleet.token = ""  # fleet off: network setting is ignored
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    assert core.fleet.squad_dispatch() == "local"


def test_network_spreads_round_robin_by_score(make, monkeypatch):
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    core, llm = make(n=5)
    add(core.fleet, "warm", WARM)
    add(core.fleet, "cool", COOL)
    add(core.fleet, "hot", HOT)  # excluded by health
    add(core.fleet, "legacy", net=False)  # no squad:net capability: never placed
    calls = remote(monkeypatch, ok_handler)
    out = run(core.squad("the task", n=5, run_id="net"))
    nodes = [a.get("node") for a in out["agents"]]
    assert nodes == ["cool", "warm", "cool", "warm", "cool"] and llm.workers == 0
    assert [a["result"] for a in out["agents"]] == [f"remote:{n}" for n in nodes]
    assert out["agents"][0]["route"] == ["root", "cool"]
    assert all(c["capability"] == "squad:net" and c["mode"] == "squad" and c["n"] == 2 and c["hops"] == 1
               and c["from"] == "root" and c["origin_run"] == "net" and c["route"] == []
               and c["netsquad"]["path"] == ["root"] and "privileged" not in c for c in calls)
    assert sorted(c["prompt"].split("YOUR SUBTASK: ")[1].split("\n")[0] for c in calls) == \
        [f"focus-{i}" for i in range(5)]
    ev = events(core, "fleet.netsquad_place")
    assert len(ev) == 5 and ev[0]["data"]["squad_run"] == "net" and ev[0]["data"]["size"] == 2
    assert core.fleet.netsquad_counts == {"cool": 3, "warm": 2}
    rows = {r["node_id"]: r["netsquad"] for r in core.fleet.health_table()}
    assert rows["cool"] == 3 and rows["legacy"] == 0
    assert "[node cool via root/cool]" in llm.lead_inputs[-1]  # feeds the local Lead merge


def test_subsquad_size_and_chat_worker_mode(make, monkeypatch):
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    monkeypatch.setenv("AVRONE_NET_SUBSQUAD", "9")  # clamped to 4
    core, _ = make(n=2)
    add(core.fleet, "a")
    calls = remote(monkeypatch, ok_handler)
    run(core.squad("t", n=2, run_id="s4"))
    assert {c["n"] for c in calls} == {4}
    monkeypatch.setenv("AVRONE_NET_SUBSQUAD", "0")
    calls.clear()
    run(core.squad("t", n=2, run_id="s1"))
    assert {c["n"] for c in calls} == {1}
    monkeypatch.setenv("AVRONE_NET_SUBSQUAD", "3")
    monkeypatch.setenv("AVRONE_NET_WORKER_MODE", "chat")
    calls.clear()
    run(core.squad("t", n=2, run_id="chat"))
    assert {c["mode"] for c in calls} == {"chat"} and {c["n"] for c in calls} == {None}


def test_hybrid_local_up_to_governor_limit(make, monkeypatch):
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "hybrid")
    core, llm = make(n=4, temp=95.0)  # hot governor: 1 local slot
    add(core.fleet, "a")
    add(core.fleet, "b")
    calls = remote(monkeypatch, ok_handler)
    out = run(core.squad("t", n=4, run_id="hy"))
    assert [a["result"] for a in out["agents"]] == ["ok", "remote:a", "remote:b", "remote:a"]
    assert llm.workers == 1 and len(calls) == 3
    cool, cllm = make(n=3, temp=40.0)  # governor allows all locally: nothing leaves
    add(cool.fleet, "a")
    calls.clear()
    run(cool.squad("t", n=3, run_id="hy2"))
    assert calls == [] and cllm.workers == 3


def test_per_request_override(make, monkeypatch):
    core, llm = make(n=2)
    add(core.fleet, "a")
    calls = remote(monkeypatch, ok_handler)
    run(core.squad("t", n=2, run_id="ov", dispatch="network"))
    assert len(calls) == 2 and llm.workers == 0
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    calls.clear()
    run(core.squad("t", n=2, run_id="ov2", dispatch="local"))
    assert calls == [] and llm.workers == 2


# ---------------------------------------------------------------- caps / failover / privileged
def test_fanout_caps(make, monkeypatch):
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    monkeypatch.setenv("AVRONE_NET_MAX_NODES", "2")
    core, llm = make(n=6)
    for nid in ("a", "b", "c"):
        add(core.fleet, nid)
    calls = remote(monkeypatch, ok_handler)
    out = run(core.squad("t", n=6, run_id="cap"))
    assert {a.get("node") for a in out["agents"]} == {"a", "b"} and len(calls) == 6
    monkeypatch.setenv("AVRONE_NET_MAX_REMOTE_AGENTS", "5")  # subsquad 2 -> 2 placements fit
    calls.clear()
    out = run(core.squad("t", n=6, run_id="cap2"))
    assert len(calls) == 2 and llm.workers == 4
    assert [a.get("node") for a in out["agents"]][:2] == ["a", "b"]
    assert events(core, "fleet.netsquad_capped")[-1]["data"]["placed"] == 2
    assert {c["netsquad"]["budget"] for c in calls} == {2}
    fm = core.fleet
    assert fm.netsquad_plan(6, 0, budget=4) == {0: "a", 1: "b"}  # inherited budget caps the subtree


def test_fallback_on_error_timeout_empty(make, monkeypatch):
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    core, llm = make(n=2)
    add(core.fleet, "edge")
    calls = remote(monkeypatch, lambda r: httpx.Response(502, text="down"))
    out = run(core.squad("t", n=2, run_id="fb"))
    assert [a["result"] for a in out["agents"]] == ["ok", "ok"] and llm.workers == 2 and len(calls) == 2
    fb = events(core, "fleet.netsquad_fallback")
    assert len(fb) == 2 and "502" in fb[0]["data"]["reason"] and core.fleet.nodes["edge"]["load"] == 0
    assert all("node" not in a for a in out["agents"])

    monkeypatch.setattr(fleet_mod, "offload_timeout", lambda: 0.05)

    async def slow(req):
        await asyncio.sleep(1)
        return httpx.Response(200, json={"answer": "late"})
    remote(monkeypatch, slow)
    run(core.squad("t", n=2, run_id="to"))
    assert "TimeoutError" in events(core, "fleet.netsquad_fallback")[-1]["data"]["reason"]
    remote(monkeypatch, lambda r: httpx.Response(200, json={"answer": " "}))
    run(core.squad("t", n=2, run_id="empty"))
    assert "empty answer" in events(core, "fleet.netsquad_fallback")[-1]["data"]["reason"]


def test_privileged_stays_local(make, monkeypatch):
    from avrone.tools_extra import priv_grant
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    core, llm = make(n=2)
    add(core.fleet, "edge")
    calls = remote(monkeypatch, ok_handler)
    core.fleet_privileged = "priv:shell"
    run(core.squad("t", n=2, run_id="p1"))
    core.fleet_privileged = ""

    async def granted():
        with priv_grant("priv:admin"):
            return await core.squad("t", n=2, run_id="p2")
    run(granted())
    assert calls == [] and llm.workers == 4 and events(core, "fleet.netsquad_place") == []


def test_allowlist_and_hops_apply(make, monkeypatch):
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    core, _ = make(n=2)
    add(core.fleet, "edge")
    calls = remote(monkeypatch, ok_handler)
    core.fleet.allow = {"other"}
    run(core.squad("t", n=2, run_id="al"))
    assert calls == []
    core.fleet.allow = set()
    core.fleet_hops = core.fleet.max_hops
    run(core.squad("t", n=2, run_id="hp"))
    assert calls == []
    core.fleet_hops = 0
    # outbound gateway refuses even when a stale plan names a node
    core.fleet.allow = {"other"}
    with pytest.raises(RuntimeError, match="not in AVRONE_FLEET_ALLOW"):
        run(core.fleet.netsquad_worker("r", "edge", "W", "t", "f"))


# ---------------------------------------------------------------- recursion / cycles / capability
def signed(fm, payload, path="/api/fleet/run"):
    body = json.dumps(payload).encode()
    return body, sign(fm.token, "POST", path, body)


def netpayload(**kw):
    p = {"route": [], "mode": "squad", "prompt": "TASK: t\nYOUR SUBTASK: f", "n": 2, "hops": 1, "from": "root",
         "origin_run": "r", "capability": "squad:net", "netsquad": {"path": ["root"], "role": "W0", "budget": 8}}
    p.update(kw)
    return p


def test_capability_table_and_refusal(make, monkeypatch):
    assert "squad:net" in kind_capabilities("run") and "squad:net" not in kind_capabilities("message")
    core, _ = make(n=2, node="edge")
    fm = core.fleet
    body, h = signed(fm, netpayload())
    assert fm.dispatch_gateway("run", "POST", "/api/fleet/run", body, h)["capability"] == "squad:net"
    body, h = signed(fm, {"agent": "x", "message": "m", "from": "root", "hops": 1, "capability": "squad:net"},
                     "/api/fleet/message")
    with pytest.raises(GatewayRefused) as e:
        fm.dispatch_gateway("message", "POST", "/api/fleet/message", body, h)
    assert e.value.code == "capability"
    body, h = signed(fm, netpayload(privileged=True))
    with pytest.raises(GatewayRefused):
        fm.dispatch_gateway("run", "POST", "/api/fleet/run", body, h)
    # netsquad block without the squad:net capability, privileged, routed, or malformed: refused
    for bad in (netpayload(capability="spawn:squad"), netpayload(privileged=True), netpayload(route=["x"]),
                netpayload(netsquad={"path": []}), netpayload(netsquad={"path": ["other"]}),
                netpayload(mode="deep"), netpayload(n="many")):
        with pytest.raises(PermissionError):
            run(fm.handle_run(bad))
    assert len(events(core, "fleet.refused")) >= 7


def test_receiver_runs_subsquad_and_recurses_down(make, monkeypatch):
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    edge, llm = make(n=2, node="edge")
    add(edge.fleet, "leaf")
    add(edge.fleet, "root")  # a child that is also on the route: refused (cycle)
    calls = remote(monkeypatch, ok_handler)
    res = run(edge.fleet.handle_run(netpayload()))
    assert res["node"] == "edge" and res["netsquad"] is True and res["answer"].startswith("LEAD")
    assert len(calls) == 2 and all(c["netsquad"]["path"] == ["root", "edge"] and c["hops"] == 2 for c in calls)
    assert {c["n"] for c in calls} == {2} and {c["netsquad"]["budget"] for c in calls} == {4}
    cyc = events(edge, "fleet.cycle_refused")
    assert cyc and cyc[0]["data"]["node"] == "root"
    assert edge.fleet_hops == 0 and edge.netsquad_path is None  # restored after the run
    # at the hop limit the subtask runs on this node only
    calls.clear()
    res = run(edge.fleet.handle_run(netpayload(hops=edge.fleet.max_hops,
                                               netsquad={"path": ["a", "b", "root"], "budget": 8})))
    assert calls == [] and llm.workers == 2


def test_cycle_refused_inbound(make):
    edge, _ = make(n=2, node="edge")
    with pytest.raises(PermissionError, match="cycle refused"):
        run(edge.fleet.handle_run(netpayload(netsquad={"path": ["edge", "root"]})))
    assert events(edge, "fleet.cycle_refused")[0]["data"]["direction"] == "in"
    with pytest.raises(RuntimeError, match="cycle"):
        run(edge.fleet.netsquad_worker("r", "root", "W", "t", "f", path=["root"]))


# ---------------------------------------------------------------- bridge relay
class FakeBridge:
    def __init__(self, posts=()):
        self.posts = list(posts)
        self.merged = []
        self.since = []

    def export(self, since):
        self.since.append(since)
        return [p for p in self.posts if p.get("ts", 0) >= since]

    def merge_remote(self, posts, origin_node):
        self.merged.append((origin_node, list(posts)))


def test_bridge_caps_and_optional():
    big = [{"i": i, "body": "x" * 2000} for i in range(80)]
    out = cap_bridge_posts(big)
    assert len(json.dumps(out).encode()) <= 64 * 1024 and out[-1]["i"] == 79 and len(out) <= 50
    assert cap_bridge_posts("nope") == [] and cap_bridge_posts([1, {"a": object()}, {"ok": 1}]) == [{"ok": 1}]

    class NoBridge:
        bridge = None

    class Half:
        bridge = type("B", (), {"export": lambda self, s: [{"a": 1}]})()
    for c in (NoBridge(), Half(), object()):
        assert bridge_export(c) == [] and bridge_merge(c, [{"a": 1}], "x") == 0

    class Boom:
        def export(self, since):
            raise RuntimeError("x")

        def merge_remote(self, posts, origin):
            raise RuntimeError("y")
    c = type("C", (), {"bridge": Boom()})()
    assert bridge_export(c) == [] and bridge_merge(c, [{"a": 1}], "x") == 0


def test_bridge_relay_both_ways(make, monkeypatch):
    """Lead integration: the relay uses the run's real Bridge (avrone.bridge.for_core)."""
    from avrone import bridge as bridgemod
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    core, _ = make(n=1)
    add(core.fleet, "edge")
    bridgemod.for_core(core, "br").post("Root-1", "finding", "hello")

    def h(req):
        return httpx.Response(200, json={"node": "edge", "path": ["edge"], "answer": "done",
                                         "bridge": [{"id": "r1", "run_id": "x", "agent": "E-1",
                                                     "kind": "finding", "text": "from edge",
                                                     "ts": 2.0, "origin_node": "edge"}]})
    calls = remote(monkeypatch, h)
    run(core.squad("t", n=1, run_id="br"))
    assert [p["text"] for p in calls[0]["bridge"]] == ["hello"]
    texts = [p["text"] for p in bridgemod.for_core(core, "br").posts()]
    assert "from edge" in texts

    # receiver: merges inbound posts into net-<sender>-<origin_run>, the remote squad runs under
    # that id (its agents can read them), and only posts written on this node go back
    edge, _ = make(n=1, node="edge")
    orig = edge.squad
    seen = {}

    async def squad(prompt, n=None, run_id=None, **kw):
        seen["rid"] = run_id
        bb = bridgemod.for_core(edge, run_id)
        seen["inbound"] = [p["text"] for p in bb.posts()]
        bb.post("W-1", "conclusion", "edge says yes")
        return await orig(prompt, n, run_id=run_id, **kw)
    edge.squad = squad
    inbound = [{"id": "p1", "run_id": "r", "agent": "Root-1", "kind": "finding", "text": "hello",
                "ts": 1.0, "origin_node": "root"}]
    res = run(edge.fleet.handle_run(netpayload(n=1, bridge=inbound)))
    assert seen["rid"] == "net-root-r" and seen["inbound"] == ["hello"]
    assert [p["text"] for p in res["bridge"]] == ["edge says yes"]
    no = run(make(n=1, node="edge2")[0].fleet.handle_run(netpayload(n=1)))
    assert "bridge" not in no


# ---------------------------------------------------------------- API / CLI / doctor / telemetry
def test_api_dispatch_override_validated(monkeypatch):
    from fastapi.testclient import TestClient
    import avrone.server as server
    seen = {}

    class FakeCore:
        async def squad(self, message, n, run_id, **kw):
            seen.update(kw, message=message)
            return {"run_id": run_id, "answer": "A", "agents": []}
    monkeypatch.setattr(server, "core", lambda: FakeCore())
    c = TestClient(server.app)
    r = c.post("/api/chat", json={"message": "m", "mode": "squad", "dispatch": "network"})
    assert r.status_code == 200 and seen["dispatch"] == "network"
    seen.clear()
    assert c.post("/api/chat", json={"message": "m"}).status_code == 200 and "dispatch" not in seen
    assert c.post("/api/chat", json={"message": "m", "dispatch": "everywhere"}).status_code == 400
    assert c.post("/api/chat", json={"message": "m", "mode": "chat", "dispatch": "network"}).status_code == 400


def test_cli_dispatch_flag(monkeypatch, capsys):
    from avrone import cli
    a = cli.build_parser().parse_args(["squad", "go", "--dispatch", "hybrid"])
    assert a.dispatch == "hybrid"
    assert cli.build_parser().parse_args(["squad", "go"]).dispatch is None
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["squad", "go", "--dispatch", "mars"])
    seen = {}

    class Core:
        codex = type("X", (), {"subscribe": lambda self: asyncio.Queue()})()

        async def squad(self, prompt, n, **kw):
            seen.update(kw)
            return {"answer": "A"}

    async def build_core(settings, extras=True):
        return Core(), []
    monkeypatch.setattr(cli, "build_core", build_core)
    assert cli.main(["squad", "go", "-q", "--dispatch", "network"]) == 0 and seen == {"dispatch": "network"}
    seen.clear()
    assert cli.main(["squad", "go", "-q"]) == 0 and seen == {}


def test_doctor_warns_net_dispatch_with_open_allowlist(tmp_path):
    from types import SimpleNamespace as NS
    from avrone import doctor as d
    st = NS(provider="openclaw", llm_mode="mock", llm_base_url="http://127.0.0.1:18789/v1", llm_api_key="",
            data_dir=tmp_path / "data", workspace=tmp_path / "ws", runner="docker", allow_network=False,
            agents_can_shell=True)
    sock = tmp_path / "docker.sock"
    sock.write_text("")
    env = {"AVRONE_RECON": "deny", "AVRONE_HOST": "127.0.0.1", "AVRONE_FLEET_TOKEN": "f" * 32,
           "AVRONE_SQUAD_DISPATCH": "network"}

    def names(e):
        rep = d.run_doctor(st, env=e, which=lambda _n: "/usr/bin/docker", sockets=(str(sock),))
        return rep, {c["name"]: c for c in rep["checks"]}
    rep, n = names(env)
    assert n["security.squad_dispatch"]["status"] == "warn" and rep["toggles"]["squad_dispatch"] == "network"
    rep, n = names({**env, "AVRONE_SQUAD_DISPATCH": "hybrid"})
    assert n["security.squad_dispatch"]["status"] == "warn"
    rep, n = names({**env, "AVRONE_FLEET_ALLOW": "edge1"})
    assert "security.squad_dispatch" not in n
    rep, n = names({**env, "AVRONE_SQUAD_DISPATCH": "local"})
    assert "security.squad_dispatch" not in n
    rep, n = names({**env, "AVRONE_SQUAD_DISPATCH": "weird"})
    assert rep["toggles"]["squad_dispatch"] == "local" and "security.squad_dispatch" not in n


def test_telemetry_and_map_show_placements(make, monkeypatch):
    from avrone.telemetry import system_map, telemetry
    monkeypatch.setenv("AVRONE_SQUAD_DISPATCH", "network")
    core, _ = make(n=3)
    add(core.fleet, "a")
    add(core.fleet, "b")
    remote(monkeypatch, ok_handler)
    run(core.squad("t", n=3, run_id="tm"))
    t = telemetry(core, 3600)
    assert t["netsquad"] == {"placements": 3, "by_node": {"a": 2, "b": 1}, "fallbacks": 0}
    assert {r["node_id"]: r["netsquad"] for r in t["fleet_nodes"]} == {"a": 2, "b": 1}
    g = system_map(core, 3600)
    nodes = {n["id"]: n for n in g["nodes"]}
    assert nodes["node:a"]["netsquad"] == 2 and nodes["node:b"]["netsquad"] == 1
