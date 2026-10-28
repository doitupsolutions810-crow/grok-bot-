"""ctxspawn: sub-agents spawn with a bounded, redacted ContextPack from their parent."""
import asyncio
import json
from types import SimpleNamespace

import pytest

from avrone import agentfs, ctxspawn, fsunify, memstore
from avrone.codex import Codex
from avrone.config import Settings
from avrone.ctxspawn import ContextPack, redact
from avrone.sovereign import LocalRunner
from avrone.tools import builtin_registry
from avrone.tools_extra import register_extra_tools


def run(c):
    return asyncio.run(c)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in ("AVRONE_SPAWN_CONTEXT_CHARS", "AVRONE_MAX_AGENTS_PER_RUN", "AVRONE_AGENT_FS"):
        monkeypatch.delenv(k, raising=False)


class RoleLLM:
    """Scripted replies per agent role (from the session name); records every prompt per role."""

    def __init__(self, scripts):
        self.scripts = {k: list(v) for k, v in scripts.items()}
        self.seen: dict[str, list] = {}

    async def chat(self, messages, **kw):
        name = str(kw.get("session", "")).rsplit(":", 1)[-1]
        role = name.split("-")[0]
        self.seen.setdefault(role, []).append([dict(m) for m in messages])
        q = self.scripts.get(role) or []
        return q.pop(0) if q else '{"final": "' + role + ' done"}'

    def system(self, role):
        return self.seen[role][0][0]["content"]


def call(tool, **args):
    return "```json\n" + json.dumps({"tool": tool, "args": args}) + "\n```"


def _core(tmp_path, llm, depth=2):
    from avrone.trinity import TrinityCore
    s = Settings()
    s.data_dir = tmp_path / "d"
    s.workspace = tmp_path / "ws"
    s.max_steps = 6
    s.max_spawn_depth = depth
    runner = LocalRunner(s)
    run(runner.start())
    reg = builtin_registry()
    register_extra_tools(reg)
    return TrinityCore(s, llm, runner, Codex(s.data_dir), tools=reg)


def _events(core, kind, run_id="r1"):
    return [e for e in core.codex.replay(run_id) if e["kind"] == kind]


def _spawn_event(core, role):
    return next(e for e in _events(core, "agent.spawn") if e["data"]["role"] == role)


# ------------------------------------------------------------------ modes
def test_full_pack_carries_parent_context(tmp_path):
    llm = RoleLLM({"Root": [call("write_file", path="notes.txt", content="draft one"),
                            call("spawn", role="Kid", task="check the draft", focus="grammar")]})
    core = _core(tmp_path, llm)
    memstore.MemoryStore(core.settings.data_dir / "memory.jsonl").save("root", "plan", "ship friday")
    out = run(core.run_agent("r1", "Root", "write the launch post", focus="drafting"))
    assert out == "Root done"
    sysmsg = llm.system("Kid")
    assert "Overall task from the user:\ncheck the draft" in sysmsg and "Your focus: grammar" in sysmsg
    assert "spawn context: full" in sysmsg
    assert "## Original run task\nwrite the launch post" in sysmsg
    assert "## Lineage (root -> parent)\nRoot-1" in sysmsg
    assert "role: Root" in sysmsg and "focus: drafting" in sysmsg
    assert "write_file" in sysmsg and "wrote notes.txt" in sysmsg
    assert "plan: ship friday" in sysmsg
    assert "## Files in parent agent dir\nnotes.txt" in sysmsg
    ev = _spawn_event(core, "Kid")["data"]
    assert ev["context_mode"] == "full" and ev["lineage"] == ["Root-1"] and ev["parent"] == "Root-1"
    assert 0 < ev["context_chars"] <= ctxspawn.DEFAULT_CONTEXT_CHARS and ev["share_dir"] is False
    root_ev = _spawn_event(core, "Root")["data"]
    assert root_ev["context_mode"] is None and root_ev["context_chars"] == 0 and root_ev["lineage"] == []
    # the child got its own dir derived from parent id + role
    assert (core.settings.workspace / "agents" / "root-kid").is_dir()


