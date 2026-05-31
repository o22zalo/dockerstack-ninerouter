# Rclone sync stack (`docker-compose/compose.rclone.yml`)

## Mục tiêu

Container chính của repo bị **restart mỗi 60 phút**. Mỗi lần restart, app phải:

1. **Có lại data cũ** từ remote (nếu remote đã có) — vì `.docker-volumes` cục bộ có thể đã bị xoá theo container.
2. **Đẩy data mới sinh ra** lên remote định kỳ trong khi đang chạy — để lần restart kế tiếp lại có data đầy đủ.

Rclone stack giải quyết cả hai mục tiêu trên qua kiến trúc 3 service.

## Kiến trúc

```
┌────────────────────────────────────────────────────────────────┐
│                       Container start                          │
└────────────┬───────────────────────────────────────────────────┘
             │
             ▼
   ┌──────────────────────┐
   │  rclone-init         │  one-shot
   │  (decode .conf)      │  RCLONE_CONFIG_BASE64 → /config/rclone/rclone.conf
   └──────────┬───────────┘
              │ exit 0
              ▼
   ┌──────────────────────┐
   │  rclone-restore      │  one-shot
   │  remote → local      │  pull .docker-volumes từ remote (nếu có data)
   └──────────┬───────────┘
              │ exit 0
              ├──────────────────────────────────┐
              ▼                                  ▼
   ┌──────────────────────┐            ┌──────────────────────┐
   │  litestream-restore  │            │  rclone-sync         │
   │  app, tinyauth       │            │  local → remote      │
   │  (đã depends_on      │            │  loop mỗi N giây     │
   │   rclone-restore)    │            │  + audit periodic    │
   └──────────────────────┘            └──────────────────────┘
```

App / litestream-restore **chỉ start sau khi rclone-restore exit 0**, đảm bảo
local volume luôn được đồng bộ với remote trước khi business logic chạy.

## Tại sao **không** dùng `rclone mount` (FUSE)

- FUSE cần `--cap-add SYS_ADMIN` và `/dev/fuse` → cần privileged container.
- Write qua FUSE chậm hơn nhiều so với disk gốc, nhất là khi remote là S3.
- Khi mạng remote chập chờn → app block trên `write()`.

Pattern dùng ở đây: **local là buffer ghi nhanh** (disk gốc), rclone async
copy/sync. Đường write của app KHÔNG bị chậm bởi remote.

## Flow tóm tắt

| Pha | Service | Hành động |
|-----|---------|-----------|
| Bootstrap | `rclone-init` | Decode `RCLONE_CONFIG_BASE64` → `rclone.conf`, validate, list remotes |
| Pre-start | `rclone-restore` | `rclone copy <remote> /data` (additive, không xóa file local) |
| Runtime | `rclone-sync` | `rclone sync /data <remote>` mỗi `RCLONE_SYNC_INTERVAL_SEC` giây |
| Audit | `rclone-sync` | Mỗi `RCLONE_AUDIT_EVERY` lần → `rclone check` để verify parity |

## Setup 3 bước

1. Tạo `rclone.conf` thật từ template:
   ```bash
   cp services/rclone/rclone.conf.example services/rclone/rclone.conf
   # → sửa file rclone.conf, điền credentials thật
   ```

2. Encode thành base64 và đặt vào `.env`:
   ```bash
   # Linux / macOS
   base64 -w 0 services/rclone/rclone.conf
   # → copy chuỗi vào .env: RCLONE_CONFIG_BASE64=<chuỗi>
   ```

   ```powershell
   # Windows PowerShell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("services/rclone/rclone.conf"))
   ```

3. Bật flag và remote target:
   ```env
   ENABLE_RCLONE=true
   RCLONE_REMOTE_TARGET=remote_store:my-bucket/docker-volumes
   ```

## Test nhanh trước khi triển khai

```bash
# Validate config decode + list remotes
docker compose --profile rclone run --rm rclone-init

# Test pull thực tế (sẽ ghi vào .docker-volumes)
docker compose --profile rclone run --rm rclone-restore

# Đọc thử listing remote
docker compose --profile rclone run --rm \
  --entrypoint sh rclone-sync -c \
  'rclone --config /config/rclone/rclone.conf lsf "$RCLONE_REMOTE_TARGET" | head'
```

Khi mọi thứ OK:
```bash
bash docker-compose/scripts/dc.sh up -d
bash docker-compose/scripts/dc.sh logs -f rclone-sync
```

## Biến môi trường

### Bắt buộc

| Biến | Ý nghĩa |
|------|---------|
| `ENABLE_RCLONE` | `true` để bật profile rclone (kéo thêm gate file) |
| `RCLONE_CONFIG_BASE64` | Base64 của `rclone.conf` đã điền credentials |
| `RCLONE_REMOTE_TARGET` | Đích sync, dạng `<remote_name>:<bucket>/<path>` |

