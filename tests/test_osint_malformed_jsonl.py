"""OSINT metrics must tolerate damaged JSONL without losing the whole report."""
import asyncio
import json
from types import SimpleNamespace

from avrone import osint, recon


def _ctx(data_dir):
    return SimpleNamespace(
        core=SimpleNamespace(
            settings=SimpleNamespace(data_dir=str(data_dir)),
            codex=SimpleNamespace(emit=lambda *a, **k: None),
        ),
        run_id="test-run",
        name="metrics-reviewer",
        depth=0,
    )


def _run(coro):
    return asyncio.run(coro)


def test_metrics_skips_non_object_json_and_bad_event_shapes(tmp_path):
    runs = tmp_path / "runs"
    runs.mkdir()
    path = runs / "mixed.jsonl"
    records = [
        "[]",
        "null",
        json.dumps({"kind": ["not", "a", "string"], "data": {}}),
        json.dumps({"kind": "recon.dns", "data": ["not", "an", "object"]}),
        json.dumps({"kind": "recon.http", "data": {"host": "example.com"}}),
        json.dumps({"kind": recon.REFUSED_KIND, "data": {"tool": []}}),
        "{broken json",
    ]
    # Include invalid UTF-8 to exercise read_text(errors='replace') too.
    path.write_bytes(("\n".join(records) + "\n").encode() + b"\xff\n")

    out = _run(osint.t_osint_metrics(_ctx(tmp_path), {}))
    assert "recon.dns: 1" in out
    assert "recon.http: 1" in out
    assert "example.com: 1" in out
    assert "total probes: 2" in out
    assert "refused by guardrails: 1 (?: 1)" in out


def test_metrics_skips_oversized_files_and_continues_other_logs(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    runs.mkdir()
    (runs / "large.jsonl").write_text("x" * 120)
    (runs / "valid.jsonl").write_text(json.dumps({
        "kind": "recon.dns", "data": {"host": "safe.example"}
    }) + "\n")
    monkeypatch.setattr(osint, "MAX_METRIC_LOG_BYTES", 100)

    out = _run(osint.t_osint_metrics(_ctx(tmp_path), {}))
    assert "total probes: 1" in out
    assert "safe.example: 1" in out
