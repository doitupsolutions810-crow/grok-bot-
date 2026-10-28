"""Fleet: link AVRONE servers into a network of nodes that spawn agents on each other.

Every AVRONE server can be a node, a router (a node with children), or both.
  - A node joins a parent with AVRONE_FLEET_PARENT=https://parent:8000 and keeps a heartbeat.
  - Agents get tools to list nodes and spawn squads/chats/deep runs on a remote node.
  - The remote node's agents have the same tools, so they spawn and link further down.
  - Routing: a target like "router1/edge7" is forwarded hop by hop through router1.

Security (required, no token = fleet off):
  AVRONE_FLEET_TOKEN   shared secret. Every fleet request is HMAC-SHA256 signed over
                       method, path, timestamp, nonce and body hash; 60 s window; nonces
                       are remembered so a captured request can't be replayed.
  AVRONE_FLEET_MAX_HOPS  loop/recursion guard across the fleet (default 3)
  AVRONE_FLEET_ALLOW     optional comma list of node ids this server will accept / spawn on
  AVRONE_FLEET_REQUIRE_ALLOW  when truthy (1/true/yes/on), an EMPTY allowlist means refuse-all
                       instead of allow-all (default off, for backward compatibility)

Dispatch gateway: every inbound remote spawn (/api/fleet/run) and message (/api/fleet/message)
goes through FleetManager.dispatch_gateway(), which enforces, in this order:
  1 FLEET_TOKEN present   2 HMAC valid   3 timestamp in window   4 nonce not replayed
  5 sender in FLEET_ALLOW 6 hops within MAX_HOPS   7 per-request capability check
and records every accept as a Codex `fleet.dispatch` event and every refusal as `fleet.refused`.
Outbound spawns (dispatch / remote_spawn / queue_submit) run the matching local checks first.
Memory sync: POST /api/fleet/memory carries an agent's/node's memory entries UP to the parent. It goes
through the same dispatch_gateway (kind "memory", capability "memory:sync", all seven steps); the
receiver files them under "fleet:<sender>/<ns>" where <sender> is the HMAC-signed `from` node id, so
a push can never overwrite the receiver's own (local) namespaces. Accepts are audited as
`fleet.memory.merge`. Caps: MEMORY_SYNC_MAX_ENTRIES per push plus the store's per-namespace caps.
Agent migration (edgepack): POST /api/fleet/agentpack carries one agent's HOME (its dir + memory
namespace, an avrone.agentpack bundle) to a peer. Same dispatch_gateway (kind "agentpack", capability
"agent:migrate"), plus: the sender MUST be listed in a non-empty AVRONE_FLEET_ALLOW (an open allowlist
refuses), the privileged flag is always refused, and the receiver must itself run AVRONE_AGENT_MIGRATE=on.
The pack's origin must equal the signed sender; import verifies hashes/paths/quota and never overwrites
another agent's home. FleetManager.migrate_agent() sends one; thermal_migrate() moves idle agents off a hot
node (governor temp over AVRONE_THERMAL_MAX_C). Audited as agent.migrate / agent.migrate_refused /
agent.migrate_failed; on any failure the agent stays put.
Privileged ("root-enabled") tier -- OFF by default, deny by default:
  AVRONE_FLEET_PRIVILEGED      must be exactly "allow" (case-insensitive) to enable; anything else = deny
  AVRONE_PRIVILEGED_NODES      comma list of SENDER node ids this node grants elevated capabilities to
                               (default empty = nobody, even with the toggle on)
  AVRONE_FLEET_PRIVILEGED_MAX_HOPS  privileged requests are accepted only within this many hops
                               (default 1 = direct parent->child only; never above AVRONE_FLEET_MAX_HOPS)
A request asks for an elevated capability (priv:shell / priv:admin) with "privileged": true AND that
capability INSIDE the HMAC-signed JSON body, so neither can be added or flipped in transit; an
x-avrone-privileged header is refused outright. The receiving node accepts it only when its toggle is
on AND the sender is in its AVRONE_PRIVILEGED_NODES (and in FLEET_ALLOW, and within the hop bounds);
otherwise it refuses with a `fleet.privileged.refused` audit event. Accepted privileged runs are
audited as `fleet.privileged.accept` and run with core.fleet_privileged set to the granted capability
AND the run-scoped tools_extra.PRIV_GRANT context set to it; the priv_shell / priv_admin tools require
both to agree (so a concurrent unrelated run never inherits it). The originating node also needs its
own toggle on to send one.
The sender id is asserted inside the HMAC-signed body: it is tamper-proof in transit, but any
holder of the shared token can claim any id, so the allowlist limits blast radius, not trust.
Other env:
  AVRONE_NODE_ID        stable id for this server (default: hostname-derived, persisted)
  AVRONE_PUBLIC_URL     URL others use to reach this node (sent when registering)
  AVRONE_FLEET_PARENT   parent/router to join
  AVRONE_FLEET_HEARTBEAT seconds between heartbeats (default 15)
Governor-aware routing (edgeroute):
  Every registration/heartbeat carries a compact `health` block from the sender's governor
  (load ratio, mem %, disk free %, cpu temp, headroom, throttle state, active agents). The
  receiver sanitizes it and stores it on the node record; it is only trusted while the node is
  "online" (same ageing as status). select_nodes(k, need) ranks online, allowlisted children by
  health_score() (cool/idle first, deterministic tiebreak) and drops hot/throttled ones;
  pick("auto") uses it.
  AVRONE_FLEET_OFFLOAD  off|spill|spread (default off). When the local governor caps a squad below
                       its size, the overflow workers are sent (signed dispatch, mode chat, the worker's
                       focus) to the best healthy child (spill) or round-robin across the healthy children
                       (spread). A remote failure/timeout (AVRONE_FLEET_OFFLOAD_TIMEOUT, default 300 s) runs
                       that worker locally instead. Privileged runs are never offloaded; hops, allowlist and
                       the outbound gateway checks all apply. Audited as fleet.offload / fleet.offload_fallback.
netsquad (squad mode dispatched into the node network):
  AVRONE_SQUAD_DISPATCH  local|network|hybrid (default local = unchanged). network places EVERY squad
                       subtask on a node from select_nodes (healthy, allowlisted, advertising capability
                       squad:net), round-robin by score; hybrid keeps the governor's local limit here and
                       places the rest. Each placement runs on that node as a sub-squad of the same subtask
                       (AVRONE_NET_SUBSQUAD, default 2, max 4; AVRONE_NET_WORKER_MODE=chat runs one agent).
                       The receiving node may place further down its own children while hops < MAX_HOPS,
                       never back to a node already on the route (fleet.cycle_refused). Caps:
                       AVRONE_NET_MAX_NODES (8) per squad, AVRONE_NET_MAX_REMOTE_AGENTS (32) per run (the
                       budget rides down the tree). Remote error/timeout/empty answer runs that subtask
                       locally (fleet.netsquad_fallback). Privileged runs never leave the node; the
                       outbound gateway checks and allowlist always apply. Placements are audited as
                       fleet.netsquad_place and counted per node. An optional core.bridge (export(since),
                       merge_remote(posts, origin_node)) relays bridge posts both ways (50 posts / 64 KB).
Run nodes over HTTPS or a private mesh (Tailscale/WireGuard); the HMAC protects
integrity and auth, not confidentiality.
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import socket
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from .tools import Tool
from .tools_extra import priv_grant
from .checkpoint import CheckpointError, check_compatible, fleet_key, managed_path, stamp_owner
from .checkpoint import claim as ckpt_claim
from .checkpoint import sanitize_id as sanitize_ckpt_id
from .trinity import clamp_deep_rounds

if TYPE_CHECKING:
    from .trinity import AgentContext, TrinityCore

log = logging.getLogger("avrone.fleet")
ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
WINDOW_S = 60

# Tests may set this to an httpx transport (e.g. ASGITransport routing to in-process apps).
HTTP_TRANSPORT: httpx.AsyncBaseTransport | None = None


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


TRUTHY = {"1", "true", "yes", "on"}
# capability a request may ask for, per endpoint kind
CAPABILITIES: dict[str, set[str]] = {"run": {"spawn:squad", "spawn:chat", "spawn:deep"}, "message": {"message"}}
SPAWN_MODES = ("squad", "chat", "deep")
# elevated capabilities: only on the run endpoint, only through the privileged gate
PRIVILEGED_CAPABILITIES = {"priv:shell", "priv:admin"}
PRIVILEGED_HEADER = "x-avrone-privileged"
# non-spawn capabilities, kept apart from the (minimal) spawn/message table above
SYNC_CAPABILITIES: dict[str, set[str]] = {"memory": {"memory:sync"}, "agentpack": {"agent:migrate"}}
# netsquad: a squad subtask placed on this node (runs as a sub-squad/chat here, may recurse further down)
NET_CAPABILITIES: dict[str, set[str]] = {"run": {"squad:net"}}
NETSQUAD_CAP = "squad:net"
MEMORY_PATH = "/api/fleet/memory"
MEMORY_SYNC_MAX_ENTRIES = 200
AGENTPACK_PATH = "/api/fleet/agentpack"
DEFAULT_MIGRATE_INTERVAL_S, MIN_MIGRATE_INTERVAL_S = 60.0, 10.0


def migrate_enabled() -> bool:
    """AVRONE_AGENT_MIGRATE=on (default off): send/accept agent homes between nodes."""
    return _env("AVRONE_AGENT_MIGRATE").lower() in TRUTHY


def migrate_interval() -> float:
    try:
        v = float(_env("AVRONE_AGENT_MIGRATE_INTERVAL") or DEFAULT_MIGRATE_INTERVAL_S)
    except ValueError:
        v = DEFAULT_MIGRATE_INTERVAL_S
    return max(MIN_MIGRATE_INTERVAL_S, v if v == v else DEFAULT_MIGRATE_INTERVAL_S)


# ------------------------------------------------------------ health (edgeroute)
HEALTH_STATES = ("ok", "throttled", "hot")
EXCLUDED_STATES = {"throttled", "hot"}
HOT_HEADROOM = 0.25  # min governor factor at/below which a node counts as hot
_HEALTH_NUM = {"load": (0.0, 1000.0), "mem_pct": (0.0, 100.0), "disk_free_pct": (0.0, 100.0),
               "temp_c": (-40.0, 150.0), "headroom": (0.0, 1.0)}


OFFLOAD_MODES = ("off", "spill", "spread")


def offload_mode() -> str:
    v = _env("AVRONE_FLEET_OFFLOAD", "off").lower()
    return v if v in OFFLOAD_MODES else "off"


def offload_timeout() -> float:
    try:
        t = float(_env("AVRONE_FLEET_OFFLOAD_TIMEOUT", "300") or 300)
    except ValueError:
        t = 300.0
    return max(5.0, min(t, 900.0))


# ------------------------------------------------------------ netsquad (squad -> node network)
SQUAD_DISPATCH_MODES = ("local", "network", "hybrid")
NET_WORKER_MODES = ("squad", "chat")
NET_SUBSQUAD_MAX = 4
BRIDGE_MAX_POSTS, BRIDGE_MAX_BYTES = 50, 64 * 1024


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(_env(name, str(default)) or default)
    except ValueError:
        v = default
    return max(lo, min(v, hi))


def squad_dispatch(override: str | None = None) -> str:
    """AVRONE_SQUAD_DISPATCH=local|network|hybrid (default local); a valid per-request override wins."""
    if override in SQUAD_DISPATCH_MODES:
        return str(override)
    v = _env("AVRONE_SQUAD_DISPATCH", "local").lower()
    return v if v in SQUAD_DISPATCH_MODES else "local"


def net_worker_mode() -> str:
    v = _env("AVRONE_NET_WORKER_MODE", "squad").lower()
    return v if v in NET_WORKER_MODES else "squad"


def net_subsquad() -> int:
    return _env_int("AVRONE_NET_SUBSQUAD", 2, 1, NET_SUBSQUAD_MAX)


def net_max_nodes() -> int:
    return _env_int("AVRONE_NET_MAX_NODES", 8, 1, 64)


def net_max_remote_agents() -> int:
    return _env_int("AVRONE_NET_MAX_REMOTE_AGENTS", 32, 1, 1024)


def cap_bridge_posts(posts: Any) -> list[dict[str, Any]]:
    """Newest-last list of JSON-able dict posts, at most BRIDGE_MAX_POSTS and BRIDGE_MAX_BYTES."""
    if not isinstance(posts, (list, tuple)):
        return []
    out = []
    for p in list(posts)[-BRIDGE_MAX_POSTS:]:
        if not isinstance(p, dict):
            continue
        try:
            json.dumps(p)
        except (TypeError, ValueError):
            continue
        out.append(p)
    while out and len(json.dumps(out).encode()) > BRIDGE_MAX_BYTES:
        out.pop(0)  # drop the oldest first
    return out


def bridge_of(core: Any, run_id: Any = None) -> Any:
    """The run's Bridge (avrone.bridge.for_core) when run_id is given and the bridge module is
    available, else core.bridge when it offers export + merge_remote, else None (optional)."""
    if run_id:
        try:
            from . import bridge as bridgemod
            return bridgemod.for_core(core, str(run_id))
        except Exception as e:  # noqa: BLE001  -- the relay is best-effort
            log.debug("run bridge unavailable: %s", e)
    b = getattr(core, "bridge", None)
    if b is None or not callable(getattr(b, "export", None)) or not callable(getattr(b, "merge_remote", None)):
        return None
    return b


def bridge_export(core: Any, since: Any = None, run_id: Any = None,
                  only_origin: str | None = None) -> list[dict[str, Any]]:
    b = bridge_of(core, run_id)
    if b is None:
        return []
    try:
        posts = b.export(since)
        if only_origin is not None:  # send back only what this node's agents wrote
            posts = [p for p in posts if isinstance(p, dict) and p.get("origin_node") == only_origin]
        return cap_bridge_posts(posts)
    except Exception as e:  # noqa: BLE001  -- the relay is best-effort
        log.debug("bridge export failed: %s", e)
        return []


def bridge_merge(core: Any, posts: Any, origin: str, run_id: Any = None) -> int:
    b = bridge_of(core, run_id)
    posts = cap_bridge_posts(posts)
    if b is None or not posts:
        return 0
    try:
        b.merge_remote(posts, origin)
        return len(posts)
    except Exception as e:  # noqa: BLE001
        log.debug("bridge merge from %s failed: %s", origin, e)
        return 0


def local_health(core: Any) -> dict[str, Any] | None:
    """Compact health block from this node's governor, for heartbeats. Never raises; None if unknown."""
    from .governor import Governor
    gov = getattr(core, "governor", None)
    if not isinstance(gov, Governor):
        return None
    try:
        h = gov.read()
        fs = gov.factors(h)
        headroom = min(fs.values()) if fs else 1.0
        hot = headroom <= HOT_HEADROOM or (h.temp_c is not None and h.temp_c >= gov.thermal_max_c)
        state = "hot" if hot else ("throttled" if headroom < 1.0 else "ok")
        active = sum(1 for a in dict(getattr(core, "active", {}) or {}).values()
                     if isinstance(a, dict) and a.get("status") == "working")
        out: dict[str, Any] = {"state": state, "headroom": round(headroom, 3), "active_agents": active}
        for k in ("load", "mem_pct", "disk_free_pct", "temp_c"):
            v = getattr(h, k)
            if v is not None:
                out[k] = round(float(v), 2)
        return out
    except Exception as e:  # noqa: BLE001  -- health is advisory
        log.debug("local health unavailable: %s", e)
        return None


