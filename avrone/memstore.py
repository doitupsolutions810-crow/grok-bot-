"""Durable per-agent memory namespaces (Eternal CodeX memory store).

One append-only JSONL file (``<data_dir>/memory.jsonl``), the same file the original
memory_save/memory_recall tools used. Every record now carries ``ns``, the namespace it
belongs to, so each agent has its own isolated key space that reloads from disk on restart.

Namespaces
  - a local agent's namespace is its *agent id*: the agent name with the per-process
    counter suffix removed and lower-cased (``Builder-3`` -> ``builder``), so it is stable
    across restarts. An embedder may pin one explicitly with ``ctx.memory_namespace``.
    Local namespaces match ``[a-z0-9][a-z0-9_-]{0,62}``: they can never contain ':'.
  - memory merged in from another fleet node lives under ``fleet:<sender-node>/<ns>``;
    the ':' guarantees it can never collide with (overwrite) a local namespace.
  - legacy records written before namespaces existed (no ``ns``) are read into the
    namespace derived from their ``agent`` field.

Caps (env knobs, each clamped to a hard ceiling so a bad value can't disable the limit)
  AVRONE_MEMORY_MAX_ENTRIES     live keys per namespace (default 500, hard cap 5000);
                                saving a NEW key into a full namespace evicts its oldest key
  AVRONE_MEMORY_MAX_VALUE       bytes per value, UTF-8 (default 8192, hard cap 65536); larger
                                values are refused, never silently truncated
  AVRONE_MEMORY_MAX_NAMESPACES  namespaces per store (default 256, hard cap 4096); a save that
                                would create one more is refused
Keys are capped at 200 characters.

Concurrency: every mutation holds an in-process lock for the file *and* an exclusive
``fcntl.flock`` on ``memory.jsonl.lock`` (cross-process). Appends are single ``write`` calls
under that lock; compaction / eviction rewrites go to a temp file, fsync, then ``os.replace``,
so a crash mid-write leaves either the old or the new file, never a torn one.
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

try:  # POSIX only; on other platforms the in-process lock still serialises writers
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None  # type: ignore[assignment]

NS_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")
REMOTE_PREFIX = "fleet:"
MAX_KEY = 200

DEFAULT_MAX_ENTRIES, HARD_MAX_ENTRIES = 500, 5000
DEFAULT_MAX_VALUE, HARD_MAX_VALUE = 8192, 65536
DEFAULT_MAX_NAMESPACES, HARD_MAX_NAMESPACES = 256, 4096

_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _cap(env: str, default: int, hard: int) -> int:
    try:
        n = int(os.getenv(env, "").strip() or default)
    except ValueError:
        n = default
    return max(1, min(hard, n))


def max_entries() -> int:
    return _cap("AVRONE_MEMORY_MAX_ENTRIES", DEFAULT_MAX_ENTRIES, HARD_MAX_ENTRIES)


def max_value() -> int:
    return _cap("AVRONE_MEMORY_MAX_VALUE", DEFAULT_MAX_VALUE, HARD_MAX_VALUE)


def max_namespaces() -> int:
    return _cap("AVRONE_MEMORY_MAX_NAMESPACES", DEFAULT_MAX_NAMESPACES, HARD_MAX_NAMESPACES)


def agent_namespace(name: Any) -> str:
    """Stable local namespace for an agent name: counter suffix stripped, lower-cased, sanitised."""
    base = re.sub(r"-\d+$", "", str(name or "").strip())
    ns = re.sub(r"[^a-z0-9_-]", "", base.lower().replace(" ", "-")).lstrip("-_")[:63]
    return ns if NS_RE.match(ns) else "agent"


def remote_namespace(sender: str, ns: str) -> str:
    return f"{REMOTE_PREFIX}{sender}/{ns}"


def is_local(ns: str) -> bool:
    return bool(NS_RE.match(ns))


class MemoryRefused(ValueError):
    """A save refused by a cap or a bad key/namespace."""


class MemoryStore:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock_path = self.path.with_name(self.path.name + ".lock")
        with _LOCKS_GUARD:
            self._tlock = _LOCKS.setdefault(str(self.path.resolve()), threading.Lock())

    # ------------------------------------------------------------ locking / io
    @contextmanager
    def _locked(self) -> Iterator[None]:
        with self._tlock:
            fh = open(self.lock_path, "a+")
            try:
                if fcntl is not None:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
                yield
            finally:
                if fcntl is not None:
                    fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
                fh.close()

    def _records(self) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        out = []
        for line in self.path.read_text(errors="replace").splitlines():
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(rec, dict) and "key" in rec:
                if not isinstance(rec.get("ns"), str) or not rec["ns"]:
                    rec["ns"] = agent_namespace(rec.get("agent"))
                out.append(rec)
        return out

    @staticmethod
    def _fold(records: list[dict[str, Any]]) -> dict[str, dict[str, dict[str, Any]]]:
        spaces: dict[str, dict[str, dict[str, Any]]] = {}
        for rec in records:
            spaces.setdefault(rec["ns"], {})[str(rec["key"])] = rec
        return spaces

    def _append(self, recs: list[dict[str, Any]]) -> None:
        data = "".join(json.dumps(r) + "\n" for r in recs)
        # A crash mid-append can leave a torn last line with no newline; appending straight
        # onto it would glue the new record to the torn one and lose both. Start a fresh line.
        try:
            with self.path.open("rb") as f:
                f.seek(0, os.SEEK_END)
                if f.tell() > 0:
                    f.seek(-1, os.SEEK_END)
                    if f.read(1) != b"\n":
                        data = "\n" + data
        except FileNotFoundError:
            pass
        with self.path.open("a") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())

    def _rewrite(self, spaces: dict[str, dict[str, dict[str, Any]]]) -> None:
        recs = sorted((r for ns in spaces.values() for r in ns.values()), key=lambda r: r.get("ts", 0))
        tmp = self.path.with_name(f".{self.path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        with tmp.open("w") as f:
            f.write("".join(json.dumps(r) + "\n" for r in recs))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    # ------------------------------------------------------------ reads
    def namespaces(self) -> dict[str, dict[str, dict[str, Any]]]:
        """Every namespace -> {key: latest record}."""
        return self._fold(self._records())

    def load(self, ns: str) -> dict[str, dict[str, Any]]:
        return self.namespaces().get(ns, {})

    # ------------------------------------------------------------ writes
    def _check(self, ns: str, key: str, value: str) -> None:
        if not key:
            raise MemoryRefused("key is required")
        if len(key) > MAX_KEY:
            raise MemoryRefused(f"key longer than {MAX_KEY} characters")
        size = len(value.encode())
        if size > max_value():
            raise MemoryRefused(f"value is {size} bytes; cap is {max_value()} (AVRONE_MEMORY_MAX_VALUE)")
        if not ns:
            raise MemoryRefused("namespace is required")

    def _put_locked(self, spaces: dict[str, dict[str, dict[str, Any]]], rec: dict[str, Any],
                    pending: list[dict[str, Any]]) -> bool:
        """Apply one record to the folded view; returns True when the file must be rewritten
        (an eviction happened). Raises MemoryRefused on the namespace cap."""
        ns, key = rec["ns"], rec["key"]
        if ns not in spaces and len(spaces) >= max_namespaces():
            raise MemoryRefused(f"namespace cap reached ({max_namespaces()}, AVRONE_MEMORY_MAX_NAMESPACES)")
        space = spaces.setdefault(ns, {})
        evicted = False
        if key not in space:
            while len(space) >= max_entries():
                oldest = min(space, key=lambda k: space[k].get("ts", 0))
                del space[oldest]
                evicted = True
        space[key] = rec
        pending.append(rec)
        return evicted

    def _commit(self, records: list[dict[str, Any]], spaces: dict[str, dict[str, dict[str, Any]]],
                pending: list[dict[str, Any]], evicted: bool) -> None:
        live = sum(len(v) for v in spaces.values())
        if evicted or len(records) + len(pending) > max(256, 4 * live):
            self._rewrite(spaces)  # atomic compaction: drops superseded + evicted records
        elif pending:
            self._append(pending)

    def save(self, ns: str, key: str, value: str, **meta: Any) -> dict[str, Any]:
        key, value = str(key).strip(), str(value)
        self._check(ns, key, value)
        rec = {"ns": ns, "key": key, "value": value, "ts": time.time(), **meta}
        with self._locked():
            records = self._records()
            spaces = self._fold(records)
            pending: list[dict[str, Any]] = []
            evicted = self._put_locked(spaces, rec, pending)
            self._commit(records, spaces, pending, evicted)
        return rec

    def merge(self, ns: str, entries: list[dict[str, Any]], **meta: Any) -> dict[str, int]:
        """Last-writer-wins merge of foreign entries into `ns` (by their own ts). Entries that are
        older than or equal to what `ns` already holds are skipped; oversize/bad ones are rejected."""
        stats = {"merged": 0, "skipped": 0, "rejected": 0}
        with self._locked():
            records = self._records()
            spaces = self._fold(records)
            pending: list[dict[str, Any]] = []
            evicted = False
            for e in entries:
                key, value = str(e.get("key", "")).strip(), str(e.get("value", ""))
                try:
                    ts = float(e.get("ts", 0))
                    self._check(ns, key, value)
                except (TypeError, ValueError):
                    stats["rejected"] += 1
                    continue
                have = spaces.get(ns, {}).get(key)
                if have is not None and float(have.get("ts", 0)) >= ts:
                    stats["skipped"] += 1
                    continue
                rec = {"ns": ns, "key": key, "value": value, "ts": ts, **meta}
                if e.get("agent"):
                    rec["agent"] = str(e["agent"])[:100]
                try:
                    evicted = self._put_locked(spaces, rec, pending) or evicted
                except MemoryRefused:
                    stats["rejected"] += 1
                    continue
                stats["merged"] += 1
            self._commit(records, spaces, pending, evicted)
        return stats

    def trim(self, ns: str, keep: int) -> int:
        """Drop the oldest keys of `ns` until at most `keep` remain (atomic rewrite).
        Returns how many keys were evicted."""
        keep = max(0, int(keep))
        with self._locked():
            spaces = self._fold(self._records())
            space = spaces.get(ns, {})
            extra = len(space) - keep
            if extra <= 0:
                return 0
            for key in sorted(space, key=lambda k: space[k].get("ts", 0))[:extra]:
                del space[key]
            self._rewrite(spaces)
        return extra