def test_summary_pack_is_a_digest(tmp_path):
    llm = RoleLLM({"Root": [call("write_file", path="a.txt", content="PAYLOAD-XYZ"),
                            call("spawn", role="Kid", task="t2", context="summary")]})
    core = _core(tmp_path, llm)
    run(core.run_agent("r1", "Root", "big task"))
    sysmsg = llm.system("Kid")
    assert "spawn context: summary" in sysmsg and "## Original run task\nbig task" in sysmsg
    assert "## Digest" in sysmsg and "recent tool calls (1): write_file" in sysmsg
    assert "files in parent agent dir: 1" in sysmsg
    assert "wrote a.txt" not in sysmsg and "## Files in parent agent dir" not in sysmsg
    assert _spawn_event(core, "Kid")["data"]["context_mode"] == "summary"


def test_none_pack_is_old_behaviour(tmp_path):
    llm = RoleLLM({"Root": [call("spawn", role="Kid", task="t3", context="none")]})
    core = _core(tmp_path, llm)
    run(core.run_agent("r1", "Root", "big task"))
    sysmsg = llm.system("Kid")
    assert "CONTEXT FROM YOUR PARENT" not in sysmsg and "big task" not in sysmsg
    ev = _spawn_event(core, "Kid")["data"]
    assert ev["context_mode"] == "none" and ev["context_chars"] == 0 and ev["lineage"] == ["Root-1"]


def test_bad_context_mode_is_refused(tmp_path):
    llm = RoleLLM({"Root": [call("spawn", role="Kid", task="t", context="everything")]})
    core = _core(tmp_path, llm)
    run(core.run_agent("r1", "Root", "x"))
    outs = [e["data"]["output"] for e in _events(core, "tool.result")]
    assert outs[0].startswith("ERROR: context must be one of full, summary, none")
    assert "Kid" not in llm.seen


# ------------------------------------------------------------------ lineage + depth
def test_lineage_across_three_levels_and_depth_cap(tmp_path):
    llm = RoleLLM({"Root": [call("spawn", role="Kid", task="level 1")],
                   "Kid": [call("spawn", role="Grand", task="level 2")],
                   "Grand": [call("spawn", role="Great", task="level 3")]})
    core = _core(tmp_path, llm, depth=2)
    run(core.run_agent("r1", "Root", "the root task"))
    grand = llm.system("Grand")
    assert "## Lineage (root -> parent)\nRoot-1 -> Kid-2" in grand
    assert "## Original run task\nthe root task" in grand  # run task inherited, not "level 1"
    assert _spawn_event(core, "Grand")["data"]["lineage"] == ["Root-1", "Kid-2"]
    assert _spawn_event(core, "Grand")["data"]["depth"] == 2
    # depth limit unchanged: the grandchild may not spawn
    outs = [e["data"]["output"] for e in _events(core, "tool.result") if e["agent"] == "Grand-3"]
    assert outs == ["ERROR: max sub-agent depth reached; do this part yourself."]
    assert "Great" not in llm.seen
    assert core.run_agents["r1"] == 3


def test_agent_cap_per_run(tmp_path, monkeypatch):
    monkeypatch.setenv("AVRONE_MAX_AGENTS_PER_RUN", "2")
    llm = RoleLLM({"Root": [call("spawn", role="Kid", task="a"), call("spawn", role="Kid", task="b")]})
    core = _core(tmp_path, llm)
    run(core.run_agent("r1", "Root", "x"))
    outs = [e["data"]["output"] for e in _events(core, "tool.result") if e["agent"] == "Root-1"]
    assert outs[0] == "Kid done"
    assert outs[1].startswith("ERROR: agent cap reached for this run (2/2, AVRONE_MAX_AGENTS_PER_RUN)")
    assert len(_events(core, "agent.spawn")) == 2
    # another run has its own budget
    assert core.run_agents.get("r2", 0) == 0