### Tùy chọn

| Biến | Mặc định | Ý nghĩa |
|------|---------|---------|
| `RCLONE_SYNC_INTERVAL_SEC` | `30` | Khoảng giây giữa 2 lần sync |
| `RCLONE_LOG_LEVEL` | `INFO` | DEBUG / INFO / NOTICE / ERROR |
| `RCLONE_DRY_RUN` | `false` | `true` = chỉ liệt kê, không transfer (chỉ áp dụng cho sync) |
| `RCLONE_TRANSFERS` | `8` | Số luồng transfer song song |
| `RCLONE_CHECKERS` | `16` | Số luồng kiểm tra metadata song song |
| `RCLONE_AUDIT_EVERY` | `10` | Cứ N lần sync chạy 1 lần `rclone check` (0 = tắt) |
| `RCLONE_BWLIMIT` | _(empty)_ | Ví dụ `10M` để giới hạn 10 MiB/s |
| `RCLONE_EXTRA_FLAGS` | _(empty)_ | Truyền thẳng vào lệnh rclone (`--exclude ...`, `--max-age ...`) |

## Log mẫu (chứng minh đã đồng bộ)

`rclone-restore` (một lần lúc start):
```
=================================================================
 RCLONE-RESTORE  ::  remote → local (one-shot bootstrap)
 Remote target: remote_store:my-bucket/docker-volumes
=================================================================

── BEFORE  ::  Local state ──────────────────────────────────────
  Local size   : 0 bytes
  Local files  : 0

── REMOTE  ::  Probe ────────────────────────────────────────────
  Remote bytes : 4831250
  Remote files : 27

── DECISION  ::  Remote có data → RESTORE remote → local ───────

── COPY  ::  Pulling remote → local ────────────────────────────
  [rclone] Transferred:        4.610 MiB / 4.610 MiB, 100%, ...
  ✓ Sync OK in 3s — local now: 27 files / 4.61 MB

── LOCAL LIST AFTER  (top 30) ──────────────────────────────────
  2026-05-30 11:14:01    136481  /data/tinyauth/tinyauth.db
  2026-05-30 11:14:01     49152  /data/app/data/app.db
  ...
```

`rclone-sync` (sidecar, mỗi 30s):
```
─── SYNC #5  @  2026-05-30T11:18:30Z ──────────────────────────
  Local      : 27 files / 4.61 MB (4831250 B)
  Remote     : 27 files / 4.61 MB (4831250 B)
  Δ (L-R)    : 0 files / 0 B
  [rclone] Transferred:           0 / 0 Bytes, -, ...
  ✓ Sync #5 OK in 1s — remote now: 27 files / 4.61 MB
  ✓ Local == Remote (parity confirmed)
```

## Files

| File | Vai trò |
|------|---------|
| `docker-compose/compose.rclone.yml` | 3 service: rclone-init, rclone-restore, rclone-sync |
| `docker-compose/compose.rclone-gate.yml` | Override thêm `depends_on: rclone-restore` cho app + litestream-restore (chỉ nạp khi `ENABLE_RCLONE=true`) |
| `services/rclone/init.sh` | Decode base64 → rclone.conf, validate |
| `services/rclone/restore.sh` | Pull remote → local 1 lần lúc start |
| `services/rclone/sync.sh` | Loop sync local → remote + audit |
| `services/rclone/rclone.conf.example` | Mẫu config (1 remote, union, crypt, chain) |

## Lỗi thường gặp

| Hiện tượng | Nguyên nhân | Khắc phục |
|------------|-------------|-----------|
| `rclone-init` exit 1, "RCLONE_CONFIG_BASE64 chưa được set" | Quên paste base64 vào `.env` | Encode `rclone.conf` rồi paste |
| `rclone-init` exit 1, "Decode … thất bại" | Chuỗi base64 bị xuống dòng / có ký tự lạ | Encode lại bằng `base64 -w 0` (không wrap) |
| `rclone-init` exit 1, `Invalid value when setting --bwlimit ... RCLONE_BWLIMIT=""` | Compose cũ inject toàn bộ `.env`, làm rclone tự parse biến tùy chọn rỗng | Cập nhật `compose.rclone.yml`; bản mới chỉ forward biến nội bộ `STACK_RCLONE_*` |
| `rclone-restore` exit 1, "không kết nối được remote" | Sai endpoint / credentials / bucket chưa tồn tại | Kiểm tra section `[remote_store]` và provider |
| App start nhưng data trống sau restart | `ENABLE_RCLONE=false` → gate file không nạp | Bật `ENABLE_RCLONE=true` |
| Sync chậm | Mạng / S3 throttling | Giảm `RCLONE_TRANSFERS`, đặt `RCLONE_BWLIMIT` |
