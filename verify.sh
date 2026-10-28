#!/bin/sh
# verify.sh — the CI-equivalent boot proof, run locally. GitHub Actions is NOT
# required: this runs the exact CI sequence from .github/workflows/ci.yml
# (compose config check -> full-profile boot with the ready:true self-test
# gate -> 8 live tests -> the agents' evolution loop), plus AVRONE's offline
# suite when ../Avrone exists, and writes the verdict to data/VERIFY.md.
# Exit 0 = the system booted and passed everything.
set -u
mkdir -p data
REPORT="data/VERIFY.md"
AVRONE_DIR="${AVRONE_DIR:-../Avrone}"
FAILED=0

{
  echo "# Verify — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo ""
  echo "The CI sequence, executed locally (no GitHub Actions needed):"
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

wait_boot() {
  _i=0
  while [ "$_i" -lt 90 ]; do
    if curl -fsS http://localhost:3000/api/status -o /tmp/verify-status.json 2>/dev/null; then
      if grep -q '"ready":true' /tmp/verify-status.json 2>/dev/null; then return 0; fi
    fi
    _i=$((_i + 1))
    sleep 5
  done
  echo "boot did not reach ready:true in time — last logs:"
  docker compose logs --tail 200 grok-bot || true
  return 1
}

step "compose config check (core + full profile)" sh -c 'docker compose config --quiet && docker compose --profile full config --quiet'
[ -f .env ] || cp .env.full .env
step "boot the full stack (build + up, self-test gated)" docker compose --profile full up -d --build
step "boot self-test gate (ready:true)" wait_boot
step "live agent tests (8, real inference)" docker compose exec -T grok-bot node tests/live.test.js
step "agents' evolution loop (EVOLVE.md)" docker compose exec -T grok-bot node scripts/evolve.js

if [ -d "$AVRONE_DIR" ]; then
  step "AVRONE offline suite" sh -c "cd '$AVRONE_DIR' && python -m pytest -q"
else
  echo "- SKIP AVRONE suite (AVRONE_DIR=$AVRONE_DIR not found)" >> "$REPORT"
  echo "SKIP: AVRONE suite ($AVRONE_DIR not found)"
fi

{
  echo ""
  echo "## Verdict"
  echo ""
  if [ "$FAILED" = 0 ]; then
    echo "**SYSTEM GREEN** — booted, live-tested, evolved. $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  else
    echo "**FAILURES DETECTED** — see the FAIL lines above."
  fi
} >> "$REPORT"

echo ""
cat "$REPORT"
echo ""
[ "$FAILED" = 0 ]
