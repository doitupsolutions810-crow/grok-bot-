#!/bin/sh
# Launch the combined system when the sibling AVRONE checkout is available.
# The integration overlay places both APIs on a private Compose network and
# publishes AVRONE only on host loopback. Without AVRONE, run core-only unless
# LAUNCH_REQUIRE_AVRONE=true.
set -eu
AVRONE_DIR="${AVRONE_DIR:-../Avrone}"
VERIFY_BOOT_TIMEOUT_SECONDS="${VERIFY_BOOT_TIMEOUT_SECONDS:-7200}"
LAUNCH_REQUIRE_AVRONE="${LAUNCH_REQUIRE_AVRONE:-false}"
INTEGRATED=0

say() { printf '\n=== %s ===\n' "$1"; }

say "0. Preflight"
command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required"; exit 1; }
docker info >/dev/null 2>&1 || { echo "Cannot access the Docker daemon; check that Docker is running and this user has permission."; exit 1; }

if [ -d "$AVRONE_DIR" ]; then
  command -v python3 >/dev/null 2>&1 || { echo "python3 is required when AVRONE is present"; exit 1; }
  say "1. AVRONE offline test gate"
  (cd "$AVRONE_DIR" && { [ -x .venv/bin/python ] || python3 -m venv .venv; } \
    && .venv/bin/python -m pip install -q -e ".[dev]" \
    && .venv/bin/python -m pytest -q)
  INTEGRATED=1
  # Compose interpolation paths are relative to this repository; the build
  # context is configurable for CI checkouts that place AVRONE under ./Avrone.
  export AVRONE_BUILD_CONTEXT="${AVRONE_BUILD_CONTEXT:-$AVRONE_DIR}"
  export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml:docker-compose.integration.yml}"
  echo "AVRONE integration enabled on the internal Compose network."
elif [ "$LAUNCH_REQUIRE_AVRONE" = "true" ] || [ "$LAUNCH_REQUIRE_AVRONE" = "1" ]; then
  echo "AVRONE_DIR=$AVRONE_DIR was not found and LAUNCH_REQUIRE_AVRONE is enabled."
  exit 1
else
  echo "NOTE: AVRONE_DIR=$AVRONE_DIR not found — continuing in Grok Bot-only mode."
  echo "AVRONE integration is absent; do not claim the bridge is live."
fi

say "2. Start Grok Bot stack"
[ -f .env ] || cp .env.full .env
docker compose --profile full config --quiet
docker compose --profile full up -d --build

say "3. Wait for strict boot gate"
./scripts/wait-boot.sh "$VERIFY_BOOT_TIMEOUT_SECONDS"

say "4. Live tests (real inference, Docker terminal, browser, squad, and bridge when enabled)"
docker compose exec -T grok-bot node tests/live.test.js

say "5. Agents' evolution loop"
docker compose exec -T grok-bot node scripts/evolve.js

say "Launch result"
if [ "$INTEGRATED" -eq 1 ]; then
  echo "COMBINED STACK LIVE — AVRONE http://127.0.0.1:8710 · Grok Bot http://localhost:3000 · bridge http://avrone:8710 on private Compose network · EVOLVE.md in ./data"
else
  echo "GROK BOT LIVE — http://localhost:3000 · AVRONE integration absent · EVOLVE.md in ./data"
fi
