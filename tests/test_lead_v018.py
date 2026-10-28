"""Lead-merge regressions for v0.18."""
import json
from types import SimpleNamespace

from avrone.codex import Codex
from avrone.fleet import FleetManager


def test_fleet_audit_with_real_codex_keeps_kind(tmp_path, monkeypatch):
    """_audit(kind=...) used to collide with Codex.emit's own `kind` and was silently dropped."""
    monkeypatch.setenv("AVRONE_FLEET_TOKEN", "tok")
    monkeypatch.setenv("AVRONE_NODE_ID", "root")
    codex = Codex(tmp_path / "d")
    core = SimpleNamespace(codex=codex, active={}, settings=SimpleNamespace(data_dir=tmp_path / "d"))
    fm = FleetManager(core, tmp_path / "d")
    fm._audit("fleet.refused", code="x", kind="run", run_id="r1", agent="a")
    lines = (tmp_path / "d" / "logs" / "fleet.jsonl").read_text().splitlines() if (tmp_path / "d" / "logs").exists() \
        else next((tmp_path / "d").rglob("fleet.jsonl")).read_text().splitlines()
    ev = json.loads(lines[-1])
    assert ev["kind"] == "fleet.refused"
    assert ev["data"] == {"code": "x", "req_kind": "run", "req_run_id": "r1", "req_agent": "a"}
