#!/bin/sh
# Sequential launch for the combined AVRONE + Grok Bot system.
# Docker first-boot verification uses the same bounded, crash-aware boot gate
# as verify.sh. Missing AVRONE remains an explicit degraded mode, never a false claim.
set -eu
AVRONE_DIR="${AVRONE_DIR:-../Avrone}"
VERIFY_BOOT_TIMEOUT_SECONDS="${VERIFY_BOOT_TIMEOUT_SECONDS:-3600}"
VERIFY_AVRONE_TIMEOUT_SECONDS="${VERIFY_AVRONE_TIMEOUT_SECONDS:-300}"
LAUNCH_REQUIRE_AVRONE="${LAUNCH_REQUIRE_AVRONE:-false}"
AVRONE_HEALTHY=0

say() { printf '\n=== %s ===\n' "$1"; }

say "0. Preflight"
command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Cannot access the Docker daemon; check that Docker is running and this user has permission."; exit 1; }

# AVRONE runs on the host, so host Ollama models (if used) are separate from
# the Compose-managed Ollama volume used by Grok Bot. Pull them only for AVRONE.
if [ -d "$AVRONE_DIR" ] && command -v ollama >/dev/null 2>&1; then
  for model in qwen2.5:3b nomic-embed-text; do
    if ! ollama list 2>/dev/null | grep -Fq "$model"; then
      say "pulling host Ollama model $model for AVRONE"
      ollama pull "$model"
    fi
  done
elif [ -d "$AVRONE_DIR" ]; then
  echo "NOTE: host Ollama CLI is unavailable; ensure AVRONE is configured for a reachable model endpoint."
fi

say "1. AVRONE (offline suite, doctor, launch)"
if [ -d "$AVRONE_DIR" ]; then
  if command -v python3 >/dev/null 2>&1; then
    (cd "$AVRONE_DIR" && { [ -x .venv/bin/python ] || python3 -m venv .venv; } \
      && .venv/bin/python -m pip install -q -e ".[dev]" \
      && .venv/bin/python -m pytest -q)
    [ -f "$AVRONE_DIR/.env" ] || cp "$AVRONE_DIR/deploy/full.env" "$AVRONE_DIR/.env"
    (cd "$AVRONE_DIR" && .venv/bin/avrone-cli doctor)
    (cd "$AVRONE_DIR" && nohup .venv/bin/avrone > /tmp/avrone.log 2>&1 &)
    echo "AVRONE process launched; waiting up to $VERIFY_AVRONE_TIMEOUT_SECONDS seconds for /api/status."
    _i=0
    while [ "$_i" -lt "$VERIFY_AVRONE_TIMEOUT_SECONDS" ]; do
      if curl --connect-timeout 2 --max-time 4 -fsS http://127.0.0.1:8710/api/status -o /tmp/avrone-status.json 2>/dev/null; then
        AVRONE_HEALTHY=1
        echo "AVRONE API ready on http://127.0.0.1:8710"
        break
      fi
      _i=$((_i + 5))
      sleep 5
    done
    if [ "$AVRONE_HEALTHY" -ne 1 ]; then
      echo "AVRONE did not become healthy; last service log:"
      tail -n 120 /tmp/avrone.log 2>/dev/null || true
      if [ "$LAUNCH_REQUIRE_AVRONE" = "true" ] || [ "$LAUNCH_REQUIRE_AVRONE" = "1" ]; then
        echo "Combined-system launch blocked by AVRONE health gate."
        exit 1
      fi
      echo "WARNING: continuing in Grok Bot-only mode; do not claim the bridge is live."
    fi
  elif [ "$LAUNCH_REQUIRE_AVRONE" = "true" ] || [ "$LAUNCH_REQUIRE_AVRONE" = "1" ]; then
    echo "python3 is required for the requested AVRONE integration."
    exit 1
  else
    echo "NOTE: python3 not found — AVRONE skipped; continuing in Grok Bot-only mode."
  fi
elif [ "$LAUNCH_REQUIRE_AVRONE" = "true" ] || [ "$LAUNCH_REQUIRE_AVRONE" = "1" ]; then
  echo "AVRONE_DIR=$AVRONE_DIR was not found and LAUNCH_REQUIRE_AVRONE is enabled."
  exit 1
else
  echo "NOTE: AVRONE_DIR=$AVRONE_DIR not found — continuing in Grok Bot-only mode."
fi

say "2. Grok Bot (full profile; strict live self-tests gate readiness)"
[ -f .env ] || cp .env.full .env
docker compose --profile full up -d --build
step "Grok Bot boot gate"
./scripts/wait-boot.sh "$VERIFY_BOOT_TIMEOUT_SECONDS"

say "3. Live tests (real inference, Docker exec, browser, squad)"
docker compose exec -T grok-bot node tests/live.test.js

say "4. Agents' evolution loop"
docker compose exec -T grok-bot node scripts/evolve.js

say "Launch result"
if [ "$AVRONE_HEALTHY" -eq 1 ]; then
  echo "SYSTEM LIVE — AVRONE http://127.0.0.1:8710 · Grok Bot http://localhost:3000 · EVOLVE.md in ./data"
else
  echo "GROK BOT LIVE — http://localhost:3000 · AVRONE integration is absent or degraded · EVOLVE.md in ./data"
fi
