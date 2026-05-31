#!/bin/sh
# ================================================================
#  rclone sync.sh — Sidecar đồng bộ local → remote định kỳ
#
#  Mục tiêu: container repo này restart mỗi 60 phút → mọi data ghi
#  vào .docker-volumes phải được đẩy lên remote ĐỀU ĐẶN, đảm bảo
#  khi restart vẫn restore được.
#
#  Đặc điểm:
#    - Local là buffer ghi nhanh (disk gốc) — app KHÔNG ghi qua FUSE
#    - Mỗi RCLONE_SYNC_INTERVAL_SEC giây, sidecar push diff lên remote
#    - Mode `sync` (mirror): remote = bản sao chính xác của local
#    - Log đầy đủ: số file scan, transferred, errors, throughput
#    - Mỗi N lần sync (RCLONE_AUDIT_EVERY) chạy `rclone check` để verify
# ================================================================
set -e

CONFIG_PATH="${STACK_RCLONE_CONFIG_PATH:-${RCLONE_CONFIG_PATH:-/config/rclone/rclone.conf}}"
LOCAL_PATH="${STACK_RCLONE_LOCAL_PATH:-${RCLONE_LOCAL_PATH:-/data}}"
REMOTE_TARGET="${STACK_RCLONE_REMOTE_TARGET:-${RCLONE_REMOTE_TARGET:-}}"
SYNC_INTERVAL="${STACK_RCLONE_SYNC_INTERVAL_SEC:-${RCLONE_SYNC_INTERVAL_SEC:-30}}"
LOG_LEVEL="${STACK_RCLONE_LOG_LEVEL:-${RCLONE_LOG_LEVEL:-INFO}}"
DRY_RUN="${STACK_RCLONE_DRY_RUN:-${RCLONE_DRY_RUN:-false}}"
EXTRA_FLAGS="${STACK_RCLONE_EXTRA_FLAGS:-${RCLONE_EXTRA_FLAGS:-}}"
TRANSFERS="${STACK_RCLONE_TRANSFERS:-${RCLONE_TRANSFERS:-8}}"
CHECKERS="${STACK_RCLONE_CHECKERS:-${RCLONE_CHECKERS:-16}}"
AUDIT_EVERY="${STACK_RCLONE_AUDIT_EVERY:-${RCLONE_AUDIT_EVERY:-10}}"
BWLIMIT="${STACK_RCLONE_BWLIMIT:-${RCLONE_BWLIMIT:-}}"

START_TS=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

echo "================================================================="
echo " RCLONE-SYNC  ::  local → remote (continuous sidecar)"
echo " Started at   : $START_TS"
echo " Local path   : $LOCAL_PATH"
echo " Remote target: $REMOTE_TARGET"
echo " Interval     : ${SYNC_INTERVAL}s"
echo " Transfers    : $TRANSFERS / Checkers: $CHECKERS"
echo " Log level    : $LOG_LEVEL"
echo " Dry run      : $DRY_RUN"
echo " Audit every  : ${AUDIT_EVERY} runs"
[ -n "$BWLIMIT" ]    && echo " Bw limit     : $BWLIMIT"
[ -n "$EXTRA_FLAGS" ] && echo " Extra flags  : $EXTRA_FLAGS"
echo "================================================================="

# ── Sanity ───────────────────────────────────────────────────────
[ -z "$REMOTE_TARGET" ] && { echo "[FATAL] RCLONE_REMOTE_TARGET trống"; exit 1; }
[ ! -f "$CONFIG_PATH" ] && { echo "[FATAL] Thiếu $CONFIG_PATH"; exit 1; }
[ ! -d "$LOCAL_PATH" ] && { echo "[FATAL] $LOCAL_PATH không tồn tại"; exit 1; }

# ── Build flags ──────────────────────────────────────────────────
DRY_FLAG=""
[ "$DRY_RUN" = "true" ] && DRY_FLAG="--dry-run"
BW_FLAG=""
[ -n "$BWLIMIT" ] && BW_FLAG="--bwlimit $BWLIMIT"

human_bytes() {
  awk -v b="${1:-0}" 'BEGIN{
    split("B KB MB GB TB", u);
    i=1; while (b>=1024 && i<5) { b/=1024; i++ }
    printf "%.2f %s", b, u[i]
  }'
}