def test_cap_env_clamps(monkeypatch):
    assert ctxspawn.max_agents_per_run() == 64 and ctxspawn.context_chars() == 12000
    monkeypatch.setenv("AVRONE_MAX_AGENTS_PER_RUN", "0")
    assert ctxspawn.max_agents_per_run() == 1
    monkeypatch.setenv("AVRONE_SPAWN_CONTEXT_CHARS", "999999")
    assert ctxspawn.context_chars() == 64000
    monkeypatch.setenv("AVRONE_SPAWN_CONTEXT_CHARS", "junk")
    assert ctxspawn.context_chars() == 12000


# ------------------------------------------------------------------ truncation
def _big_pack():
    return ContextPack("full", "TASK-" + "t" * 50, ["Root-1", "Kid-2"], [
        ("Parent", "P" * 100), ("Squad siblings", "S" * 300), ("Recent", "R" * 300), ("Files", "F" * 50)])


def test_truncation_keeps_task_and_lineage_first():
    pack = _big_pack()
    full = pack.render(10000)
    assert full.index("TASK-") < full.index("Root-1 -> Kid-2") < full.index("## Parent") < full.index("## Recent")
    out = pack.render(420)
    assert len(out) <= 420 and out == pack.render(420)  # deterministic
    assert "TASK-" in out and "Root-1 -> Kid-2" in out and "## Parent\n" + "P" * 100 in out
    assert "## Squad siblings" in out and ctxspawn.TRUNC in out  # the section that overflowed is cut
    assert "## Recent" not in out and "## Files" not in out
    # tiny cap: only the head survives, and it starts with the task
    tiny = pack.render(100)
    assert len(tiny) <= 100 and "TASK-" in tiny and tiny.endswith(ctxspawn.TRUNC)


def test_truncation_drop_note_and_env_cap(tmp_path, monkeypatch):
    pack = ContextPack("full", "T", ["A"], [("One", "1" * 50), ("Two", "2" * 5000), ("Three", "3")])
    out = pack.render(2000)
    assert "## One" in out and "## Three" not in out and len(out) <= 2000
    assert ctxspawn.TRUNC in out and out.endswith("[context truncated; dropped: Three]\n")
    pack2 = ContextPack("full", "T", ["A"], [("Big", "x" * 5000), ("Small", "y")])
    monkeypatch.setenv("AVRONE_SPAWN_CONTEXT_CHARS", "300")
    assert len(pack2.render()) <= 300
    # a section too big to even start is dropped and named
    pack3 = ContextPack("full", "T" * 50, ["A"], [("Xsection", "x" * 500), ("Y", "y")])
    head = ContextPack("full", "T" * 50, ["A"]).render(10000)
    assert pack3.render(len(head) + 25) == head  # no room to cut usefully, nor for the note
    out3 = pack3.render(len(head) + 50)  # room for a cut piece but not cut + note
    assert "## Xsection\nx" in out3 and out3.endswith(ctxspawn.TRUNC + "\n") and len(out3) <= len(head) + 50
    out4 = pack3.render(len(head) + 90)
    assert out4.endswith("[context truncated; dropped: Y]\n") and len(out4) <= len(head) + 90
    assert ContextPack("none", "T", []).render() == ""


def test_full_pack_respects_cap_in_spawn(tmp_path, monkeypatch):
    monkeypatch.setenv("AVRONE_SPAWN_CONTEXT_CHARS", "400")
    llm = RoleLLM({"Root": [call("write_file", path="n.txt", content="z" * 3000),
                            call("read_file", path="n.txt"),
                            call("spawn", role="Kid", task="t")]})
    core = _core(tmp_path, llm)
    run(core.run_agent("r1", "Root", "capped task"))
    ev = _spawn_event(core, "Kid")["data"]
    assert ev["context_chars"] <= 400
    assert "## Original run task\ncapped task" in llm.system("Kid")


