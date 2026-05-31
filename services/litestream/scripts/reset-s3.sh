#!/bin/sh
# ================================================================
#  reset-s3.sh — Xóa dữ liệu Litestream trên S3
#
#  Dùng khi cần reset backup hoàn toàn để fresh start.
#  Sau khi chạy: litestream-restore sẽ detect S3 trống và cho
#  app tự tạo DB mới, rồi sync lên S3 lại từ đầu.
#
#  Cách dùng:
#    ./reset-s3.sh                 → xóa tất cả DB đang replicate
#    ./reset-s3.sh tinyauth        → chỉ xóa tinyauth
#    ./reset-s3.sh app             → chỉ xóa app db
#    ./reset-s3.sh tinyauth app    → xóa nhiều DB
#
#  Env vars:
#    ENV_FILE=<path>  override đường dẫn .env (mặc định: tự tìm)
#
#  Yêu cầu: aws CLI đã được cài (hoặc chạy qua Docker)
# ================================================================
set -e

# ================================================================
#  ENV LOADING — process env ưu tiên, .env file chỉ fill missing
# ================================================================

# Hàm set 1 var: chỉ export nếu chưa có trong process env
# Return 0 = đã có sẵn trong process env, return 1 = lấy từ file
load_env_var() {
  _var_name="$1"
  _file_value="$2"
  eval "_cur=\${${_var_name}:-__UNSET__}"
  if [ "$_cur" = "__UNSET__" ] || [ -z "$_cur" ]; then
    # Chưa có trong process env → load từ file
    # Dùng printf để xử lý value có ký tự đặc biệt an toàn
    eval "export ${_var_name}='${_file_value}'"
    return 1
  fi
  return 0
}

# Tự động tìm .env bằng cách đi ngược lên project root (tối đa 6 cấp)
_find_env_file() {
  _d="$1"
  _i=0
  while [ "$_i" -lt 6 ]; do
    [ -f "${_d}/.env" ] && { echo "${_d}/.env"; return 0; }
    _d="$(dirname "$_d")"
    _i=$((_i + 1))
  done
  return 1
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ENV_FILE có thể được override từ ngoài (CI inject path cụ thể)
if [ -z "${ENV_FILE:-}" ]; then
  ENV_FILE="$(_find_env_file "$SCRIPT_DIR" 2>/dev/null || echo "")"
fi

_from_env=0   # số var lấy từ process env
_from_file=0  # số var load từ .env file

if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  echo "[ENV] Found .env: $ENV_FILE"
  echo "[ENV] Strategy: process env → .env file (process env takes priority)"

  while IFS= read -r _line; do
    # Bỏ comment và dòng trống
    case "$_line" in '#'*|'') continue ;; esac
    # Tách KEY=VALUE (value có thể chứa dấu = hoặc dấu nháy)
    _key="${_line%%=*}"
    _val="${_line#*=}"
    # Bỏ dấu nháy bọc ngoài value nếu có ("value" hoặc 'value')
    case "$_val" in
      '"'*'"') _val="${_val#\"}"; _val="${_val%\"}" ;;
      "'"*"'") _val="${_val#\'}"; _val="${_val%\'}" ;;
    esac
    # Chỉ xử lý key hợp lệ (chữ, số, gạch dưới)
    case "$_key" in *[!A-Za-z0-9_]*|'') continue ;; esac

    if load_env_var "$_key" "$_val"; then
      _from_env=$((_from_env + 1))
    else
      _from_file=$((_from_file + 1))
    fi
  done < "$ENV_FILE"

  echo "[ENV] Result: ${_from_env} var(s) from process env | ${_from_file} var(s) loaded from file"
else
  echo "[ENV] No .env file found — using process environment variables only."
fi

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║           LITESTREAM S3 RESET TOOL                  ║"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Endpoint : $ENDPOINT"
echo "║  Bucket   : $BUCKET"
echo "║  Targets  : $TARGETS"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Validate required vars ────────────────────────────────────────────────
: "${LITESTREAM_S3_ENDPOINT:?Need LITESTREAM_S3_ENDPOINT}"
: "${LITESTREAM_S3_BUCKET:?Need LITESTREAM_S3_BUCKET}"
: "${LITESTREAM_S3_ACCESS_KEY_ID:?Need LITESTREAM_S3_ACCESS_KEY_ID}"
: "${LITESTREAM_S3_SECRET_ACCESS_KEY:?Need LITESTREAM_S3_SECRET_ACCESS_KEY}"

export AWS_ACCESS_KEY_ID="$LITESTREAM_S3_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$LITESTREAM_S3_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION="${LITESTREAM_S3_REGION:-us-east-1}"

ENDPOINT="$LITESTREAM_S3_ENDPOINT"
BUCKET="$LITESTREAM_S3_BUCKET"

# ── Xác định danh sách DB cần reset ──────────────────────────────────────
if [ $# -eq 0 ]; then
  # Không truyền arg → reset tất cả DB đang config
  TARGETS="${LITESTREAM_REPLICATE_DBS:-tinyauth}"
  # Chuyển comma-separated → space-separated
  TARGETS="$(echo "$TARGETS" | tr ',' ' ')"
else
  TARGETS="$*"
fi

echo "║  Endpoint : $ENDPOINT"
echo "║  Bucket   : $BUCKET"
echo "║  Targets  : $TARGETS"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Map DB name → S3 path ─────────────────────────────────────────────────
get_s3_path() {
  case "$1" in
    tinyauth) echo "${LITESTREAM_TINYAUTH_S3_PATH:-tinyauth/tinyauth.db}" ;;
    app)      echo "${LITESTREAM_APP_S3_PATH:-app/app.db}" ;;
    *)        echo "$1" ;;
  esac
}

# ── Hàm xóa 1 DB path trên S3 ────────────────────────────────────────────
reset_one() {
  db_name="$1"
  s3_path="$(get_s3_path "$db_name")"
  s3_uri="s3://${BUCKET}/${s3_path}"

  echo "──────────────────────────────────────────────────────"
  echo "  DB      : $db_name"
  echo "  S3 path : $s3_uri"
  echo ""

  # Kiểm tra có gì không
  echo "  Đang kiểm tra objects trên S3..."
  OBJ_COUNT=$(aws s3 ls "${s3_uri}" \
    --endpoint-url "$ENDPOINT" \
    --recursive \
    --no-paginate 2>/dev/null | wc -l | tr -d ' ')

  if [ "${OBJ_COUNT:-0}" -eq 0 ]; then
    echo "  ✓ S3 path đã trống, không cần xóa."
    return 0
  fi

  echo "  Tìm thấy ${OBJ_COUNT} object(s) tại: $s3_uri"
  echo ""
  printf "  ⚠ Xác nhận XÓA TOÀN BỘ data của '%s' trên S3? [y/N] " "$db_name"
  read -r confirm
  case "$confirm" in
    [yY]|[yY][eE][sS])
      echo "  Đang xóa..."
      aws s3 rm "${s3_uri}" \
        --endpoint-url "$ENDPOINT" \
        --recursive
      echo "  ✓ Đã xóa toàn bộ data của '${db_name}' trên S3."
      ;;
    *)
      echo "  ✗ Bỏ qua '${db_name}'."
      ;;
  esac
  echo ""
}

# ── Chạy reset cho từng target ───────────────────────────────────────────
for db in $TARGETS; do
  reset_one "$db"
done

echo "══════════════════════════════════════════════════════"
echo "  Hoàn tất. Khởi động lại stack để fresh start:"
echo "    docker compose down && docker compose up -d"
echo "══════════════════════════════════════════════════════"
