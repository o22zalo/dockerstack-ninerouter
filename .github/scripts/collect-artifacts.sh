#!/usr/bin/env bash
# Path: .github/scripts/collect-artifacts.sh
# Collect Docker runtime artifacts after deploy. Works on Linux + WSL2.
set -uo pipefail

OUT="artifacts/docker-runtime"
mkdir -p "$OUT/logs"

echo "=== [collect-artifacts] Collecting to $OUT ==="

DOCKER="docker"
if ! docker info &>/dev/null 2>&1 && sudo docker info &>/dev/null 2>&1; then
  DOCKER="sudo docker"
fi

$DOCKER compose ps -a           > "$OUT/compose-ps.txt"       2>&1 || true
$DOCKER compose images          > "$OUT/compose-images.txt"   2>&1 || true
$DOCKER compose logs --no-color > "$OUT/compose-logs.txt"     2>&1 || true
$DOCKER ps -a                   > "$OUT/docker-ps.txt"        2>&1 || true
$DOCKER images                  > "$OUT/docker-images.txt"    2>&1 || true
$DOCKER system df               > "$OUT/docker-system-df.txt" 2>&1 || true

CONTAINERS=$($DOCKER compose ps -q 2>/dev/null || true)
if [ -n "$CONTAINERS" ]; then
  for c in $CONTAINERS; do
    $DOCKER inspect "$c" > "$OUT/inspect-${c}.json" 2>&1 || true
    $DOCKER logs    "$c" > "$OUT/logs/${c}.log"      2>&1 || true
  done
fi

[ -d logs ] && cp -r logs "$OUT/app-logs" || true
[ -f /tmp/ttyd.log ]    && cp /tmp/ttyd.log    "$OUT/ttyd.log"    || true
[ -f /tmp/dockerd.log ] && cp /tmp/dockerd.log "$OUT/dockerd.log" || true

echo "✅ [collect-artifacts] Done → $OUT"
ls -lh "$OUT/"
