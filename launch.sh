#!/bin/sh
# launch.sh — sequential local launch & test: the same order the system was
# built in — preflight -> models -> AVRONE -> Grok Bot -> live tests -> the
# agents' evolution loop. Leaves both systems running:
#   AVRONE console:  http://127.0.0.1:8710
#   Grok Bot console: http://localhost:3000
set -e
AVRONE_DIR="${AVRONE_DIR:-../Avrone}"
say() { printf '\n=== %s ===\n' "$1"; }

say "0. Preflight"
command -v docker >/dev/null 2>&1 || { echo "docker is required"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required"; exit 1; }
if command -v ollama >/dev/null 2>&1; then
  for m in qwen2.5:3b nomic-embed-text; do
    ollama list 2>/dev/null | grep -q "$m" || { say "pulling $m"; ollama pull "$m"; }
  done
else
  echo "NOTE: host ollama CLI not found — the compose ollama service pulls models on boot."
fi

say "1. AVRONE (offline test suite, then launch)"
if [ -d "$AVRONE_DIR" ]; then
  (cd "$AVRONE_DIR" && pip install -e ".[dev]" && python -m pytest -q)
  [ -f "$AVRONE_DIR/.env" ] || cp "$AVRONE_DIR/deploy/full.env" "$AVRONE_DIR/.env"
  (cd "$AVRONE_DIR" && avrone-cli doctor || true)
  (cd "$AVRONE_DIR" && nohup avrone > /tmp/avrone.log 2>&1 &)
  echo "AVRONE launching on http://127.0.0.1:8710 (log: /tmp/avrone.log)"
else
  echo "NOTE: AVRONE_DIR=$AVRONE_DIR not found — skipping AVRONE (the avrone.squad bridge will report AVRONE_URL unset)."
fi

say "2. Grok Bot (full profile: boot self-tests gate startup)"
[ -f .env ] || cp .env.full .env
docker compose --profile full up -d --build
for i in $(seq 1 90); do
  curl -sf http://localhost:3000/api/status -o /dev/null && break
  sleep 5
done
curl -sf http://localhost:3000/api/status >/dev/null || { docker compose logs --tail 200 grok-bot; exit 1; }
echo "Grok Bot console: http://localhost:3000"

say "3. Live tests (real inference, docker exec, browser)"
docker compose exec -T grok-bot node tests/live.test.js

say "4. The agents' evolution loop"
docker compose exec -T grok-bot node scripts/evolve.js

say "System live — AVRONE :8710 · Grok Bot :3000 · EVOLVE.md in ./data"
