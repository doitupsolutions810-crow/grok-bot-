"""AVRONE configuration, read from environment variables (or a .env file).

Settings() reads the environment when it is constructed, so tests and the CLI
can change env vars and build a fresh Settings.
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass, field
from pathlib import Path


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.split(" #", 1)[0]  # allow trailing comments
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv(Path(os.getenv("AVRONE_ENV_FILE", ".env")))


# ------------------------------------------------------------ provider presets
# name -> (base_url, default model, env var holding that provider's key)
PROVIDERS: dict[str, tuple[str, str, str]] = {
    "openclaw": ("http://127.0.0.1:18789/v1", "openclaw", "OPENCLAW_GATEWAY_TOKEN"),
    "xai": ("https://api.x.ai/v1", "grok-4", "XAI_API_KEY"),
    "openai": ("https://api.openai.com/v1", "gpt-4.1", "OPENAI_API_KEY"),
    "openrouter": ("https://openrouter.ai/api/v1", "x-ai/grok-4", "OPENROUTER_API_KEY"),
    "ollama": ("http://127.0.0.1:11434/v1", "llama3.1", ""),
    "custom": ("", "default", ""),
}


def resolve_provider(provider: str | None, base_url: str | None = None, model: str | None = None,
                     api_key: str | None = None, env: dict[str, str] | None = None) -> tuple[str, str, str, str]:
    """Return (provider, base_url, model, api_key). Explicit values override the preset.

    An empty api key is allowed (a proxy may inject auth, or the backend needs none).
    """
    env = os.environ if env is None else env
    name = (provider or "openclaw").strip().lower()
    if name not in PROVIDERS:
        raise ValueError(f"Unknown AVRONE_PROVIDER {provider!r}. Choose one of: {', '.join(PROVIDERS)}")
    p_url, p_model, key_env = PROVIDERS[name]
    url = base_url or p_url
    if not url:
        raise ValueError("AVRONE_PROVIDER=custom needs AVRONE_LLM_BASE_URL")
    key = api_key if api_key else (env.get(key_env, "") if key_env else "")
    return name, url, model or p_model, key


def _env(name: str, default: str = ""):
    return lambda: os.getenv(name, default)


def _int(name: str, default: int, minimum: int = 0):
    """Read a non-negative integer setting without letting bad env text crash boot."""
    def read() -> int:
        try:
            value = int(os.getenv(name, str(default)).strip())
        except (TypeError, ValueError, OverflowError):
            return default
        return value if value >= minimum else default
    return read


def _float(name: str, default: float, minimum: float = 0.0):
    """Read finite numeric settings; reject NaN, infinities, and negative durations."""
    def read() -> float:
        try:
            value = float(os.getenv(name, str(default)).strip())
        except (TypeError, ValueError, OverflowError):
            return default
        return value if math.isfinite(value) and value >= minimum else default
    return read


def _bool(name: str, default: bool):
    return lambda: os.getenv(name, str(default)).lower() in {"1", "true", "yes", "on"}


def _path(name: str, default: str):
    return lambda: Path(os.getenv(name, default)).resolve()


@dataclass
class Settings:
    # --- Model backend (OpenAI-compatible). Default: a local OpenClaw Gateway. ---
    # openclaw | xai | openai | openrouter | ollama | custom
    provider: str = field(default_factory=_env("AVRONE_PROVIDER", "openclaw"))
    # Empty = take from the provider preset. Explicit env values override the preset.
    llm_base_url: str = field(default_factory=_env("AVRONE_LLM_BASE_URL"))
    llm_api_key: str = field(default_factory=_env("AVRONE_LLM_API_KEY"))
    llm_model: str = field(default_factory=_env("AVRONE_LLM_MODEL"))
    # Optional: a different model for the Lead (synthesizer) agents, e.g. a stronger one.
    lead_model: str = field(default_factory=_env("AVRONE_LEAD_MODEL"))
    # "mock" runs without any model, for demos and tests.
    llm_mode: str = field(default_factory=_env("AVRONE_LLM_MODE", "live"))
    llm_timeout: float = field(default_factory=_float("AVRONE_LLM_TIMEOUT", 180))
    llm_retries: int = field(default_factory=_int("AVRONE_LLM_RETRIES", 3))  # total tries on 429/5xx
    llm_backoff: float = field(default_factory=_float("AVRONE_LLM_BACKOFF", 1.0))  # seconds, doubles per try
    # --- Gateway: extra providers tried in order when the primary fails ---
    llm_fallbacks: str = field(default_factory=_env("AVRONE_LLM_FALLBACKS"))  # e.g. "openrouter:x-ai/grok-4,ollama:llama3.1"
    breaker_threshold: int = field(default_factory=_int("AVRONE_BREAKER_THRESHOLD", 3, 1))
    breaker_cooldown: float = field(default_factory=_float("AVRONE_BREAKER_COOLDOWN", 30))

    # --- Orchestration (Grok Heavy style squad) ---
    squad_size: int = field(default_factory=_int("AVRONE_SQUAD_SIZE", 4, 1))
    deep_squad_size: int = field(default_factory=_int("AVRONE_DEEP_SQUAD_SIZE", 4, 1))
    max_parallel: int = field(default_factory=_int("AVRONE_MAX_PARALLEL", 6, 1))  # concurrent LLM calls
    max_steps: int = field(default_factory=_int("AVRONE_MAX_STEPS", 6, 1))
    max_spawn_depth: int = field(default_factory=_int("AVRONE_MAX_SPAWN_DEPTH", 2))
    # Wall-clock cap (seconds) on one agent's whole run; 0 = no cap. A worker that hits it is
    # reported as timed out and the squad merges the others instead of waiting forever.
    agent_timeout: float = field(default_factory=_float("AVRONE_AGENT_TIMEOUT", 0))
    # --- Health / thermal governor (avrone/governor.py): fewer parallel workers on a hot,
    # loaded or low-memory node. Advisory: never below min_parallel (>= 1).
    governor: bool = field(default_factory=_bool("AVRONE_GOVERNOR", True))
    min_parallel: int = field(default_factory=_int("AVRONE_MIN_PARALLEL", 1, 1))
    thermal_max_c: float = field(default_factory=_float("AVRONE_THERMAL_MAX_C", 85, 1.0))

    # --- Environment (Sovereign OS layer) ---
    workspace: Path = field(default_factory=_path("AVRONE_WORKSPACE", "./workspace"))
    runner: str = field(default_factory=_env("AVRONE_RUNNER", "auto"))  # auto | docker | local
    docker_image: str = field(default_factory=_env("AVRONE_DOCKER_IMAGE", "python:3.12-slim"))
    allow_network: bool = field(default_factory=_bool("AVRONE_ALLOW_NETWORK", True))
    command_timeout: int = field(default_factory=_int("AVRONE_COMMAND_TIMEOUT", 120, 1))

    # --- Access control ---
    admin_token: str = field(default_factory=_env("AVRONE_ADMIN_TOKEN"))
    agents_can_shell: bool = field(default_factory=_bool("AVRONE_AGENTS_CAN_SHELL", True))

    # --- Eternal CodeX (persistent logs and memory) ---
    data_dir: Path = field(default_factory=_path("AVRONE_DATA_DIR", "./data"))

    def __post_init__(self) -> None:
        self.provider, self.llm_base_url, self.llm_model, self.llm_api_key = resolve_provider(
            self.provider, self.llm_base_url, self.llm_model, self.llm_api_key)


settings = Settings()
