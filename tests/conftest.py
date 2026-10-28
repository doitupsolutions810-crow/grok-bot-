# Set test env before any avrone module (and its global Settings) is imported.
import os

os.environ["AVRONE_LLM_MODE"] = "mock"
os.environ["AVRONE_RUNNER"] = "local"
os.environ["AVRONE_ADMIN_TOKEN"] = "test-token"
# The health governor reads real host sensors; keep the suite deterministic on a busy CI box.
# tests/test_governor.py turns it on explicitly with injected (fake) readers.
os.environ.setdefault("AVRONE_GOVERNOR", "off")
# The learning bridge's cross-examination round and lessons injection change squad LLM traffic;
# keep the classic squad for the suite. tests/test_bridge.py turns them on explicitly.
os.environ.setdefault("AVRONE_BRIDGE_ROUNDS", "0")
os.environ.setdefault("AVRONE_LESSONS", "off")
os.environ.setdefault("NO_PROXY", "127.0.0.1,localhost")
os.environ.setdefault("no_proxy", "127.0.0.1,localhost")
