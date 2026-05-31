#!/bin/sh
# ================================================================
#  entrypoint.sh — Litestream restore + replicate
#
#  Stack `dockerstack-ninerouter` chỉ replicate Tinyauth SQLite.
#  9router data được backup riêng qua rclone (không qua Litestream).
#
#  Logic tự động (không cần INIT_MODE):
#    - S3 trống / chưa có backup → fresh start, app tự tạo DB mới
#    - S3 đã có backup           → bắt buộc restore thành công
#    - DB local đã tồn tại       → skip restore (đã có sẵn)
#
#  Để reset S3 khi cần: chạy scripts/reset-s3.sh
# ================================================================
set -e

CONFIG_PATH="${LITESTREAM_CONFIG_PATH:-/etc/litestream.yml}"
REPLICATE_DBS="${LITESTREAM_REPLICATE_DBS:-tinyauth}"

restore_db() {
  name="$1"
  db_path="$2"
  mkdir -p "$(dirname "$db_path")"

  # ── DB local đã tồn tại → skip ───────────────────────────────────────
  if [ -f "$db_path" ]; then
    echo "[RESTORE] ✓ ${name}: database already exists locally, skipping restore."
    return 0
  fi

  # ── Thử restore từ S3 (tự động detect có hay không) ──────────────────
  echo "[RESTORE] ${name}: checking S3 for existing replica..."
  if ! litestream restore -config "$CONFIG_PATH" -if-replica-exists "$db_path"; then
    # Restore command thất bại thật sự (network, credentials, v.v.)
    echo "[ERROR] ${name}: restore command failed. Check S3 credentials/endpoint/network."
    exit 1
  fi

  # ── Kiểm tra kết quả ─────────────────────────────────────────────────
  if [ -f "$db_path" ]; then
    echo "[RESTORE] ✓ ${name}: restored successfully from S3."
  else
    # S3 trống → fresh start, app sẽ tự tạo DB rồi litestream sync lên
    echo "[RESTORE] ℹ ${name}: no replica found on S3. Fresh start — app will create a new database."
  fi
}

# ── Restore từng DB được cấu hình ────────────────────────────────────────
case ",$REPLICATE_DBS," in
  *,tinyauth,*) restore_db "tinyauth" "/data/tinyauth/${TINYAUTH_DB_FILE:-tinyauth.db}" ;;
esac

# ── Chế độ restore-only (dùng bởi service litestream-restore) ────────────
if [ "${1:-}" = "restore-only" ]; then
  echo "[RESTORE] Completed for: ${REPLICATE_DBS}"
  exit 0
fi

echo "[REPLICATE] Litestream watching: ${REPLICATE_DBS}"
exec litestream replicate -config "$CONFIG_PATH"
