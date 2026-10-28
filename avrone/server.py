"""Ghost Shell: the surface users and admins touch (web UI, REST, WebSocket HUD)."""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import __version__
from .bootstrap import build_core, run_cleanups
from .config import settings
from .trinity import TrinityCore, clamp_deep_rounds

STATIC = Path(__file__).parent / "static"
state: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    # build_core establishes the environment FIRST (so agents never hit a missing
    # sandbox mid-task), then wires tools, plugins and MCP servers.
    core_, cleanups = await build_core(settings)
    state["core"] = core_
    state["tasks"] = set()
    try:
        yield
    finally:
        for t in list(state["tasks"]):
            t.cancel()
        await run_cleanups(cleanups)


app = FastAPI(title="AVRONE", version=__version__, lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


def core() -> TrinityCore:
    return state["core"]


def require_admin(token: str | None) -> None:
    if not settings.admin_token:
        raise HTTPException(403, "Admin access is off. Set AVRONE_ADMIN_TOKEN to enable it.")
    if token != settings.admin_token:
        raise HTTPException(401, "Bad admin token")


class ChatIn(BaseModel):
    message: str
    mode: str = "squad"  # squad | chat | deep
    squad_size: int | None = None
    first_answer: str | None = None  # deep mode: the answer to stress-test (else a squad runs first)
    rounds: int | None = None  # deep mode: max waves, clamped to 1..5 (default settings/env, else 1)
    background: bool = False
    # squad/deep: server-managed checkpoint (data_dir/checkpoints/<id>.json). Re-posting the same
    # id and task resumes an interrupted (or background) run; a different task is refused (409).
    checkpoint_id: str | None = None
    # squad only: netsquad placement for this request (local|network|hybrid); default AVRONE_SQUAD_DISPATCH
    dispatch: str | None = None


class TerminalIn(BaseModel):
    cmd: str


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/status")
async def status():
    c = core()
    return {
        "runner": c.runner.kind,
        "workspace": str(c.runner.workspace),
        "provider": settings.provider,
        "model": settings.llm_model,
        "backend": settings.llm_base_url if settings.llm_mode != "mock" else "mock",
        "squad_size": settings.squad_size,
        "deep_squad_size": settings.deep_squad_size,
        "max_parallel": settings.max_parallel,
        "tools": len(c.tools.names()),
        "admin_enabled": bool(settings.admin_token),
        "agents": c.active,
    }


def _open_checkpoint(cid_raw: str, task: str, mode: str):
    """(checkpoint id, file path, stored meta or None, release) for a client checkpoint_id."""
    from .checkpoint import CheckpointConflict, CheckpointError, check_compatible, claim, managed_path, sanitize_client_id
    if mode not in ("squad", "deep"):
        raise HTTPException(400, "checkpoint_id works with mode squad or deep")
    try:
        cid = sanitize_client_id(cid_raw)
        path = managed_path(settings.data_dir, cid)
        meta = check_compatible(path, task, mode)
        release = claim(path)
    except CheckpointConflict as e:
        raise HTTPException(409, str(e)) from None
    except CheckpointError as e:
        raise HTTPException(400, str(e)) from None
    return cid, path, meta, release


@app.post("/api/chat")
async def chat(body: ChatIn):
    c = core()
    if body.mode not in ("squad", "chat", "deep"):
        raise HTTPException(400, f"Unknown mode {body.mode!r}. Use squad, chat or deep.")
    if body.dispatch is not None:
        if body.mode != "squad":
            raise HTTPException(400, "dispatch works with mode squad")
        if body.dispatch not in ("local", "network", "hybrid"):
            raise HTTPException(400, f"Unknown dispatch {body.dispatch!r}. Use local, network or hybrid.")
    run_id = uuid.uuid4().hex[:10]
    ck: dict = {}
    cid, release = None, None
    if body.checkpoint_id is not None:
        cid, path, meta, release = _open_checkpoint(body.checkpoint_id, body.message, body.mode)
        ck = {"checkpoint": path}
        if meta and isinstance(meta.get("run_id"), str):
            run_id = meta["run_id"]  # a resume keeps logging under the original run
    try:
        if body.mode == "squad":
            # Only pass dispatch when asked, so cores without the knob keep working.
            dk = {"dispatch": body.dispatch} if body.dispatch is not None else {}
            job = c.squad(body.message, body.squad_size, run_id, **ck, **dk)
        elif body.mode == "chat":
            job = c.chat(body.message, run_id)
        else:  # deep
            rounds = clamp_deep_rounds(body.rounds)
            # Only pass rounds when asked, so cores without the knob keep working.
            kw = {"rounds": rounds} if rounds is not None else {}
            job = c.deep(body.message, body.first_answer, body.squad_size, run_id, **kw, **ck)
    except BaseException:
        if release:
            release()
        raise
    extra = {"checkpoint_id": cid} if cid else {}
    if body.background:  # long-running artifact: return now, watch it on the HUD
        t = asyncio.create_task(job)
        state["tasks"].add(t)
        t.add_done_callback(state["tasks"].discard)
        if release:  # a background run that dies frees its checkpoint; re-post to resume
            t.add_done_callback(lambda _t: release())
        return {"run_id": run_id, "status": "running", **extra}
    try:
        res = await job
    finally:
        if release:
            release()
    return {**res, **extra} if isinstance(res, dict) and extra else res


# ------------------------------------------------------------------ checkpoints (admin)
def _ck_key(ck_id: str) -> str:
    from .checkpoint import CheckpointError, managed_path
    try:
        managed_path(settings.data_dir, ck_id)
    except CheckpointError:
        raise HTTPException(400, "bad checkpoint id (1-64 chars of A-Z a-z 0-9 _ -)") from None
    return ck_id


@app.get("/api/checkpoints")
async def checkpoints_list(x_admin_token: str | None = Header(default=None)):
    require_admin(x_admin_token)
    from .checkpoint import list_managed
    return list_managed(settings.data_dir)


@app.get("/api/checkpoints/{ck_id}")
async def checkpoint_get(ck_id: str, x_admin_token: str | None = Header(default=None)):
    require_admin(x_admin_token)
    from .checkpoint import describe, managed_path
    row = describe(managed_path(settings.data_dir, _ck_key(ck_id)), full=True)
    if row is None:
        raise HTTPException(404, f"no checkpoint {ck_id!r}")
    return row


@app.delete("/api/checkpoints/{ck_id}")
async def checkpoint_delete(ck_id: str, x_admin_token: str | None = Header(default=None)):
    require_admin(x_admin_token)
    from .checkpoint import CheckpointConflict, delete_managed
    try:
        if not delete_managed(settings.data_dir, _ck_key(ck_id)):
            raise HTTPException(404, f"no checkpoint {ck_id!r}")
    except CheckpointConflict as e:
        raise HTTPException(409, str(e)) from None
    return {"deleted": ck_id}


@app.get("/api/tools")
async def tools():
    return core().tools.list()


@app.get("/api/extensions")
async def extensions():
    return getattr(core(), "extensions", {})


# ------------------------------------------------------------------ fleet
def _fleet():
    f = getattr(core(), "fleet", None)
    if f is None or not f.enabled:
        raise HTTPException(404, "fleet disabled (set AVRONE_FLEET_TOKEN)")
    return f


async def _gateway(request: Request, kind: str) -> dict:
    """Inbound remote spawn/message: the single vetted path (fleet.dispatch_gateway)."""
    from .fleet import GatewayRefused
    f = _fleet()
    body = await request.body()
    try:
        return f.dispatch_gateway(kind, request.method, request.url.path, body,
                                  {k.lower(): v for k, v in request.headers.items()})
    except GatewayRefused as e:
        if e.code == "bad_body":
            raise HTTPException(400, str(e)) from None
        raise HTTPException(401 if e.auth else 403, str(e)) from None


async def _verified(request: Request) -> dict:
    f = _fleet()
    body = await request.body()
    try:
        f.verify(request.method, request.url.path, body, {k.lower(): v for k, v in request.headers.items()})
    except PermissionError as e:
        raise HTTPException(401, str(e)) from None
    import json as _json
    try:
        payload = _json.loads(body or b"{}")
    except ValueError:
        raise HTTPException(400, "body must be JSON") from None
    if not isinstance(payload, dict):
        raise HTTPException(400, "body must be a JSON object")
    return payload


@app.get("/api/fleet")
async def fleet_info(x_admin_token: str | None = Header(default=None)):
    require_admin(x_admin_token)
    f = _fleet()
    return {**f.info(), "nodes": f.list_nodes()}


@app.post("/api/fleet/register")
async def fleet_register(request: Request):
    payload = await _verified(request)
    try:
        return _fleet().register(payload)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from None
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@app.post("/api/fleet/message")
async def fleet_message(request: Request):
    payload = await _gateway(request, "message")
    try:
        return await _fleet().handle_message(payload)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from None
    except (RuntimeError, KeyError) as e:
        raise HTTPException(502, str(e)) from None


@app.get("/api/fleet/directory")
async def fleet_directory(x_admin_token: str | None = Header(default=None)):
    require_admin(x_admin_token)
    from .presence import directory
    return await directory(core())


class AgentMsgIn(BaseModel):
    agent: str
    message: str
    wait: bool = False


@app.post("/api/fleet/tell")
async def fleet_tell(body: AgentMsgIn, x_admin_token: str | None = Header(default=None)):
    """Operator/chatbot -> any agent in the fleet, by name or route/name."""
    require_admin(x_admin_token)
    from .presence import directory, find_agent
    f = _fleet()
    try:
        route, name = find_agent(await directory(core()), body.agent)
        return await f.send_message([p for p in route.split("/") if p], name, body.message,
                                    f"{f.node_id}/operator", 0, body.wait)
    except LookupError as e:
        raise HTTPException(404, str(e)) from None
    except (RuntimeError, PermissionError) as e:
        raise HTTPException(502, str(e)) from None


@app.get("/api/fleet/jobs")
async def fleet_jobs(job_id: str | None = None, x_admin_token: str | None = Header(default=None)):
    require_admin(x_admin_token)
    f = _fleet()
    if job_id:
        j = await f.queue.get(job_id)
        if not j:
            raise HTTPException(404, "no such job")
        return j
    return await f.queue.stats()


@app.post("/api/fleet/memory")
async def fleet_memory(request: Request):
    """Inbound memory sync from a child node: same signed gateway as run/message (kind "memory")."""
    payload = await _gateway(request, "memory")
    try:
        return _fleet().receive_memory(payload)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from None
    except ValueError as e:
        raise HTTPException(400, str(e)) from None


@app.post("/api/fleet/agentpack")
async def fleet_agentpack(request: Request):
    """Inbound agent-home migration (edgepack): signed gateway, kind "agentpack", cap agent:migrate."""
    payload = await _gateway(request, "agentpack")
    try:
        return _fleet().receive_agentpack(payload)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from None
    except (ValueError, RuntimeError) as e:
        raise HTTPException(400, str(e)) from None


@app.post("/api/fleet/run")
async def fleet_run(request: Request):
    payload = await _gateway(request, "run")
    f = _fleet()
    from .checkpoint import CheckpointConflict, CheckpointError
    try:
        return await f.handle_run(payload)
    except PermissionError as e:
        raise HTTPException(403, str(e)) from None
    except CheckpointConflict as e:
        raise HTTPException(409, str(e)) from None
    except CheckpointError as e:
        raise HTTPException(400, str(e)) from None
    except RuntimeError as e:
        raise HTTPException(502, str(e)) from None


@app.get("/api/gateway")
async def gateway_status():
    return core().llm.status()


@app.get("/api/evolve")
async def api_evolve():
    from .evolve import list_accepted
    return {"accepted": list_accepted(core().settings)}


@app.get("/api/osint/metrics")
async def api_osint_metrics():
    from types import SimpleNamespace
    from .osint import t_osint_metrics
    c = core()
    ctx = SimpleNamespace(core=c, run_id="api", name="api", depth=0)
    return {"metrics": await t_osint_metrics(ctx, {})}


@app.get("/api/telemetry")
async def api_telemetry(hours: float = 24):
    from .telemetry import telemetry
    return telemetry(core(), hours * 3600)


@app.get("/api/map")
async def api_map(hours: float = 24, format: str = "json"):
    from fastapi.responses import PlainTextResponse
    from .telemetry import system_map, to_mermaid
    g = system_map(core(), hours * 3600)
    return PlainTextResponse(to_mermaid(g)) if format == "mermaid" else g


@app.get("/api/runs")
async def runs():
    return core().codex.runs()


@app.get("/api/runs/{run_id}")
async def run_log(run_id: str):
    events = core().codex.replay(run_id)
    if not events:
        raise HTTPException(404, f"no run {run_id!r}")
    return events


@app.get("/api/runs/{run_id}/bridge")
async def run_bridge(run_id: str):
    """The learning bridge of a run: every post agents shared with each other, oldest first."""
    from .bridge import bridge_run_id, load_posts, safe_run_id
    if safe_run_id(run_id) != run_id:
        raise HTTPException(400, "bad run id")
    c = core()
    open_ = (getattr(c, "_bridges", None) or {}).get(bridge_run_id(run_id))
    posts = open_.posts() if open_ is not None else load_posts(c.settings.data_dir, run_id)
    if posts is None:
        if not c.codex.replay(run_id):
            raise HTTPException(404, f"no run {run_id!r}")
        posts = []
    return {"run_id": run_id, "count": len(posts), "posts": posts}


@app.post("/api/terminal")
async def terminal(body: TerminalIn, x_admin_token: str | None = Header(default=None)):
    require_admin(x_admin_token)
    res = await core().runner.run(body.cmd)
    core().codex.emit("admin", "tool.result", "Admin", tool="terminal", output=res.text()[:4000])
    return asdict(res)


@app.websocket("/ws/events")
async def events(ws: WebSocket):
    await ws.accept()
    q = core().codex.subscribe()
    try:
        while True:
            ev = await q.get()
            await ws.send_json(asdict(ev))
    except WebSocketDisconnect:
        pass
    finally:
        core().codex.unsubscribe(q)


def main() -> None:
    import os
    import uvicorn
    uvicorn.run("avrone.server:app", host=os.getenv("AVRONE_HOST", "127.0.0.1"),
                port=int(os.getenv("AVRONE_PORT", "8710")))


if __name__ == "__main__":
    main()
