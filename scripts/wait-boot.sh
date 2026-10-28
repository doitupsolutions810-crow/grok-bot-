#!/bin/sh
# Wait for the real boot gate, while distinguishing a slow first pull from a crash loop.
# Usage: scripts/wait-boot.sh [timeout-seconds]
set -u

TIMEOUT_SECONDS="${1:-${VERIFY_BOOT_TIMEOUT_SECONDS:-3600}}"
POLL_SECONDS="${VERIFY_BOOT_POLL_SECONDS:-10}"
case "$TIMEOUT_SECONDS" in ''|*[!0-9]*) TIMEOUT_SECONDS=3600 ;; esac
case "$POLL_SECONDS" in ''|*[!0-9]*) POLL_SECONDS=10 ;; esac
[ "$TIMEOUT_SECONDS" -gt 0 ] 2>/dev/null || TIMEOUT_SECONDS=3600
[ "$POLL_SECONDS" -gt 0 ] 2>/dev/null || POLL_SECONDS=10

fail_with_logs() {
  _reason="$1"
  echo "BOOT FAILURE: $_reason"
  echo ""
  echo "--- compose status ---"
  docker compose ps -a 2>&1 || true
  echo ""
  echo "--- grok-bot logs (last 200 lines) ---"
  docker compose logs --tail 200 grok-bot 2>&1 || true
  return 1
}

command -v docker >/dev/null 2>&1 || { echo "docker CLI is required"; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required"; exit 1; }
docker info >/dev/null 2>&1 || { fail_with_logs "Docker daemon is unavailable or permission was denied"; exit 1; }

DEADLINE=$(( $(date +%s) + TIMEOUT_SECONDS ))
STATUS_FILE="${TMPDIR:-/tmp}/grokbot-verify-status-$$.json"
cleanup() { rm -f "$STATUS_FILE"; }
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
LAST_RESTARTS=-1

while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl --connect-timeout 3 --max-time 5 -fsS http://localhost:3000/api/status -o "$STATUS_FILE" 2>/dev/null; then
    if grep -q '"ready":true' "$STATUS_FILE" 2>/dev/null; then
      echo "BOOT READY: server self-test gate passed."
      cat "$STATUS_FILE"
      exit 0
    fi
    if grep -Eq '"ready"[[:space:]]*:[[:space:]]*false' "$STATUS_FILE" 2>/dev/null; then
      cat "$STATUS_FILE"
      fail_with_logs "API is serving in degraded mode; one or more strict boot self-tests failed"
      exit 1
    fi
    echo "API answered but did not report a valid ready:true state; waiting."
  fi

  CID="$(docker compose ps -q grok-bot 2>/dev/null || true)"
  if [ -n "$CID" ]; then
    STATE="$(docker inspect --format '{{.State.Status}}' "$CID" 2>/dev/null || true)"
    RESTARTS="$(docker inspect --format '{{.RestartCount}}' "$CID" 2>/dev/null || true)"
    case "$RESTARTS" in ''|*[!0-9]*) RESTARTS=0 ;; esac
    if [ "$STATE" = "exited" ] || [ "$STATE" = "dead" ]; then
      fail_with_logs "grok-bot container state is $STATE"
      exit 1
    fi
    if [ "$RESTARTS" -ge 3 ]; then
      fail_with_logs "grok-bot has restarted $RESTARTS times before reaching ready:true"
      exit 1
    fi
    if [ "$RESTARTS" != "$LAST_RESTARTS" ]; then
      echo "Boot in progress: container state=${STATE:-unknown}, restart_count=$RESTARTS; waiting."
      LAST_RESTARTS="$RESTARTS"
    fi
  fi
  sleep "$POLL_SECONDS"
done

fail_with_logs "ready:true was not observed within $TIMEOUT_SECONDS seconds"
exit 1