def sanitize_health(raw: Any) -> dict[str, Any] | None:
    """Keep only well-typed, range-clamped fields of a peer's health block (it is peer-asserted)."""
    if not isinstance(raw, dict):
        return None
    out: dict[str, Any] = {}
    for k, (lo, hi) in _HEALTH_NUM.items():
        v = raw.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
            continue
        out[k] = max(lo, min(hi, float(v)))
    st = raw.get("state")
    if st in HEALTH_STATES:
        out["state"] = st
    aa = raw.get("active_agents")
    if isinstance(aa, int) and not isinstance(aa, bool):
        out["active_agents"] = max(0, min(aa, 10_000))
    return out or None


def health_score(n: dict[str, Any]) -> float:
    """0..100, higher = better target. Unknown health is neutral, never best.

      60 * headroom (governor min factor; unknown 0.5)
    + 20 * (1 - min(load ratio, 2) / 2)            (unknown load ratio = 1.0)
    + 20 * (1 - min(busy, 10) / 10)  where busy = max(in-flight load, active agents)
    """
    h = n.get("health") if isinstance(n.get("health"), dict) else {}
    headroom = float(h.get("headroom", 0.5))
    ratio = float(h.get("load", 1.0))
    try:
        busy = max(float(n.get("load", 0) or 0), float(h.get("active_agents", 0) or 0))
    except (TypeError, ValueError):
        busy = 10.0
    return round(60 * headroom + 20 * (1 - min(max(ratio, 0.0), 2.0) / 2) + 20 * (1 - min(max(busy, 0.0), 10.0) / 10), 3)


def node_has(n: dict[str, Any], need: str | None) -> bool:
    """Capability match: spawn:* (every node), a tool name, the runner kind or a truthy capability key."""
    if not need or need.startswith("spawn:"):
        return True
    caps = n.get("capabilities") if isinstance(n.get("capabilities"), dict) else {}
    tools = caps.get("tools") if isinstance(caps.get("tools"), list) else []
    return need in tools or caps.get("runner") == need or bool(caps.get(need)) and need not in ("tools", "runner")


def kind_capabilities(kind: str) -> set[str]:
    return set(CAPABILITIES.get(kind) or SYNC_CAPABILITIES.get(kind) or set()) | NET_CAPABILITIES.get(kind, set())


class GatewayRefused(PermissionError):
    """A fleet request refused by the dispatch gateway. `code` is a stable machine-readable reason;
    `auth` is True for authentication failures (HTTP 401) and False for policy refusals (HTTP 403)."""

    AUTH_CODES = {"no_token", "bad_timestamp", "bad_signature", "stale", "replay", "privileged_unsigned"}

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

    @property
    def auth(self) -> bool:
        return self.code in self.AUTH_CODES


def sender_node(frm: Any) -> str:
    """Node id part of a `from` field ("node" or "node/agent")."""
    return str(frm or "").split("/", 1)[0].strip()


def request_capability(kind: str, payload: dict[str, Any]) -> str:
    if payload.get("capability") not in (None, ""):
        return str(payload["capability"])
    if kind == "run":
        return f"spawn:{payload.get('mode', 'squad')}"
    return kind


def sign(token: str, method: str, path: str, body: bytes, ts: str | None = None, nonce: str | None = None) -> dict[str, str]:
    ts = ts or str(int(time.time()))
    nonce = nonce or secrets.token_hex(12)
    msg = "\n".join([method.upper(), path, ts, nonce, hashlib.sha256(body).hexdigest()]).encode()
    sig = hmac.new(token.encode(), msg, hashlib.sha256).hexdigest()
    return {"x-avrone-ts": ts, "x-avrone-nonce": nonce, "x-avrone-sig": sig}