# ------------------------------------------------------------------ redaction
def test_redact_shapes(monkeypatch):
    monkeypatch.setenv("MYSVC_TOKEN", "plainvalue-123456")
    cases = [
        "Authorization: Bearer abcdefghijklmnop",
        "curl -H 'authorization: Basic dXNlcjpwYXNz'",
        "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
        '{"api_key": "hunter2hunter2"}',
        "export DB_PASSWORD='p@ss w0rd'",
        "token ghp_abcdefghijklmnopqrstuvwxyz0123",
        "aws AKIAABCDEFGHIJKLMNOP",
        "the value plainvalue-123456 leaked",
        "jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4fw",
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
        "https://user:pa55@example.com/x",
    ]
    secrets = ["abcdefghijklmnop", "dXNlcjpwYXNz", "sk-abcdefghij", "hunter2", "p@ss", "ghp_abc",
               "AKIAABCD", "plainvalue-123456", "eyJhbGci", "MIIEow", "pa55"]
    for text, secret in zip(cases, secrets):
        out = redact(text)
        assert secret not in out, (text, out)
    assert redact("Authorization: Bearer abcdefghijklmnop") == "Authorization: Bearer [REDACTED]"
    assert redact("nothing secret here: monkey=1") == "nothing secret here: monkey=1"
    assert redact(None) == ""


def test_pack_is_redacted_end_to_end(tmp_path, monkeypatch):
    monkeypatch.setenv("SERVICE_SECRET", "s3cr3t-value-zz")
    llm = RoleLLM({"Root": [call("write_file", path="cfg.env",
                                 content="SERVICE_SECRET=s3cr3t-value-zz\nAuthorization: Bearer qwertyuiopasdfgh"),
                            call("read_file", path="cfg.env"),
                            call("spawn", role="Kid", task="t")]})
    core = _core(tmp_path, llm)
    run(core.run_agent("r1", "Root", "deploy with token sk-zzzzzzzzzzzzzzzzzzzzzz"))
    sysmsg = llm.system("Kid")
    assert "read_file" in sysmsg and "[REDACTED]" in sysmsg
    for s in ("s3cr3t-value-zz", "qwertyuiopasdfgh", "sk-zzzzzzzz"):
        assert s not in sysmsg


# ------------------------------------------------------------------ squad siblings
def test_squad_siblings_in_pack(tmp_path):
    from avrone.trinity import TrinityCore  # noqa: F401
    llm = RoleLLM({"Root": [call("spawn", role="Kid", task="t")]})
    core = _core(tmp_path, llm)
    core.squad_roles["r1"] = [{"role": "Root", "focus": "angle A"}, {"role": "Critic", "focus": "angle B"}]
    run(core.run_agent("r1", "Root", "x"))
    assert "## Squad siblings\n- Root: angle A\n- Critic: angle B" in llm.system("Kid")


def test_squad_records_and_clears_roles(tmp_path):
    seen = {}

    class SquadLLM:
        async def chat(self, messages, **kw):
            sess = str(kw.get("session", ""))
            if kw.get("lead"):
                return "FINAL"
            if sess.endswith(":planner"):
                return json.dumps({"subtasks": [{"role": "Alpha", "focus": "fa"}, {"role": "Beta", "focus": "fb"}]})
            if ":Alpha-" in sess and "Alpha" not in seen:
                seen["Alpha"] = True
                return call("spawn", role="Kid", task="sub")
            if ":Kid-" in sess:
                seen["kid_prompt"] = messages[0]["content"]
            return '{"final": "ok"}'

    core = _core(tmp_path, SquadLLM())
    res = run(core.squad("build it", n=2, run_id="sq1"))
    assert res["answer"] == "FINAL"
    assert "## Squad siblings\n- Alpha: fa\n- Beta: fb" in seen["kid_prompt"]
    assert core.squad_roles == {}


