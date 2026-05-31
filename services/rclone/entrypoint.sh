#!/bin/sh
set -e

# Load defaults
SYNC_INTERVAL="${RCLONE_SYNC_INTERVAL_SEC:-20}"
LOCAL_PATH="${RCLONE_LOCAL_PATH:-/data}"
REMOTE_TARGET="${RCLONE_REMOTE_TARGET}"
CONFIG_PATH="${RCLONE_CONFIG_PATH:-/config/rclone/rclone.conf}"
LOG_LEVEL="${RCLONE_LOG_LEVEL:-NOTICE}"
DRY_RUN="${RCLONE_DRY_RUN:-false}"
EXTRA_FLAGS="${RCLONE_EXTRA_FLAGS:-}"

# Validation
if [ -z "$REMOTE_TARGET" ]; then
  echo "[ERROR] Biến môi trường RCLONE_REMOTE_TARGET không được để trống!" >&2
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  echo "[ERROR] Không tìm thấy file cấu hình rclone tại: $CONFIG_PATH" >&2
  exit 1
fi

# Startup Banner
echo "========================================================="
echo " Rclone Sync Sidecar Starting..."
echo " Config Path  : $CONFIG_PATH"
echo " Local Path   : $LOCAL_PATH"
echo " Remote Target: $REMOTE_TARGET"
echo " Interval     : ${SYNC_INTERVAL}s"
echo " Log Level    : $LOG_LEVEL"
echo " Dry Run      : $DRY_RUN"
if [ -n "$EXTRA_FLAGS" ]; then
  echo " Extra Flags  : $EXTRA_FLAGS"
fi
echo "========================================================="

# Loop
SYNC_COUNT=0
while true; do
  SYNC_COUNT=$((SYNC_COUNT + 1))
  TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")
  echo "[$TIMESTAMP] Bắt đầu sync lần thứ #$SYNC_COUNT..."

  # Build dry run flag
  DRY_RUN_FLAG=""
  if [ "$DRY_RUN" = "true" ]; then
    DRY_RUN_FLAG="--dry-run"
  fi

  # Chạy rclone sync và bắt lỗi (không exit nhờ cấu trúc if-else)
  if rclone sync "$LOCAL_PATH" "$REMOTE_TARGET" \
       --config "$CONFIG_PATH" \
       --log-level "$LOG_LEVEL" \
       --create-empty-src-dirs \
       --update \
       --transfers 4 \
       --checkers 8 \
       $DRY_RUN_FLAG \
       $EXTRA_FLAGS; then
    echo "[$TIMESTAMP] Đồng bộ lần #$SYNC_COUNT thành công."
  else
    echo "[WARNING] Đồng bộ lần #$SYNC_COUNT thất bại. Sẽ thử lại sau ${SYNC_INTERVAL}s." >&2
  fi

  sleep "$SYNC_INTERVAL"
done
