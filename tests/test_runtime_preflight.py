"""Offline tests for the read-only runtime_preflight tool."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from avrone import tools_extra as tx
from avrone.tools import builtin_registry


def _ctx(workspace: Path, data_dir: Path):
    settings = SimpleNamespace(
        workspace=workspace, data_dir=data_dir, runner="local",
        allow_network=False, agents_can_shell=False, governor=True,
        max_parallel=2, max_steps=5, max_spawn_depth=2,
        agent_timeout=900, command_timeout=120, thermal_max_c=85,
    )
    runner = SimpleNamespace(workspace=workspace)
    return SimpleNamespace(core=SimpleNamespace(settings=settings, runner=runner), run_id="r1", name="probe")


def _run(coro):
    return asyncio.run(coro)


def test_preflight_reports_ready_paths_without_mutating_them(tmp_path):
    workspace, data_dir = tmp_path / "workspace", tmp_path / "data"
    workspace.mkdir()
    data_dir.mkdir()
    before = sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob("*"))

    report = json.loads(_run(tx.t_runtime_preflight(_ctx(workspace, data_dir), {"format": "json"})))

    after = sorted(str(p.relative_to(tmp_path)) for p in tmp_path.rglob("*"))
    assert report["ready"] is True
    assert all(p["ready"] for p in report["paths"])
    assert report["runtime"]["network_enabled"] is False
    assert report["limits"]["max_parallel"] == 2
    assert before == after


def test_preflight_flags_unwritable_workspace(tmp_path, monkeypatch):
    workspace, data_dir = tmp_path / "workspace", tmp_path / "data"
    workspace.mkdir()
    data_dir.mkdir()
    real_access = tx.os.access

    def access(path, mode):
        if Path(path) == workspace:
            return False
        return real_access(path, mode)

    monkeypatch.setattr(tx.os, "access", access)
    report = json.loads(_run(tx.t_runtime_preflight(_ctx(workspace, data_dir), {"format": "json"})))

    assert report["ready"] is False
    assert "workspace is not writable or creatable" in report["warnings"]


def test_preflight_accepts_missing_creatable_data_dir_and_rejects_bad_args(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    data_dir = tmp_path / "nested" / "data"
    ctx = _ctx(workspace, data_dir)
    report = json.loads(_run(tx.t_runtime_preflight(ctx, {"format": "json"})))
    assert report["ready"] is True
    assert next(p for p in report["paths"] if p["label"] == "data_dir")["exists"] is False
    assert _run(tx.t_runtime_preflight(ctx, None)).startswith("ERROR:")


def test_runtime_preflight_is_registered():
    registry = builtin_registry()
    tx.register_extra_tools(registry)
    assert registry.get("runtime_preflight") is not None
