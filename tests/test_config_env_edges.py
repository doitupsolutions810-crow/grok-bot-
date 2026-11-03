"""Regression tests for malformed numeric environment variables at boot."""
from avrone.config import Settings


def _fresh_settings(monkeypatch):
    # Keep provider resolution deterministic even on developer machines with .env files.
    monkeypatch.setenv("AVRONE_PROVIDER", "ollama")
    monkeypatch.setenv("AVRONE_LLM_BASE_URL", "")
    monkeypatch.setenv("AVRONE_LLM_MODEL", "")
    monkeypatch.setenv("AVRONE_LLM_API_KEY", "")
    return Settings()


def test_invalid_and_non_finite_numbers_fall_back_safely(monkeypatch):
    monkeypatch.setenv("AVRONE_MAX_PARALLEL", "not-a-number")
    monkeypatch.setenv("AVRONE_LLM_TIMEOUT", "nan")
    monkeypatch.setenv("AVRONE_AGENT_TIMEOUT", "-9")
    monkeypatch.setenv("AVRONE_COMMAND_TIMEOUT", "-1")
    monkeypatch.setenv("AVRONE_THERMAL_MAX_C", "inf")
    settings = _fresh_settings(monkeypatch)

    assert settings.max_parallel == 6
    assert settings.llm_timeout == 180
    assert settings.agent_timeout == 0
    assert settings.command_timeout == 120
    assert settings.thermal_max_c == 85


def test_zero_is_clamped_for_required_counts_but_kept_for_optional_agent_deadline(monkeypatch):
    monkeypatch.setenv("AVRONE_SQUAD_SIZE", "0")
    monkeypatch.setenv("AVRONE_MAX_STEPS", "0")
    monkeypatch.setenv("AVRONE_MIN_PARALLEL", "0")
    monkeypatch.setenv("AVRONE_AGENT_TIMEOUT", "0")
    settings = _fresh_settings(monkeypatch)

    assert settings.squad_size == 4
    assert settings.max_steps == 6
    assert settings.min_parallel == 1
    # Zero is documented to mean no per-agent deadline; higher-level evolution budgets remain bounded.
    assert settings.agent_timeout == 0
