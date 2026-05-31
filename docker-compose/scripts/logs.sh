#!/usr/bin/env bash
# logs.sh — Stream logs from all (or one) service
# Usage:
#   bash docker-compose/scripts/logs.sh       — all services
#   bash docker-compose/scripts/logs.sh app   — only app service
set -e
exec bash "$(dirname "$0")/dc.sh" logs -f --tail=100 "$@"