# ------------------------------------------------------------------ share_dir
@pytest.fixture()
def fsenv(tmp_path):
    s = Settings(workspace=tmp_path / "ws", data_dir=tmp_path / "data")
    runner = LocalRunner(s)
    run(runner.start())
    core = SimpleNamespace(settings=s, runner=runner, codex=Codex(s.data_dir))
    pdir = agentfs.agent_dir(s.workspace, "root")
    (pdir / "sub").mkdir(parents=True, exist_ok=True)
    (pdir / "sub" / "plan.md").write_text("parent plan")
    (s.workspace / "agents" / "other").mkdir(parents=True, exist_ok=True)
    (s.workspace / "agents" / "other" / "x.txt").write_text("other agent")
    cdir = agentfs.agent_dir(s.workspace, "root-kid")
    child = SimpleNamespace(core=core, run_id="r1", name="Kid-2", depth=1, agent_id="root-kid",
                            agent_dir=cdir, parent_dir=pdir)
    plain = SimpleNamespace(core=core, run_id="r1", name="Kid-3", depth=1, agent_id="root-kid",
                            agent_dir=cdir)
    reg = builtin_registry()
    register_extra_tools(reg)
    return SimpleNamespace(core=core, child=child, plain=plain, reg=reg, pdir=pdir, cdir=cdir)


def _c(env, ctx, tool, **args):
    return run(env.reg.call(ctx, tool, args))


def test_share_dir_reads_parent(fsenv):
    assert _c(fsenv, fsenv.child, "read_file", path="parent/sub/plan.md") == "parent plan"
    listing = _c(fsenv, fsenv.child, "list_files", path="parent")
    assert listing.splitlines()[0] == "parent/" and "plan.md" in listing
    assert "parent/sub/plan.md" in _c(fsenv, fsenv.child, "search_files", pattern="plan", path="parent")
    _c(fsenv, fsenv.child, "write_file", path="mine.md", content="parent plan v2")
    assert "plan v2" in _c(fsenv, fsenv.child, "diff_files", path_a="parent/sub/plan.md", path_b="mine.md")


def test_share_dir_is_read_only_and_confined(fsenv):
    out = _c(fsenv, fsenv.child, "write_file", path="parent/evil.txt", content="x")
    assert out.startswith("ERROR") and "read-only" in out
    assert not (fsenv.pdir / "evil.txt").exists()
    out = _c(fsenv, fsenv.child, "edit_file", path="parent/sub/plan.md", old="parent", new="hacked")
    assert out.startswith("ERROR") and "read-only" in out
    assert (fsenv.pdir / "sub" / "plan.md").read_text() == "parent plan"
    for bad in ("parent/../other/x.txt", "parent//etc/passwd", "parent/../../agents/other/x.txt"):
        out = _c(fsenv, fsenv.child, "read_file", path=bad)
        assert out.startswith("ERROR") and "other agent" not in out, bad
    (fsenv.pdir / "link").symlink_to(fsenv.pdir.parent / "other")
    out = _c(fsenv, fsenv.child, "read_file", path="parent/link/x.txt")
    assert out.startswith("ERROR") and "escapes" in out
    denied = [e for e in fsenv.core.codex.replay("r1") if e["kind"] == "agentfs.denied"]
    assert denied and denied[0]["data"]["tool"] == "write_file"


def test_without_share_dir_parent_prefix_is_own_dir(fsenv):
    assert "not found" in _c(fsenv, fsenv.plain, "read_file", path="parent/sub/plan.md")
    assert _c(fsenv, fsenv.plain, "write_file", path="parent/own.txt", content="hi").startswith("wrote parent/own.txt")
    assert (fsenv.cdir / "parent" / "own.txt").exists()
    assert fsunify.parent_root(fsenv.plain) is None


