#!/bin/sh
# Local, GitHub-independent verification for the self-hosted Grok Bot stack.
# When a sibling AVRONE checkout exists, verification runs the integrated stack
# and requires the bridge live test; otherwise the report explicitly says partial.
set -u

REPORT="data/VERIFY.md"
AVRONE_DIR="${AVRONE_DIR:-../Avrone}"
VERIFY_REQUIRE_AVRONE="${VERIFY_REQUIRE_AVRONE:-false}"
FAILED=0
SKIPPED=0
mkdir -p data

if [ -d "$AVRONE_DIR" ]; then
  export AVRONE_BUILD_CONTEXT="${AVRONE_BUILD_CONTEXT:-$AVRONE_DIR}"
  export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml:docker-compose.integration.yml}"
  VERIFY_REQUIRE_AVRONE=true
fi

{
  echo "# Verify — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo ""
  echo "Local verification; no GitHub Actions runner is required."
  echo ""
  echo "- Boot timeout: ${VERIFY_BOOT_TIMEOUT_SECONDS:-7200}s"
  echo "- Require adjacent AVRONE repository: $VERIFY_REQUIRE_AVRONE"
  echo "- Compose files: ${COMPOSE_FILE:-docker-compose.yml}"
  echo ""
} > "$REPORT"

step() {
  _name="$1"; shift
  printf '\n=== %s ===\n' "$_name"
  if "$@"; then
    echo "- PASS $_name" >> "$REPORT"
    echo "PASS: $_name"
    return 0
  fi
  echo "- FAIL $_name" >> "$REPORT"
  echo "FAIL: $_name"
  FAILED=1
  return 1
}

skip_step() {
  _name="$1"; _detail="$2"
  SKIPPED=$((SKIPPED + 1))
  echo "- SKIP $_name — $_detail" >> "$REPORT"
  echo "SKIP: $_name — $_detail"
}

require_avrone_failure() {
  _reason="$1"
  echo "- FAIL AVRONE integration — $_reason" >> "$REPORT"
  echo "FAIL: AVRONE integration — $_reason"
  FAILED=1
}

if [ ! -f .env ]; then
  step "select default full configuration" cp .env.full .env || true
fi

if [ "$FAILED" -eq 0 ]; then
  step "Docker CLI, Compose v2, and daemon access" sh -c 'command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1' || true
fi
if [ "$FAILED" -eq 0 ]; then
  step "compose config check (core + full profile)" sh -c 'docker compose config --quiet && docker compose --profile full config --quiet' || true
fi
if [ "$FAILED" -eq 0 ]; then
  step "boot the full stack (build + up, strict self-test gate)" docker compose --profile full up -d --build || true
fi
if [ "$FAILED" -eq 0 ]; then
  step "boot self-test gate (ready:true; bounded restart detection)" ./scripts/wait-boot.sh "${VERIFY_BOOT_TIMEOUT_SECONDS:-7200}" || true
else
  skip_step "boot self-test gate" "a prerequisite or Compose startup step failed"
fi
if [ "$FAILED" -eq 0 ]; then
  step "live agent tests (real inference, Docker terminal, browser, squad, and bridge)" docker compose exec -T grok-bot node tests/live.test.js || true
else
  skip_step "live agent tests" "the boot gate did not pass"
fi
if [ "$FAILED" -eq 0 ]; then
  step "agents' evolution loop (EVOLVE.md)" docker compose exec -T grok-bot node scripts/evolve.js || true
else
  skip_step "agents' evolution loop" "a required prior gate did not pass"
fi

if [ -d "$AVRONE_DIR" ]; then
  if command -v python3 >/dev/null 2>&1; then
    step "AVRONE offline suite (isolated venv)" env AVRONE_DIR="$AVRONE_DIR" sh -c 'cd "$AVRONE_DIR" && { [ -x .venv/bin/python ] || python3 -m venv .venv; } && .venv/bin/python -m pip install -q -e ".[dev]" && .venv/bin/python -m pytest -q' || true
  elif [ "$VERIFY_REQUIRE_AVRONE" = "true" ] || [ "$VERIFY_REQUIRE_AVRONE" = "1" ]; then
    require_avrone_failure "python3 is not installed"
  else
    skip_step "AVRONE offline suite" "python3 not found"
  fi
elif [ "$VERIFY_REQUIRE_AVRONE" = "true" ] || [ "$VERIFY_REQUIRE_AVRONE" = "1" ]; then
  require_avrone_failure "repository not found at AVRONE_DIR=$AVRONE_DIR"
else
  skip_step "AVRONE offline suite" "repository not found at AVRONE_DIR=$AVRONE_DIR; set VERIFY_REQUIRE_AVRONE=true for a combined-system gate"
fi

{
  echo ""
  echo "## Verdict"
  echo ""
  if [ "$FAILED" -ne 0 ]; then
    echo "**FAILURES DETECTED** — the candidate is not verified. See the FAIL lines and boot logs above."
  elif [ "$SKIPPED" -ne 0 ]; then
    echo "**GROK BOT CORE VERIFIED / INTEGRATION PARTIAL** — core checks passed, but optional integration checks were skipped."
  else
    echo "**SYSTEM GREEN** — booted, strict self-tests passed, live tests passed, evolution report written, and AVRONE's offline suite passed. $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi
} >> "$REPORT"

echo ""
cat "$REPORT"
echo ""
[ "$FAILED" -eq 0 ]
