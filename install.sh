#!/usr/bin/env bash
set -euo pipefail
command -v docker >/dev/null || { echo "Docker required"; exit 1; }
[ -f .env ] || cp .env.example .env
mkdir -p data data/images models/whisper voices
docker compose --profile full up -d --build
echo "Boot self-test:"; docker logs -f grok-bot