class FleetManager:
    def __init__(self, core: "TrinityCore", data_dir: Path):
        self.core = core
        self.token = _env("AVRONE_FLEET_TOKEN")
        self.max_hops = int(_env("AVRONE_FLEET_MAX_HOPS", "3") or 3)
        self.allow = {a.strip() for a in _env("AVRONE_FLEET_ALLOW").split(",") if a.strip()}
        self.require_allow = _env("AVRONE_FLEET_REQUIRE_ALLOW").lower() in TRUTHY
        self.privileged = _env("AVRONE_FLEET_PRIVILEGED").lower() == "allow"  # deny unless exactly "allow"
        self.privileged_nodes = {a.strip() for a in _env("AVRONE_PRIVILEGED_NODES").split(",") if a.strip()}
        try:
            ph = int(_env("AVRONE_FLEET_PRIVILEGED_MAX_HOPS", "1") or 1)
        except ValueError:
            ph = 1
        self.privileged_max_hops = max(1, min(ph, self.max_hops))
        self.parent = _env("AVRONE_FLEET_PARENT").rstrip("/")
        self.public_url = _env("AVRONE_PUBLIC_URL").rstrip("/")
        self.heartbeat_s = float(_env("AVRONE_FLEET_HEARTBEAT", "15") or 15)
        self.data_dir = Path(data_dir)
        self.path = Path(data_dir) / "fleet.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        saved = json.loads(self.path.read_text()) if self.path.exists() else {}
        nid = _env("AVRONE_NODE_ID") or saved.get("node_id")
        if not nid:
            base = re.sub(r"[^a-z0-9-]", "-", socket.gethostname().lower()).strip("-")[:40]
            nid = f"{base or 'node'}-{secrets.token_hex(3)}"
        if not ID_RE.match(nid):
            raise ValueError(f"AVRONE_NODE_ID {nid!r} must match {ID_RE.pattern}")
        self.node_id = nid
        self.nodes: dict[str, dict[str, Any]] = saved.get("nodes", {})
        self._nonces: dict[str, float] = {}
        self._task: asyncio.Task | None = None
        self._thermal_task: asyncio.Task | None = None
        self._bg: set[asyncio.Task] = set()
        self.queue = None  # JobQueue, attached by start_queue()
        self.worker = None
        self.netsquad_counts: dict[str, int] = {}  # node id -> netsquad placements (telemetry)
        self._save()

    # ------------------------------------------------------------ state
    @property
    def enabled(self) -> bool:
        return bool(self.token)

    def _save(self) -> None:
        self.path.write_text(json.dumps({"node_id": self.node_id, "nodes": self.nodes}, indent=2))

    def status_of(self, n: dict[str, Any]) -> str:
        age = time.time() - n.get("last_seen", 0)
        if age < 3 * self.heartbeat_s:
            return "online"
        if age < 10 * self.heartbeat_s:
            return "degraded"
        return "offline"

    def list_nodes(self) -> list[dict[str, Any]]:
        out = []
        for n in self.nodes.values():
            st = self.status_of(n)
            row = {**{k: v for k, v in n.items()}, "status": st}
            if st != "online" and row.get("health"):
                row["health"] = {**row["health"], "stale": True}  # aged with the status
            out.append(row)
        return out

    def node_state(self, n: dict[str, Any]) -> str:
        """Health state of a node record: ok/throttled/hot, "unknown", or "stale" once not online."""
        if self.status_of(n) != "online":
            return "stale" if n.get("health") else "unknown"
        h = n.get("health")
        return str(h.get("state", "unknown")) if isinstance(h, dict) else "unknown"

    def select_nodes(self, k: int = 1, need: str | None = None) -> list[dict[str, Any]]:
        """Up to k online, allowlisted children that have `need`, best health first.
        Hot/throttled nodes are excluded; ties break on in-flight load, then node id."""
        cands = []
        for n in self.nodes.values():
            nid = str(n.get("node_id", ""))
            if self.status_of(n) != "online" or not self.allowed(nid) or not node_has(n, need):
                continue
            if self.node_state(n) in EXCLUDED_STATES:
                continue
            cands.append(n)
        cands.sort(key=lambda n: (-health_score(n), n.get("load", 0) or 0, str(n.get("node_id"))))
        return cands[:max(0, int(k))]

    def health_table(self) -> list[dict[str, Any]]:
        """Per-child health for telemetry / tools: status, state, score, eligibility."""
        rows = []
        for n in sorted(self.nodes.values(), key=lambda n: str(n.get("node_id"))):
            st, hs = self.status_of(n), self.node_state(n)
            rows.append({"node_id": n.get("node_id"), "status": st, "state": hs,
                         "score": health_score(n) if st == "online" else None,
                         "eligible": st == "online" and hs not in EXCLUDED_STATES and self.allowed(str(n.get("node_id"))),
                         "load": n.get("load", 0), "health": n.get("health"),
                         "netsquad": self.netsquad_counts.get(str(n.get("node_id")), 0)})
        return rows

    def info(self) -> dict[str, Any]:
        return {"node_id": self.node_id, "enabled": self.enabled, "parent": self.parent or None,
                "public_url": self.public_url or None, "max_hops": self.max_hops,
                "privileged": self.privileged,
                "children": len(self.nodes), "active_agents": sum(
                    1 for a in self.core.active.values() if a.get("status") == "working")}

    # ------------------------------------------------------------ auth
    def verify(self, method: str, path: str, body: bytes, headers: dict[str, str]) -> None:
        """Authenticate a fleet request: token present, HMAC, timestamp window, nonce (in that order).
        Raises GatewayRefused (a PermissionError) with a distinct code/message per failure."""
        if not self.enabled:
            raise GatewayRefused("no_token", "fleet disabled: set AVRONE_FLEET_TOKEN")
        ts, nonce, sig = (headers.get("x-avrone-ts", ""), headers.get("x-avrone-nonce", ""),
                          headers.get("x-avrone-sig", ""))
        try:
            ts_i = int(ts)  # format check only; the window is enforced after the HMAC
        except ValueError:
            raise GatewayRefused("bad_timestamp", "bad timestamp") from None
        expect = sign(self.token, method, path, body, ts, nonce)["x-avrone-sig"]
        if not (sig and nonce and hmac.compare_digest(expect, sig)):
            raise GatewayRefused("bad_signature", "bad signature")
        now = time.time()
        if abs(now - ts_i) > WINDOW_S:
            raise GatewayRefused("stale", "stale request (timestamp outside window)")
        self._nonces = {k: v for k, v in self._nonces.items() if now - v < 2 * WINDOW_S}
        if nonce in self._nonces:
            raise GatewayRefused("replay", "replayed request (nonce already seen)")
        self._nonces[nonce] = now

    def allowed(self, node_id: str) -> bool:
        if not self.allow:
            return not self.require_allow  # empty list: allow-all, or refuse-all when required
        return node_id in self.allow

    def _audit(self, event: str, **kw: Any) -> None:
        # Codex.emit(run_id, kind, agent, **data): a payload key with one of those names would
        # collide (TypeError, so the audit was silently lost); prefix it with "req_" instead.
        for k in ("run_id", "kind", "agent"):
            if k in kw:
                kw[f"req_{k}"] = kw.pop(k)
        try:
            self.core.codex.emit("fleet", event, self.node_id, **kw)
        except Exception as e:  # noqa: BLE001  -- auditing must never mask the decision
            log.warning("fleet audit %s failed: %s", event, e)

    def _refuse(self, code: str, message: str, **kw: Any) -> GatewayRefused:
        self._audit("fleet.refused", code=code, reason=message, **kw)
        return GatewayRefused(code, message)

    def check_policy(self, kind: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Gateway steps 5-7 on an already-authenticated payload: sender allowlist, hop bound,
        per-request capability. Returns the decision record; raises GatewayRefused."""
        frm = payload.get("from")
        sender = sender_node(frm)
        ctx = {"kind": kind, "sender": sender or None}
        if self.allow or self.require_allow:
            if not sender:
                raise self._refuse("sender_missing", "unidentified sender: signed payload has no 'from'", **ctx)
            if not self.allowed(sender):
                why = "empty allowlist with AVRONE_FLEET_REQUIRE_ALLOW" if not self.allow else "AVRONE_FLEET_ALLOW"
                raise self._refuse("sender_not_allowed", f"sender {sender} not in AVRONE_FLEET_ALLOW ({why})", **ctx)
        if kind == "agentpack" and (not self.allow or sender not in self.allow):
            # moving a whole agent home is never open to "any token holder": explicit allowlist only
            raise self._refuse("sender_not_allowed", f"agent migration from {sender or '?'} refused: sender must be "
                               "listed in a non-empty AVRONE_FLEET_ALLOW", **ctx)
        try:
            hops = int(payload.get("hops", 1))
        except (TypeError, ValueError):
            raise self._refuse("bad_hops", "bad hop count", **ctx) from None
        if hops < 0:
            raise self._refuse("bad_hops", "bad hop count (negative)", **ctx)
        if hops > self.max_hops:  # sender may only emit hops <= max_hops (it refuses at hops >= max before +1)
            raise self._refuse("hops", f"max fleet hops exceeded ({hops} > {self.max_hops})", hops=hops, **ctx)
        cap = request_capability(kind, payload)
        flag = payload.get("privileged", False)
        if not isinstance(flag, bool):
            raise self._refuse("capability", "privileged flag must be a JSON boolean", hops=hops, **ctx)
        if flag or cap in PRIVILEGED_CAPABILITIES:
            self._privileged_gate(kind, cap, flag, sender, hops)
            return {**ctx, "hops": hops, "capability": cap, "privileged": True}
        if cap not in kind_capabilities(kind):
            raise self._refuse("capability", f"capability {cap!r} not permitted for {kind}", capability=cap,
                               hops=hops, **ctx)
        return {**ctx, "hops": hops, "capability": cap}

    def _privileged_refuse(self, code: str, message: str, **kw: Any) -> GatewayRefused:
        self._audit("fleet.privileged.refused", code=code, reason=message, **kw)
        return self._refuse(code, message, privileged=True, **kw)

    def _privileged_gate(self, kind: str, cap: str, flag: bool, sender: str, hops: int) -> None:
        """Deny-by-default elevated tier. Every condition must hold; any miss is refused + audited."""
        ctx = {"kind": kind, "sender": sender or None, "capability": cap, "hops": hops}
        if kind != "run" or cap not in PRIVILEGED_CAPABILITIES:
            raise self._privileged_refuse("privileged_capability",
                                          f"privileged flag needs a privileged capability on run, got {cap!r}", **ctx)
        if not flag:
            raise self._privileged_refuse("privileged_capability",
                                          f"capability {cap!r} requires the signed privileged flag", **ctx)
        if not self.privileged:
            raise self._privileged_refuse("privileged_disabled",
                                          "privileged tier disabled on this node (AVRONE_FLEET_PRIVILEGED != allow)", **ctx)
        if not sender or sender not in self.privileged_nodes:
            raise self._privileged_refuse("privileged_not_listed",
                                          f"sender {sender or '?'} not in AVRONE_PRIVILEGED_NODES", **ctx)
        if hops > self.privileged_max_hops:
            raise self._privileged_refuse("privileged_hops", f"privileged request beyond "
                                          f"AVRONE_FLEET_PRIVILEGED_MAX_HOPS ({hops} > {self.privileged_max_hops})", **ctx)

    def dispatch_gateway(self, kind: str, method: str, path: str, body: bytes,
                         headers: dict[str, str]) -> dict[str, Any]:
        """The single vetted inbound path for remote spawns/messages. Enforces, in order:
        token, HMAC, timestamp window, nonce, sender allowlist, hops, capability.
        Returns the parsed payload; raises GatewayRefused (audited as `fleet.refused`)."""
        try:
            self.verify(method, path, body, headers)
        except GatewayRefused as e:
            self._audit("fleet.refused", code=e.code, reason=str(e), kind=kind, path=path)
            raise
        if PRIVILEGED_HEADER in {k.lower() for k in headers}:
            msg = "privileged flag must be inside the signed payload, not a header"
            self._audit("fleet.privileged.refused", code="privileged_unsigned", reason=msg, kind=kind)
            raise self._refuse("privileged_unsigned", msg, kind=kind, privileged=True)
        try:
            payload = json.loads(body or b"{}")
        except ValueError:
            raise self._refuse("bad_body", "body must be JSON", kind=kind) from None
        if not isinstance(payload, dict):
            raise self._refuse("bad_body", "body must be a JSON object", kind=kind)
        decision = self.check_policy(kind, payload)
        self._audit("fleet.dispatch", path=path, **decision)
        if decision.get("privileged"):
            self._audit("fleet.privileged.accept", path=path, **decision)
        return payload

    def check_outbound(self, kind: str, capability: str, hops: int, first_hop: str = "",
                       privileged: bool = False) -> None:
        """Local mirror of the gateway for requests this node originates or forwards."""
        ctx = {"kind": kind, "direction": "out", "target": first_hop or None}
        if not self.enabled:
            raise GatewayRefused("no_token", "fleet disabled: set AVRONE_FLEET_TOKEN")
        if hops >= self.max_hops:
            raise self._refuse("hops", f"max fleet hops ({self.max_hops}) reached", hops=hops, **ctx)
        if privileged or capability in PRIVILEGED_CAPABILITIES:
            pctx = {**ctx, "capability": capability, "hops": hops}
            if kind != "run" or capability not in PRIVILEGED_CAPABILITIES or not privileged:
                raise self._privileged_refuse("privileged_capability",
                                              f"bad privileged request {capability!r} for {kind}", **pctx)
            if not self.privileged:
                raise self._privileged_refuse("privileged_disabled", "privileged tier disabled on this node "
                                              "(AVRONE_FLEET_PRIVILEGED != allow)", **pctx)
            if hops + 1 > self.privileged_max_hops:
                raise self._privileged_refuse("privileged_hops", "privileged request would exceed "
                                              f"AVRONE_FLEET_PRIVILEGED_MAX_HOPS ({self.privileged_max_hops})", **pctx)
            if not first_hop or first_hop in ("auto", "local"):
                raise self._privileged_refuse("privileged_target", "privileged requests need an explicit node", **pctx)
            if not self.allowed(first_hop):
                raise self._refuse("target_not_allowed", f"node {first_hop} not in AVRONE_FLEET_ALLOW", **ctx)
            return
        if capability not in kind_capabilities(kind):
            raise self._refuse("capability", f"capability {capability!r} not permitted for {kind}",
                               capability=capability, **ctx)
        if first_hop and first_hop not in ("auto", "local") and not self.allowed(first_hop):
            raise self._refuse("target_not_allowed", f"node {first_hop} not in AVRONE_FLEET_ALLOW", **ctx)

    # ------------------------------------------------------------ offload (edgeroute)
    def offload_mode(self) -> str:
        return offload_mode() if self.enabled else "off"

    def offload_plan(self, overflow: int, hops: int = 0) -> list[str]:
        """Node id for each of `overflow` workers (may be shorter/empty: those stay local).
        spill = all to the single healthiest child; spread = round-robin over the healthy children."""
        mode = self.offload_mode()
        if mode == "off" or overflow <= 0 or hops >= self.max_hops:
            return []
        nodes = self.select_nodes(1 if mode == "spill" else overflow, need="spawn:chat")
        if not nodes:
            return []
        return [str(nodes[i % len(nodes)]["node_id"]) for i in range(overflow)]

    async def offload_worker(self, run_id: str, node_id: str, role: str, task: str, focus: str,
                             hops: int = 0) -> str:
        """Run one squad worker on `node_id` (signed dispatch, mode chat). Raises on any failure,
        timeout or empty answer after auditing fleet.offload_fallback; the caller runs it locally."""
        prompt = (f"You are {role}, one worker of a squad on another AVRONE node.\nTASK: {task}\n"
                  f"YOUR FOCUS: {focus}\nReport your findings for your focus only.")
        self._audit("fleet.offload", squad_run=run_id, node=node_id, role=role, hops=hops)
        try:
            res = await asyncio.wait_for(self.dispatch([node_id], "chat", prompt, hops, origin_run=run_id),
                                         offload_timeout())
            answer = str((res or {}).get("answer") or "").strip()
            if not answer:
                raise RuntimeError("empty answer from remote worker")
            return answer
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001  -- includes TimeoutError and gateway refusals
            reason = f"{type(e).__name__}: {e}"[:300]
            self._audit("fleet.offload_fallback", squad_run=run_id, node=node_id, role=role, reason=reason)
            raise RuntimeError(f"offload to {node_id} failed: {reason}") from e

    # ------------------------------------------------------------ netsquad (squad -> node network)
    def squad_dispatch(self, override: str | None = None) -> str:
        return squad_dispatch(override) if self.enabled else "local"

    def netsquad_plan(self, n: int, local_limit: int, hops: int = 0, path: list[str] | None = None,
                      dispatch: str | None = None, budget: int | None = None) -> dict[int, str]:
        """{subtask index: node id} for the subtasks a squad of n places on the network.
        network = every subtask, hybrid = the ones past the local governor limit; nodes come from
        select_nodes (healthy, allowlisted, advertising squad:net), round-robin by score, never a
        node already on the route (audited fleet.cycle_refused), at most AVRONE_NET_MAX_NODES nodes
        and AVRONE_NET_MAX_REMOTE_AGENTS remote agents. Indices left out run locally."""
        mode = self.squad_dispatch(dispatch)
        if mode == "local" or n <= 0 or hops >= self.max_hops:
            return {}
        idx = list(range(n)) if mode == "network" else list(range(max(0, int(local_limit)), n))
        if not idx:
            return {}
        route = [str(x) for x in (path or [])]
        visited = set(route) | {self.node_id}
        nodes: list[str] = []
        for nd in self.select_nodes(len(self.nodes), need=NETSQUAD_CAP):
            nid = str(nd.get("node_id"))
            if nid in visited:
                self._audit("fleet.cycle_refused", node=nid, route=route + [self.node_id], direction="out")
                continue
            nodes.append(nid)
        nodes = nodes[:net_max_nodes()]
        if not nodes:
            return {}
        size = self.netsquad_size()
        cap = net_max_remote_agents() if budget is None else max(0, min(net_max_remote_agents(), int(budget)))
        fit = cap // size
        if fit < len(idx):
            self._audit("fleet.netsquad_capped", wanted=len(idx), placed=fit, size=size, cap=cap)
            idx = idx[:fit]
        return {i: nodes[j % len(nodes)] for j, i in enumerate(idx)}

    @staticmethod
    def netsquad_size() -> int:
        """Remote agents one placement spawns: the sub-squad size, or 1 in chat worker mode."""
        return net_subsquad() if net_worker_mode() == "squad" else 1

    def netsquad_share(self, placements: int, budget: int | None = None) -> int:
        """Remote-agent budget handed to each placement's subtree (its own sub-squad + any recursion)."""
        cap = net_max_remote_agents() if budget is None else max(1, min(net_max_remote_agents(), int(budget)))
        return max(self.netsquad_size(), cap // max(1, int(placements)))

    async def netsquad_worker(self, run_id: str, node_id: str, role: str, task: str, focus: str,
                              hops: int = 0, path: list[str] | None = None,
                              budget: int | None = None) -> dict[str, Any]:
        """Place one squad subtask on `node_id`: it runs there as a sub-squad (or chat) of the same
        subtask and may place further down. Returns {answer, node, route}. Raises after auditing
        fleet.netsquad_fallback on any failure/timeout/empty answer; the caller runs it locally."""
        mode = net_worker_mode()
        size = self.netsquad_size()
        route = [str(x) for x in (path or [])] + [self.node_id]
        prompt = (f"You are {role}, one placed worker of a squad on another AVRONE node.\nTASK: {task}\n"
                  f"YOUR SUBTASK: {focus}\nSolve this subtask and report your findings for it only.")
        self._audit("fleet.netsquad_place", squad_run=run_id, node=node_id, role=role, size=size, mode=mode,
                    hops=hops, route=route)
        self.netsquad_counts[node_id] = self.netsquad_counts.get(node_id, 0) + 1
        node: dict[str, Any] | None = None
        bumped = False
        try:
            self.check_outbound("run", NETSQUAD_CAP, hops, node_id)
            if node_id in route:
                self._audit("fleet.cycle_refused", node=node_id, route=route, direction="out")
                raise PermissionError(f"cycle: {node_id} already on route {'/'.join(route)}")
            node = self.pick(node_id)
            payload: dict[str, Any] = {
                "route": [], "mode": mode, "prompt": prompt, "n": size if mode == "squad" else None,
                "hops": hops + 1, "from": self.node_id, "origin_run": run_id, "capability": NETSQUAD_CAP,
                "netsquad": {"path": route, "role": str(role)[:60],
                             "budget": max(size, int(budget if budget is not None else size))}}
            posts = bridge_export(self.core, run_id=run_id)
            if posts:
                payload["bridge"] = posts
            node["load"] = node.get("load", 0) + 1
            bumped = True
            t = offload_timeout()
            res = await asyncio.wait_for(self._post(node["url"], "/api/fleet/run", payload, timeout=t), t)
            answer = str((res or {}).get("answer") or "").strip()
            if not answer:
                raise RuntimeError("empty answer from remote squad")
            bridge_merge(self.core, res.get("bridge"), node_id, run_id=run_id)
            sub = [str(x) for x in (res.get("path") or [node_id]) if isinstance(x, (str, int))][:16]
            return {"answer": answer, "node": node_id, "route": route + (sub or [node_id])}
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001  -- includes TimeoutError and gateway refusals
            reason = f"{type(e).__name__}: {e}"[:300]
            self._audit("fleet.netsquad_fallback", squad_run=run_id, node=node_id, role=role, reason=reason)
            raise RuntimeError(f"netsquad to {node_id} failed: {reason}") from e
        finally:
            if bumped and node is not None:
                node["load"] = max(0, node.get("load", 1) - 1)

    def _netsquad_refuse(self, code: str, message: str, **kw: Any) -> PermissionError:
        self._audit("fleet.refused", code=code, reason=message, endpoint="run", capability=NETSQUAD_CAP, **kw)
        return PermissionError(message)

    async def _handle_netsquad(self, payload: dict[str, Any], hops: int) -> dict[str, Any]:
        """Receiving side of a netsquad placement: run the subtask here as a sub-squad (or chat)."""
        sender = sender_node(payload.get("from"))
        if payload.get("capability") != NETSQUAD_CAP:
            raise self._netsquad_refuse("capability", "netsquad job requires capability 'squad:net'", sender=sender)
        if payload.get("privileged", False) is not False:
            raise self._netsquad_refuse("privileged_capability", "netsquad jobs are never privileged", sender=sender)
        if payload.get("route"):
            raise self._netsquad_refuse("bad_route", "netsquad jobs are placed on a direct child (empty route)",
                                        sender=sender)
        ns = payload.get("netsquad")
        path = ns.get("path") if isinstance(ns, dict) else None
        if (not isinstance(path, list) or not path or len(path) > self.max_hops + 1
                or not all(isinstance(x, str) and ID_RE.match(x) for x in path)):
            raise self._netsquad_refuse("bad_netsquad", "netsquad job needs a valid route path", sender=sender)
        if self.node_id in path:
            self._audit("fleet.cycle_refused", node=self.node_id, route=path, sender=sender, direction="in")
            raise PermissionError(f"cycle refused: {self.node_id} already on route {'/'.join(path)}")
        if sender and path[-1] != sender:
            raise self._netsquad_refuse("bad_netsquad", "netsquad route does not end at the signed sender",
                                        sender=sender)
        mode = str(payload.get("mode", "squad"))
        if mode not in NET_WORKER_MODES:
            raise self._netsquad_refuse("bad_netsquad", f"netsquad mode must be squad or chat, got {mode!r}",
                                        sender=sender)
        try:
            n = max(1, min(int(payload.get("n") or 2), NET_SUBSQUAD_MAX))
            budget = max(1, min(int(ns.get("budget") or n), net_max_remote_agents()))
        except (TypeError, ValueError):
            raise self._netsquad_refuse("bad_netsquad", "bad netsquad size/budget", sender=sender) from None
        prompt = str(payload.get("prompt", ""))
        c = self.core
        self._audit("fleet.run", mode=mode, frm=payload.get("from"), hops=hops, netsquad=True, size=n, route=path)
        # One bridge per (sender, origin run): the sender's posts are merged in first, the remote
        # squad runs under that id so its agents read them, and only posts written here go back.
        origin_run = re.sub(r"[^A-Za-z0-9_-]", "", str(payload.get("origin_run") or ""))[:40]
        rid = f"net-{sender or path[-1]}-{origin_run}" if origin_run else None
        bridge_merge(c, payload.get("bridge"), sender or path[-1], run_id=rid)
        prev = (getattr(c, "fleet_hops", 0), getattr(c, "netsquad_path", None), getattr(c, "netsquad_budget", None))
        c.fleet_hops, c.netsquad_path, c.netsquad_budget = hops, list(path), budget
        try:
            if rid:
                res = await (c.chat(prompt, run_id=rid) if mode == "chat" else c.squad(prompt, n, run_id=rid))
            else:
                res = await (c.chat(prompt) if mode == "chat" else c.squad(prompt, n))
        finally:
            c.fleet_hops, c.netsquad_path, c.netsquad_budget = prev
        out = {"node": self.node_id, "path": [self.node_id], "run_id": res.get("run_id"),
               "answer": res.get("answer") or "", "netsquad": True}
        posts = bridge_export(c, run_id=rid or res.get("run_id"), only_origin=self.node_id)
        if posts:
            out["bridge"] = posts
        return out

    # ------------------------------------------------------------ registry (server side)
    def register(self, payload: dict[str, Any]) -> dict[str, Any]:
        nid = str(payload.get("node_id", ""))
        url = str(payload.get("url", "")).rstrip("/")
        if not ID_RE.match(nid):
            raise ValueError("invalid node_id")
        if nid == self.node_id:
            raise ValueError("node_id collides with this server")
        if not self.allowed(nid):
            raise PermissionError(f"node {nid} not in AVRONE_FLEET_ALLOW")
        if not url.startswith(("http://", "https://")):
            raise ValueError("url must be http(s)")
        existing = self.nodes.get(nid)
        if existing and existing.get("url") != url and self.status_of(existing) == "online":
            raise ValueError(f"node_id {nid} already online at another url")
        self.nodes[nid] = {"node_id": nid, "url": url, "last_seen": time.time(),
                           "capabilities": payload.get("capabilities", {}),
                           "children": payload.get("children", []),
                           "load": payload.get("load", 0),
                           "presence": payload.get("presence"),
                           "health": sanitize_health(payload.get("health"))}
        self._save()
        self.core.codex.emit("fleet", "fleet.join", self.node_id, node=nid, url=url)
        return {"ok": True, "parent": self.node_id}

    # ------------------------------------------------------------ client side
    def _client(self, timeout: float) -> httpx.AsyncClient:
        kw: dict[str, Any] = {"timeout": timeout}
        if HTTP_TRANSPORT is not None:
            kw["transport"] = HTTP_TRANSPORT
        return httpx.AsyncClient(**kw)

    async def _post(self, base: str, path: str, payload: dict[str, Any], timeout: float = 30) -> dict[str, Any]:
        body = json.dumps(payload).encode()
        headers = {"content-type": "application/json", **sign(self.token, "POST", path, body)}
        async with self._client(timeout) as c:
            r = await c.post(base + path, content=body, headers=headers)
        if r.status_code >= 400:
            raise RuntimeError(f"{base}{path} -> {r.status_code}: {r.text[:300]}")
        return r.json()

    # ------------------------------------------------------------ memory sync
    async def push_memory(self, entries: list[dict[str, Any]], origin: str) -> dict[str, Any]:
        """Send memory entries ({ns, key, value, ts, agent}) up to the parent over the signed gateway."""
        if not self.enabled:
            raise GatewayRefused("no_token", "fleet disabled: set AVRONE_FLEET_TOKEN")
        if not self.parent:
            raise RuntimeError("no parent node: set AVRONE_FLEET_PARENT to sync memory upward")
        self.check_outbound("memory", "memory:sync", 0)
        if len(entries) > MEMORY_SYNC_MAX_ENTRIES:
            raise ValueError(f"too many entries ({len(entries)} > {MEMORY_SYNC_MAX_ENTRIES})")
        payload = {"from": origin or self.node_id, "hops": 1, "capability": "memory:sync", "entries": entries}
        res = await self._post(self.parent, MEMORY_PATH, payload, timeout=30)
        self._audit("fleet.memory.push", entries=len(entries), parent=self.parent)
        return res

    def receive_memory(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Server side of /api/fleet/memory. Call ONLY with a payload returned by dispatch_gateway.
        Merges into fleet:<sender>/<ns> (sender = signed `from` node id); never into a local namespace."""
        from . import memstore
        if request_capability("memory", payload) != "memory:sync":  # defense in depth
            raise PermissionError("capability memory:sync required")
        sender = sender_node(payload.get("from"))
        if not ID_RE.match(sender):
            raise ValueError("invalid sender node id")
        if sender == self.node_id:
            raise ValueError("refusing memory sync from this node's own id")
        entries = payload.get("entries")
        if not isinstance(entries, list):
            raise ValueError("entries must be a list")
        if len(entries) > MEMORY_SYNC_MAX_ENTRIES:
            raise ValueError(f"too many entries ({len(entries)} > {MEMORY_SYNC_MAX_ENTRIES})")
        groups: dict[str, list[dict[str, Any]]] = {}
        bad = 0
        for e in entries:
            ns = e.get("ns") if isinstance(e, dict) else None
            if not isinstance(ns, str) or not memstore.is_local(ns):  # sender may only name its own local ns
                bad += 1
                continue
            groups.setdefault(memstore.remote_namespace(sender, ns), []).append(e)
        store = memstore.MemoryStore(self.data_dir / "memory.jsonl")
        stats = {"merged": 0, "skipped": 0, "rejected": bad}
        for target, items in groups.items():
            for k, v in store.merge(target, items, source=sender).items():
                stats[k] += v
        self._audit("fleet.memory.merge", sender=sender, namespaces=sorted(groups), **stats)
        return {"ok": True, "node": self.node_id, "namespaces": sorted(groups), **stats}

    # ------------------------------------------------------------ agent migration (edgepack)
    def _workspace(self) -> Path:
        ws = getattr(getattr(self.core, "settings", None), "workspace", None)
        if not isinstance(ws, (str, Path)):
            raise RuntimeError("no workspace configured for agent homes")
        return Path(ws)

    def pick_migration_target(self, target: str = "auto") -> dict[str, Any]:
        """A healthy peer for an agent home: an explicit online node, or (auto) the coolest /
        least-loaded online allowed node by its governor readings, else any online node."""
        if target not in ("", "auto"):
            n = self.pick(target)
            if self.status_of(n) != "online":
                raise RuntimeError(f"node {target} is not online")
            return n
        thermal_max = getattr(getattr(self.core, "governor", None), "thermal_max_c", None)
        live = [n for n in self.nodes.values() if self.status_of(n) == "online" and self.allowed(n["node_id"])
                and n["node_id"] != self.node_id]
        if not live:
            raise RuntimeError("no online nodes to migrate to")

        def h(n: dict[str, Any], k: str) -> float | None:
            v = (n.get("health") or {}).get(k)
            return float(v) if isinstance(v, (int, float)) else None
        if isinstance(thermal_max, (int, float)):
            cool = [n for n in live if h(n, "temp_c") is None or h(n, "temp_c") < thermal_max]
            live = cool or live
        measured = [n for n in live if h(n, "temp_c") is not None or h(n, "load") is not None]
        if measured:
            return min(measured, key=lambda n: (h(n, "temp_c") if h(n, "temp_c") is not None else 0.0,
                                                h(n, "load") or 0.0, n.get("load", 0), n["node_id"]))
        return min(live, key=lambda n: (n.get("load", 0), n["node_id"]))

    async def migrate_agent(self, agent_id: str, target: str = "auto") -> dict[str, Any]:
        """Send one agent's home (dir + memory) to a peer over the signed gateway. Raises on
        refusal/failure (audited as agent.migrate_refused / agent.migrate_failed); the local home
        is never touched, so a failed migration leaves the agent where it is."""
        from . import agentfs, agentpack
        aid = str(agent_id or "")
        ctx = {"agent_id": aid, "target": target or "auto"}
        try:
            if agentfs.sanitize_agent_id(aid) != aid:
                raise PermissionError(f"invalid agent id {aid!r}")
            if not migrate_enabled():
                raise PermissionError("agent migration disabled (AVRONE_AGENT_MIGRATE != on)")
            first = target if target not in ("", "auto") else ""
            self.check_outbound("agentpack", "agent:migrate", 0, first)
            node = self.pick_migration_target(target)
            bundle, man = agentpack.export_pack(self._workspace(), self.data_dir, aid, self.node_id,
                                                home=agentpack.home_node(self.data_dir, aid, self.node_id))
        except (PermissionError, agentpack.PackError) as e:
            self._audit("agent.migrate_refused", reason=str(e)[:300], **ctx)
            raise
        except Exception as e:  # noqa: BLE001
            self._audit("agent.migrate_failed", reason=f"{type(e).__name__}: {e}"[:300], **ctx)
            raise
        import base64
        payload = {"from": self.node_id, "hops": 1, "capability": "agent:migrate", "agent_id": aid,
                   "bundle": base64.b64encode(bundle).decode()}
        try:
            res = await self._post(node["url"], AGENTPACK_PATH, payload, timeout=120)
        except Exception as e:  # noqa: BLE001
            refused = isinstance(e, RuntimeError) and re.search(r"-> (401|403|400):", str(e)) is not None
            self._audit("agent.migrate_refused" if refused else "agent.migrate_failed",
                        reason=f"{type(e).__name__}: {e}"[:300], **{**ctx, "target": node["node_id"]})
            raise
        agentpack.record(self.data_dir, aid, migrated_to=node["node_id"], migrated_stamp=man["created"],
                         migrated_at=int(time.time()))
        self._audit("agent.migrate", agent_id=aid, target=node["node_id"], files=len(man["files"]),
                    bytes=man["total_bytes"], created=man["created"], home=man["home"])
        return {"ok": True, "agent_id": aid, "target": node["node_id"], "files": len(man["files"]),
                "bytes": man["total_bytes"], "remote": res}

    def receive_agentpack(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Server side of /api/fleet/agentpack. Call ONLY with a payload returned by dispatch_gateway."""
        import base64
        import binascii

        from . import agentpack
        if request_capability("agentpack", payload) != "agent:migrate" or payload.get("privileged"):
            raise PermissionError("capability agent:migrate required (never privileged)")
        sender = sender_node(payload.get("from"))
        ctx = {"direction": "in", "sender": sender or None, "agent_id": str(payload.get("agent_id", ""))[:64]}
        if not migrate_enabled():
            self._audit("agent.migrate_refused", reason="AVRONE_AGENT_MIGRATE != on", **ctx)
            raise PermissionError("agent migration disabled on this node (AVRONE_AGENT_MIGRATE != on)")
        if not ID_RE.match(sender) or sender == self.node_id:
            raise ValueError("invalid sender node id")
        try:
            bundle = base64.b64decode(str(payload.get("bundle", "")), validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("bundle must be base64") from None
        try:
            res = agentpack.import_pack(self._workspace(), self.data_dir, bundle, self.node_id,
                                        expect_agent=str(payload.get("agent_id", "")), expect_origin=sender)
        except agentpack.PackError as e:
            self._audit("agent.migrate_refused", reason=str(e)[:300], **ctx)
            raise ValueError(str(e)) from None
        self._audit("agent.migrate", **ctx, files=res["files"], bytes=res["bytes"], home=res["home"])
        return {"ok": True, "node": self.node_id, **res}

    def idle_agents(self, now: float | None = None) -> list[str]:
        """Agent homes on this node that are not running and untouched for AVRONE_AGENT_IDLE_SECS."""
        from . import agentcontainer, agentfs, agentpack, memstore
        now = time.time() if now is None else now
        root = agentfs.agents_root(self._workspace())
        if not root.is_dir() or root.is_symlink():
            return []
        busy = {agentfs.sanitize_agent_id(a.get("agent_id") or a.get("role") or memstore.agent_namespace(n))
                for n, a in list(self.core.active.items()) if isinstance(a, dict) and a.get("status") == "working"}
        idx = agentpack.load_index(self.data_dir)
        out = []
        for d in sorted(root.iterdir()):
            aid = d.name
            if d.is_symlink() or not d.is_dir() or agentfs.sanitize_agent_id(aid) != aid or aid in busy:
                continue
            stamp = agentpack.content_stamp(self._workspace(), self.data_dir, aid)
            if now - stamp < agentcontainer.idle_secs():
                continue
            if idx.get(aid, {}).get("migrated_stamp") == stamp:  # already moved, unchanged since
                continue
            out.append(aid)
        return out

    async def thermal_migrate(self, now: float | None = None) -> list[dict[str, Any]]:
        """Governor hook: when this node is hot and AVRONE_AGENT_MIGRATE=on, move idle agents'
        homes to a cooler peer. Never raises; a failed agent stays put."""
        if not (self.enabled and migrate_enabled()):
            return []
        gov = getattr(self.core, "governor", None)
        try:
            if gov is None or not gov.is_hot():
                return []
            agents = self.idle_agents(now)
        except Exception as e:  # noqa: BLE001
            log.warning("thermal migrate check failed: %s", e)
            return []
        out: list[dict[str, Any]] = []
        for aid in agents:
            try:
                res = await self.migrate_agent(aid, "auto")
                out.append({"agent_id": aid, "ok": True, "target": res["target"]})
            except Exception as e:  # noqa: BLE001 - audited in migrate_agent; agent stays put
                out.append({"agent_id": aid, "ok": False, "error": str(e)[:200]})
                if "no online nodes" in str(e):
                    break
        return out

    async def thermal_loop(self) -> None:
        while True:
            await asyncio.sleep(migrate_interval())
            await self.thermal_migrate()

    async def join_parent_once(self) -> dict[str, Any]:
        from .presence import snapshot
        payload = {"presence": await snapshot(self.core),"node_id": self.node_id, "url": self.public_url,
                   "capabilities": {"tools": self.core.tools.names(), "runner": self.core.runner.kind,
                                    NETSQUAD_CAP: True},
                   "children": sorted(self.nodes), "load": self.info()["active_agents"],
                   "health": local_health(self.core)}
        return await self._post(self.parent, "/api/fleet/register", payload, timeout=10)

    async def heartbeat_loop(self) -> None:
        backoff = self.heartbeat_s
        while True:
            try:
                await self.join_parent_once()
                backoff = self.heartbeat_s
            except Exception as e:  # noqa: BLE001
                log.warning("fleet heartbeat to %s failed: %s", self.parent, e)
                backoff = min(backoff * 2, 300)
            await asyncio.sleep(backoff)

    def start(self) -> None:
        if self.enabled and self.parent and self.public_url and self._task is None:
            self._task = asyncio.create_task(self.heartbeat_loop())
        if self.enabled and migrate_enabled() and self._thermal_task is None:
            self._thermal_task = asyncio.create_task(self.thermal_loop())

    def start_queue(self, data_dir: Path) -> None:
        from .jobqueue import JobQueue, Worker
        self.queue = JobQueue(Path(data_dir) / "jobs.db")
        self.worker = Worker(self.queue, self.run_job)
        self.worker.start()

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None
        if self._thermal_task:
            self._thermal_task.cancel()
            self._thermal_task = None
        if self.worker:
            await self.worker.stop()
        if self.queue:
            await self.queue.close()
        for t in list(self._bg):
            t.cancel()

    def pick(self, target: str) -> dict[str, Any]:
        if target in ("", "auto"):
            best = self.select_nodes(1)
            if best:
                return best[0]
            if any(self.status_of(n) == "online" and self.allowed(n["node_id"]) for n in self.nodes.values()):
                raise RuntimeError("no healthy online nodes (all online nodes are hot or throttled)")
            raise RuntimeError("no online nodes")
        n = self.nodes.get(target)
        if not n:
            raise RuntimeError(f"unknown node {target!r}; known: {sorted(self.nodes) or 'none'}")
        if not self.allowed(target):
            raise PermissionError(f"node {target} not in AVRONE_FLEET_ALLOW")
        if self.status_of(n) == "offline":
            raise RuntimeError(f"node {target} is offline")
        return n

    async def dispatch(self, route: list[str], mode: str, prompt: str, hops: int, n: int | None = None,
                       origin_run: str = "", privileged: str = "", rounds: int | None = None,
                       checkpoint_id: str | None = None) -> dict[str, Any]:
        """Send a job down `route` (first element = one of my children).
        `privileged` = "priv:shell"/"priv:admin" requests the elevated tier (signed into the body).
        `rounds` (deep only) is clamped to 1..5 and only sent when given.
        `checkpoint_id` (squad/deep) rides in the signed body; the running node keys it per sender,
        so re-sending the same job with the same id resumes it there."""
        if hops >= self.max_hops:
            raise PermissionError(f"max fleet hops ({self.max_hops}) reached")
        mode = mode if mode in SPAWN_MODES else "squad"  # the remote ran unknown modes as squad anyway
        cap = privileged or f"spawn:{mode}"
        self.check_outbound("run", cap, hops, route[0] if route else "", privileged=bool(privileged))
        node = self.pick(route[0] if route else "auto")
        payload = {"route": route[1:], "mode": mode, "prompt": prompt, "n": n, "hops": hops + 1,
                   "from": self.node_id, "origin_run": origin_run}
        if privileged:  # inside the signed body: cannot be added, removed or changed in transit
            payload.update(privileged=True, capability=privileged)
        rounds = clamp_deep_rounds(rounds)
        if rounds is not None:
            payload["rounds"] = rounds
        if checkpoint_id not in (None, ""):
            if mode == "chat":
                raise ValueError("checkpoint_id works with mode squad or deep")
            payload["checkpoint_id"] = sanitize_ckpt_id(checkpoint_id)
        node["load"] = node.get("load", 0) + 1
        try:
            return await self._post(node["url"], "/api/fleet/run", payload, timeout=900)
        finally:
            node["load"] = max(0, node.get("load", 1) - 1)

    async def send_message(self, route: list[str], agent: str, text: str, sender: str, hops: int = 0,
                           wait: bool = False) -> dict[str, Any]:
        """Deliver `text` to `agent` on the node at `route` (empty route = this node)."""
        if route:
            if hops >= self.max_hops:
                raise PermissionError(f"max fleet hops ({self.max_hops}) reached")
            self.check_outbound("message", "message", hops, route[0])
            node = self.pick(route[0])
            payload = {"route": route[1:], "agent": agent, "message": text, "from": sender, "hops": hops + 1, "wait": wait}
            res = await self._post(node["url"], "/api/fleet/message", payload, timeout=900 if wait else 30)
            return {**res, "path": [self.node_id] + res.get("path", [])}
        return await self.deliver_local(agent, text, sender, wait)

    async def deliver_local(self, agent: str, text: str, sender: str, wait: bool) -> dict[str, Any]:
        c = self.core
        if c.message_agent(agent, text, sender):
            return {"node": self.node_id, "path": [self.node_id], "agent": agent, "delivered": "live",
                    "note": "queued in the live agent's inbox; it acts on it at its next step"}
        # Agent finished or unknown here: start a fresh agent with that role in this node's environment.
        role = agent.rsplit("-", 1)[0] or "Agent"
        run_id = f"msg-{secrets.token_hex(4)}"
        c.codex.emit(run_id, "run.start", "Trinity", prompt=text, mode="message", target=agent, sender=sender)
        job = c.run_agent(run_id, role, f"Message from {sender} to {agent}: {text}")
        if not wait:
            t = asyncio.create_task(job)
            self._bg.add(t)
            t.add_done_callback(self._bg.discard)
            return {"node": self.node_id, "path": [self.node_id], "agent": agent, "delivered": "respawned", "run_id": run_id}
        answer = await job
        c.codex.emit(run_id, "run.done", "Trinity")
        return {"node": self.node_id, "path": [self.node_id], "agent": agent, "delivered": "respawned",
                "run_id": run_id, "answer": answer}

    async def handle_message(self, payload: dict[str, Any]) -> dict[str, Any]:
        hops = int(payload.get("hops", 1))
        if hops > self.max_hops:
            raise PermissionError("max fleet hops exceeded")
        return await self.send_message([str(x) for x in payload.get("route") or []], str(payload["agent"]),
                                       str(payload["message"]), str(payload.get("from", "?")), hops,
                                       bool(payload.get("wait")))

    async def run_job(self, kind: str, p: dict[str, Any]) -> dict[str, Any]:
        """Queue handler: retried by the JobQueue if the target node is down."""
        route = [x for x in str(p.get("node", "local")).split("/") if x and x != "local"]
        if kind == "message":
            return await self.send_message(route, p["agent"], p["message"], p.get("from", self.node_id), 0, True)
        if not route and p.get("node") in ("local", "", None):
            res = await (self.core.chat(p["task"]) if p.get("mode") == "chat" else self.core.squad(p["task"], p.get("n")))
            return {"node": self.node_id, "answer": res.get("answer", "")}
        return await self.dispatch(route, p.get("mode", "squad"), p["task"], 0, p.get("n"))

    async def handle_run(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Server side of /api/fleet/run: forward if routed further, else run locally."""
        route = [str(x) for x in payload.get("route") or []]
        hops = int(payload.get("hops", 1))
        mode, prompt = str(payload.get("mode", "squad")), str(payload.get("prompt", ""))
        if hops > self.max_hops:
            raise PermissionError("max fleet hops exceeded")
        if payload.get("capability") == NETSQUAD_CAP or payload.get("netsquad") is not None:
            return await self._handle_netsquad(payload, hops)
        priv = ""
        if payload.get("privileged", False) is not False or payload.get("capability") in PRIVILEGED_CAPABILITIES:
            # defense in depth: re-run the gate even though the HTTP path already passed dispatch_gateway
            cap = str(payload.get("capability", ""))
            self._privileged_gate("run", cap, payload.get("privileged") is True, sender_node(payload.get("from")), hops)
            priv = cap
        ck_id = payload.get("checkpoint_id")
        if ck_id is not None:
            if mode not in ("squad", "deep"):
                raise CheckpointError("checkpoint_id works with mode squad or deep")
            ck_id = sanitize_ckpt_id(ck_id)  # CheckpointError -> 400
        if route:
            kw = {"rounds": r} if (r := clamp_deep_rounds(payload.get("rounds"))) is not None else {}
            if ck_id:
                kw["checkpoint_id"] = ck_id
            res = await self.dispatch(route, mode, prompt, hops, payload.get("n"), payload.get("origin_run", ""),
                                      privileged=priv, **kw)
            return {**res, "path": [self.node_id] + res.get("path", [])}
        c = self.core
        self.core.codex.emit("fleet", "fleet.run", self.node_id, mode=mode, frm=payload.get("from"), hops=hops,
                             **({"privileged": priv} if priv else {}), **({"checkpoint_id": ck_id} if ck_id else {}))
        ck: dict[str, Any] = {}
        release = None
        if ck_id:
            # keyed by the (signed) immediate sender and stamped with it: senders can't collide or
            # resume each other's checkpoints; a retried job from the same sender resumes
            sender = sender_node(payload.get("from"))
            ck_path = managed_path(self.data_dir, fleet_key(sender, ck_id))
            check_compatible(ck_path, prompt, mode, owner=f"fleet:{sender}")  # CheckpointConflict -> 409
            release = ckpt_claim(ck_path)
            try:
                stamp_owner(ck_path, f"fleet:{sender}")
            except BaseException:
                release()
                raise
            ck = {"checkpoint": ck_path}
        prev = getattr(c, "fleet_hops", 0)
        prev_priv = getattr(c, "fleet_privileged", "")
        c.fleet_hops = hops  # remote agents see how deep they are
        c.fleet_privileged = priv  # granted elevated capability ("" = none); tools gate on it
        try:
            # run-scoped half of the grant: tools spawned in THIS run's task tree see it, a run executing
            # concurrently on the same core does not (priv tools require both halves to agree)
            with priv_grant(priv):
                if mode == "chat":
                    res = await c.chat(prompt)
                elif mode == "deep":
                    r = clamp_deep_rounds(payload.get("rounds"))
                    res = await c.deep(prompt, None, payload.get("n"), **({"rounds": r} if r is not None else {}),
                                       **ck)
                else:
                    res = await c.squad(prompt, payload.get("n"), **ck)
        finally:
            if release:
                release()
            c.fleet_hops = prev
            c.fleet_privileged = prev_priv
        answer = res.get("answer") or res.get("report") or ""
        return {"node": self.node_id, "path": [self.node_id], "run_id": res.get("run_id"), "answer": answer,
                **({"checkpoint_id": ck_id} if ck_id else {})}


# ---------------------------------------------------------------- agent tools
def _fleet(ctx: "AgentContext") -> FleetManager:
    f = getattr(ctx.core, "fleet", None)
    if f is None or not f.enabled:
        raise RuntimeError("fleet disabled: set AVRONE_FLEET_TOKEN on every node")
    return f


async def t_fleet_nodes(ctx: "AgentContext", args: dict[str, Any]) -> str:
    f = _fleet(ctx)
    rows = [f"this node: {f.node_id} (parent: {f.parent or 'none'})"]
    for n in f.list_nodes():
        h = n.get("health") if isinstance(n.get("health"), dict) else {}
        hs = f.node_state(n)
        hp = "" if not h else (f" health={hs} score={health_score(n)}" if n["status"] == "online" else f" health={hs}")
        temp = f" temp={h['temp_c']}C" if h.get("temp_c") is not None and n["status"] == "online" else ""
        rows.append(f"- {n['node_id']} [{n['status']}] load={n.get('load', 0)} children={n.get('children', [])} "
                    f"runner={n.get('capabilities', {}).get('runner', '?')}{hp}{temp}")
    return "\n".join(rows) if len(rows) > 1 else rows[0] + "\nno child nodes registered"


async def t_remote_spawn(ctx: "AgentContext", args: dict[str, Any]) -> str:
    f = _fleet(ctx)
    target = str(args.get("node", "auto"))
    route = [p for p in target.split("/") if p] if target != "auto" else []
    hops = getattr(ctx.core, "fleet_hops", 0)
    priv = str(args.get("privileged") or "")
    if priv and not priv.startswith("priv:"):
        priv = f"priv:{priv}"
    kw = {"rounds": r} if (r := clamp_deep_rounds(args.get("rounds"))) is not None else {}
    if args.get("checkpoint_id"):  # squad/deep: a retried spawn with the same id resumes on that node
        kw["checkpoint_id"] = str(args["checkpoint_id"])
    try:
        res = await f.dispatch(route, str(args.get("mode", "squad")), str(args["task"]), hops, args.get("n"),
                               ctx.run_id, privileged=priv, **kw)
    except GatewayRefused as e:
        if not priv:
            raise
        return f"ERROR: privileged request refused: {e}"
    return f"[{' -> '.join([f.node_id] + res.get('path', []))}] run {res.get('run_id')}\n{res.get('answer', '')}"


async def t_remote_broadcast(ctx: "AgentContext", args: dict[str, Any]) -> str:
    f = _fleet(ctx)
    targets = args.get("nodes") or [n["node_id"] for n in f.list_nodes() if n["status"] == "online"]
    # Normalize each route ("good/", "/good", " good " are all "good") before de-duplicating, and
    # drop empty ones: an empty route would silently become an "auto" pick of some other node.
    routes = ("/".join(p.strip() for p in str(t).split("/") if p.strip()) for t in targets)
    targets = list(dict.fromkeys(r for r in routes if r))[:8]
    if not targets:
        return "ERROR: no online nodes"
    hops = getattr(ctx.core, "fleet_hops", 0)

    async def one(t: str) -> str:
        try:
            r = await f.dispatch([p for p in t.split("/") if p], str(args.get("mode", "squad")), str(args["task"]),
                                 hops, args.get("n"), ctx.run_id)
            return f"## {t}\n{r.get('answer', '')}"
        except Exception as e:  # noqa: BLE001
            return f"## {t}\nERROR: {type(e).__name__}: {e}"
    return "\n\n".join(await asyncio.gather(*(one(t) for t in targets)))


async def t_fleet_agents(ctx: "AgentContext", args: dict[str, Any]) -> str:
    from .presence import directory, render
    f = _fleet(ctx)
    rows = await directory(ctx.core)
    q = str(args.get("filter", "")).lower()
    if q:
        rows = [{**r, "agents": [a for a in r["agents"] if q in json.dumps(a).lower()]} for r in rows
                if q in json.dumps(r).lower()]
    return f"directory from {f.node_id}:\n" + render(rows, bool(args.get("live_only")))


async def t_agent_message(ctx: "AgentContext", args: dict[str, Any]) -> str:
    from .presence import directory, find_agent
    f = _fleet(ctx)
    route, name = find_agent(await directory(ctx.core), str(args["agent"]))
    res = await f.send_message([p for p in route.split("/") if p], name, str(args["message"]),
                               f"{f.node_id}/{ctx.name}", getattr(ctx.core, "fleet_hops", 0), bool(args.get("wait")))
    head = f"[{' -> '.join(res.get('path', []))}] {name}: {res.get('delivered')}"
    return head + (f"\n{res['answer']}" if res.get("answer") else f" ({res.get('note') or res.get('run_id')})")


async def t_queue_submit(ctx: "AgentContext", args: dict[str, Any]) -> str:
    f = _fleet(ctx)
    if f.queue is None:
        return "ERROR: queue not running"
    payload = {"task": str(args["task"]), "node": str(args.get("node", "auto")), "mode": str(args.get("mode", "squad")),
               "n": args.get("n"), "from": f"{f.node_id}/{ctx.name}"}
    first = payload["node"].split("/", 1)[0]
    try:  # vet at submit time too, so a doomed job never enters the durable queue
        mode = payload["mode"] if payload["mode"] in SPAWN_MODES else "squad"
        f.check_outbound("run", f"spawn:{mode}", getattr(ctx.core, "fleet_hops", 0), first)
    except PermissionError as e:
        return f"ERROR: refused by fleet gateway: {e}"
    jid = await f.queue.enqueue("run", payload, int(args.get("priority", 0)), int(args.get("max_attempts", 3)))
    return f"queued job {jid} -> {payload['node']} (retries on failure; check with queue_status)"


async def t_queue_status(ctx: "AgentContext", args: dict[str, Any]) -> str:
    f = _fleet(ctx)
    if f.queue is None:
        return "ERROR: queue not running"
    if args.get("job_id"):
        j = await f.queue.get(str(args["job_id"]))
        if not j:
            return "ERROR: no such job"
        res = j.get("result") or {}
        return (f"job {j['id']} {j['status']} attempts={j['attempts']}/{j['max_attempts']}"
                + (f"\nerror: {j['error']}" if j.get("error") and j["status"] != "done" else "")
                + (f"\n{res.get('answer', '')}" if isinstance(res, dict) else ""))
    return json.dumps(await f.queue.stats())


FLEET_TOOLS = [
    ("fleet_agents", "directory of every agent across the fleet: its node route, device, container, networks, services and current task.",
     '{"filter"?: str, "live_only"?: bool}', t_fleet_agents),
    ("agent_message", "send instructions to a specific agent anywhere in the fleet (\"Builder-3\" or \"router/edge/Builder-3\"); a live agent acts on it inside its own environment, a finished one is respawned there.",
     '{"agent": str, "message": str, "wait"?: bool}', t_agent_message),
    ("queue_submit", "durably queue a squad/chat run for a node (route, \"auto\" or \"local\"); retried if the node is down.",
     '{"task": str, "node"?: str, "mode"?: str, "n"?: int, "priority"?: int, "max_attempts"?: int}', t_queue_submit),
    ("queue_status", "status/result of a queued job, or queue counts if no job_id.", '{"job_id"?: str}', t_queue_status),
    ("fleet_nodes", "list linked AVRONE nodes/routers with status, load and their children.", "{}", t_fleet_nodes),
    ("remote_spawn", "spawn a squad/chat/deep run on a remote AVRONE node; node may be a route like \"router1/edge7\" or \"auto\" (healthiest: cool/idle first, hot/throttled skipped). Returns its answer.",
     '{"task": str, "node"?: str, "mode"?: "squad"|"chat"|"deep", "n"?: int, "rounds"?: 1-5 (deep), "privileged"?: "shell"|"admin", "checkpoint_id"?: str (squad/deep, resume on retry)}', t_remote_spawn),
    ("remote_broadcast", "run the same task on several remote nodes in parallel (default: all online, max 8) and return every answer.",
     '{"task": str, "nodes"?: [str], "mode"?: str, "n"?: int}', t_remote_broadcast),
]


def register_fleet_tools(registry) -> None:
    for name, desc, args_doc, fn in FLEET_TOOLS:
        registry.register(Tool(name, desc, args_doc, fn, source="builtin"))
