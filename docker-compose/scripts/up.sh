#!/usr/bin/env bash
# up.sh — Quick start: build + start all enabled services
# Usage (from repo root): bash docker-compose/scripts/up.sh
set -e
exec bash "$(dirname "$0")/dc.sh" up -d --build --remove-orphans "$@"