run_one_sync() {
  N=$1
  TS_BEGIN=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
  T0=$(date +%s)

  # Snapshot local trước sync
  L_BYTES=$(du -sb "$LOCAL_PATH" 2>/dev/null | awk '{print $1}')
  L_FILES=$(find "$LOCAL_PATH" -type f 2>/dev/null | wc -l | tr -d ' ')
  : "${L_BYTES:=0}"; : "${L_FILES:=0}"

  echo ""
  echo "─── SYNC #$N  @  $TS_BEGIN ────────────────────────────────────"
  echo "  Local      : $L_FILES files / $(human_bytes $L_BYTES) ($L_BYTES B)"

  # Snapshot remote trước sync (best-effort, không fail nếu lỗi)
  R_INFO=$(rclone --config "$CONFIG_PATH" size "$REMOTE_TARGET" --json 2>/dev/null || echo '')
  R_BYTES=$(printf '%s' "$R_INFO" | sed -n 's/.*"bytes":[[:space:]]*\([0-9-]*\).*/\1/p' | head -1)
  R_OBJS=$(printf '%s' "$R_INFO" | sed -n 's/.*"count":[[:space:]]*\([0-9-]*\).*/\1/p' | head -1)
  : "${R_BYTES:=0}"; : "${R_OBJS:=0}"
  echo "  Remote     : $R_OBJS files / $(human_bytes $R_BYTES) ($R_BYTES B)"

  DELTA_BYTES=$((L_BYTES - R_BYTES))
  DELTA_FILES=$((L_FILES - R_OBJS))
  echo "  Δ (L-R)    : $DELTA_FILES files / $DELTA_BYTES B"

  # Thực hiện sync
  set +e
  rclone --config "$CONFIG_PATH" sync "$LOCAL_PATH" "$REMOTE_TARGET" \
    --log-level "$LOG_LEVEL" \
    --stats 10s \
    --stats-one-line \
    --transfers "$TRANSFERS" \
    --checkers "$CHECKERS" \
    --create-empty-src-dirs \
    --update \
    $BW_FLAG \
    $DRY_FLAG \
    $EXTRA_FLAGS 2>&1 | sed 's/^/  [rclone] /'
  RC=$?
  set -e
  T1=$(date +%s)
  DUR=$((T1 - T0))

  if [ "$RC" -eq 0 ]; then
    # Re-probe remote sau sync để verify
    R2_INFO=$(rclone --config "$CONFIG_PATH" size "$REMOTE_TARGET" --json 2>/dev/null || echo '')
    R2_BYTES=$(printf '%s' "$R2_INFO" | sed -n 's/.*"bytes":[[:space:]]*\([0-9-]*\).*/\1/p' | head -1)
    R2_OBJS=$(printf '%s' "$R2_INFO" | sed -n 's/.*"count":[[:space:]]*\([0-9-]*\).*/\1/p' | head -1)
    : "${R2_BYTES:=0}"; : "${R2_OBJS:=0}"
    echo "  ✓ Sync #$N OK in ${DUR}s — remote now: $R2_OBJS files / $(human_bytes $R2_BYTES)"
    if [ "$L_FILES" = "$R2_OBJS" ] && [ "$L_BYTES" = "$R2_BYTES" ]; then
      echo "  ✓ Local == Remote (parity confirmed)"
    elif [ "$DRY_RUN" = "true" ]; then
      echo "  ℹ DRY_RUN — không có thay đổi thật"
    else
      echo "  ⚠ Local vs Remote khác nhau (Δ files=$((L_FILES - R2_OBJS)), Δ bytes=$((L_BYTES - R2_BYTES))) — có thể do file đang ghi"
    fi
  else
    echo "  ✗ Sync #$N FAILED (exit=$RC) sau ${DUR}s — sẽ retry sau ${SYNC_INTERVAL}s"
  fi
}

run_audit() {
  N=$1
  echo ""
  echo "─── AUDIT #$N  ::  rclone check (verify integrity) ─────────────"
  set +e
  rclone --config "$CONFIG_PATH" check "$LOCAL_PATH" "$REMOTE_TARGET" \
    --one-way \
    --log-level NOTICE 2>&1 | sed 's/^/  [check] /' | tail -20
  RC=$?
  set -e
  if [ "$RC" -eq 0 ]; then
    echo "  ✓ Audit OK — local và remote khớp 100%"
  else
    echo "  ⚠ Audit phát hiện sai khác (exit=$RC) — lần sync sau sẽ tự xử lý"
  fi
}

# ── Initial summary ─────────────────────────────────────────────
echo ""
echo "── BOOTSTRAP STATE ─────────────────────────────────────────────"
INIT_LOCAL_FILES=$(find "$LOCAL_PATH" -type f 2>/dev/null | wc -l | tr -d ' ')
INIT_LOCAL_SIZE=$(du -sb "$LOCAL_PATH" 2>/dev/null | awk '{print $1}')
echo "  Local on start : ${INIT_LOCAL_FILES:-0} files / $(human_bytes ${INIT_LOCAL_SIZE:-0})"
if [ "${INIT_LOCAL_FILES:-0}" -gt 0 ] && [ "${INIT_LOCAL_FILES:-0}" -lt 30 ]; then
  echo "  Top files (mtime):"
  find "$LOCAL_PATH" -type f -printf "    %T@  %s  %p\n" 2>/dev/null \
    | sort -nr | head -10 \
    | awk '{ts=strftime("%Y-%m-%d %H:%M:%S", $1); printf "    %s  %10d  %s\n", ts, $2, $3}'
fi

# ── Loop ────────────────────────────────────────────────────────
N=0
while true; do
  N=$((N + 1))
  run_one_sync "$N"

  # Audit định kỳ
  if [ "${AUDIT_EVERY:-0}" -gt 0 ] && [ $((N % AUDIT_EVERY)) -eq 0 ]; then
    run_audit "$N"
  fi

  sleep "$SYNC_INTERVAL"
done