def test_spawn_share_dir_wires_parent_dir(tmp_path):
    llm = RoleLLM({"Root": [call("write_file", path="shared-note.md", content="from root"),
                            call("spawn", role="Kid", task="t", share_dir=True)],
                   "Kid": [call("read_file", path="parent/shared-note.md"),
                           call("write_file", path="parent/no.md", content="x")]})
    core = _core(tmp_path, llm)
    run(core.run_agent("r1", "Root", "x"))
    assert _spawn_event(core, "Kid")["data"]["share_dir"] is True
    assert "under the `parent/` prefix" in llm.system("Kid")
    outs = [e["data"]["output"] for e in _events(core, "tool.result") if e["agent"] == "Kid-2"]
    assert outs[0] == "from root" and "read-only" in outs[1]
    assert not (core.settings.workspace / "agents" / "root" / "no.md").exists()


def test_child_agent_id_sanitized():
    ctx = SimpleNamespace(agent_id="root", name="Root-1")
    assert ctxspawn.child_agent_id(ctx, "Code Reviewer/../x") == "root-code-reviewer-x"
    assert ctxspawn.child_agent_id(SimpleNamespace(agent_id=None, name="Lead-4"), "Kid") == "lead-4-kid"


def test_recent_calls_ring_is_bounded(tmp_path):
    llm = RoleLLM({"Root": [call("think", thought=f"t{i}") for i in range(12)]})
    core = _core(tmp_path, llm)
    core.settings.max_steps = 14
    from avrone.trinity import AgentContext
    ctx = AgentContext(core, "r1", "Root-1", 0)
    assert ctx.recent_calls.maxlen == ctxspawn.RECENT_CALLS
    for i in range(20):
        ctx.recent_calls.append(("think", {"thought": i}, "ok"))
    assert len(ctx.recent_calls) == ctxspawn.RECENT_CALLS
    assert ctx.recent_calls[0][1] == {"thought": 12}


# ------------------------------------------------------------------ edges
def test_share_dir_ignored_without_agent_fs(tmp_path, monkeypatch):
    monkeypatch.setenv("AVRONE_AGENT_FS", "0")
    llm = RoleLLM({"Root": [call("spawn", role="Kid", task="t", share_dir=True)]})
    core = _core(tmp_path, llm)
    run(core.run_agent("r1", "Root", "x"))
    ev = _spawn_event(core, "Kid")["data"]
    assert ev["share_dir"] is False and ev["context_mode"] == "full"
    assert "## Files in parent agent dir" not in llm.system("Kid")


def test_memory_and_file_sections_are_redacted_and_bounded(tmp_path):
    llm = RoleLLM({"Root": [call("spawn", role="Kid", task="t")]})
    core = _core(tmp_path, llm)
    store = memstore.MemoryStore(core.settings.data_dir / "memory.jsonl")
    store.save("root", "creds", "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123")
    for i in range(30):
        store.save("root", f"k{i:02d}", "v" * 1000)
    d = agentfs.agent_dir(core.settings.workspace, "root")
    for i in range(60):
        (d / f"f{i:02d}.txt").write_text("x")
    run(core.run_agent("r1", "Root", "x"))
    sysmsg = llm.system("Kid")
    assert "ghp_abc" not in sysmsg
    mem = sysmsg.split("## Parent memory (read-only snapshot)\n")[1].split("\n## ")[0]
    assert len([ln for ln in mem.splitlines() if ln.startswith("- ")]) == ctxspawn.MEMORY_ENTRIES
    assert "- k29:" in mem and "- k00:" not in mem  # newest first
    files = sysmsg.split("## Files in parent agent dir\n")[1].splitlines()
    assert files[ctxspawn.DIR_FILES] == "..." and len(files) <= ctxspawn.DIR_FILES + 2


def test_spawn_tool_schema_accepts_new_args():
    r = builtin_registry()
    assert r.check("spawn", {"task": "t", "context": "summary", "focus": "f", "share_dir": True}) is None
    assert r.check("spawn", {"task": "t", "share_dir": "yes"})[0] == "bad_args"
    assert "share_dir" in r.get("spawn").args_doc
