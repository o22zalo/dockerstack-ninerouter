#!/usr/bin/env bash
# down.sh — Quick stop: bring down all services
# Usage (from repo root): bash docker-compose/scripts/down.sh
set -e
exec bash "$(dirname "$0")/dc.sh" down "$@"
