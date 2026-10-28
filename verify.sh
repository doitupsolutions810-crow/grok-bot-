#!/bin/sh
# Local, GitHub-independent verification for the self-hosted Grok Bot stack.
# The default boot budget is 60 minutes because .env.full enables LLaVA and pulls
# models synchronously; override VERIFY_BOOT_TIMEOUT_SECONDS on slower hosts.
set -u

REPORT="data/VERIFY.md"
AVRONE_DIR="${AVRONE_DIR:-../Avrone}"
VERIFY_REQUIRE_AVRONE="${VERIFY_REQUIRE_AVRONE:-false}"
FAILED=0
SKIPPED=0
mkdir -p data

{
  echo "# Verify — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo ""
  echo "Local verification; no GitHub Actions runner is required."
  echo ""
  echo "- Boot timeout: ${VERIFY_BOOT_TIMEOUT_SECONDS:-3600}s"
  echo "- Require adjacent AVRONE repository: $VERIFY_REQUIRE_AVRONE"
  echo ""
} > "$REPORT"

step() {
  _name="$1"; shift
  printf '\n=== %s ===\n' "$_name"
  if "$@"; then
    echo "- PASS $_name" >> "$REPORT"
    echo "PASS: $_name"
  else
    echo "- FAIL $_name" >> "$REPORT"
    echo "FAIL: $_name"
    FAILED=1
  fi
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

# Preserve an existing operator config; new checkouts use the full product preset.
if [ ! -f .env ]; then
  step "select default full configuration" cp .env.full .env
fi

step "Docker CLI, Compose v2, and daemon access" sh -c 'command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1'
step "compose config check (core + full profile)" sh -c 'docker compose config --quiet && docker compose --profile full config --quiet'

step "boot the full stack (build + up, strict self-test gate)" docker compose --profile full up -d --build
step "boot self-test gate (ready:true; bounded restart detection)" ./scripts/wait-boot.sh "${VERIFY_BOOT_TIMEOUT_SECONDS:-3600}"
step "live agent tests (real inference, Docker terminal, browser, squad)" docker compose exec -T grok-bot node tests/live.test.js
step "agents' evolution loop (EVOLVE.md)" docker compose exec -T grok-bot node scripts/evolve.js

if [ -d "$AVRONE_DIR" ]; then
  if command -v python3 >/dev/null 2>&1; then
    step "AVRONE offline suite (isolated venv)" env AVRONE_DIR="$AVRONE_DIR" sh -c 'cd "$AVRONE_DIR" && { [ -x .venv/bin/python ] || python3 -m venv .venv; } && .venv/bin/python -m pip install -q -e ".[dev]" && .venv/bin/python -m pytest -q'
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
    echo "**GROK BOT CORE VERIFIED / INTEGRATION PARTIAL** — required core checks passed, but optional integration checks were skipped."
  else
    echo "**SYSTEM GREEN** — booted, strict self-tests passed, live tests passed, evolution report written, and AVRONE's offline suite passed. $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  fi
} >> "$REPORT"

echo ""
cat "$REPORT"
echo ""
[ "$FAILED" -eq 0 ]
