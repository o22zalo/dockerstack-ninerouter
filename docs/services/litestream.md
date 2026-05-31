# Litestream services (`docker-compose/compose.auth.yml`)

## Vai trò
- Backup/replicate **chỉ** SQLite DB của **Tinyauth** lên S3-compatible storage.
- Bảo vệ dữ liệu Tinyauth bằng restore bắt buộc trước khi Tinyauth chạy ở mode deploy bình thường.

> ℹ️ **Phạm vi trong stack `dockerstack-ninerouter`**: Litestream **CHỈ** replicate `tinyauth.db`. Dữ liệu của 9router (`${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data/`) **KHÔNG** đi qua Litestream — đã được backup bằng **rclone** (xem `docs/services/rclone.md`). Lý do: 9router lưu nhiều file phụ ngoài SQLite (config, snapshot, …), backup whole-folder qua rclone đơn giản và đủ.

## Compose layer
- File: `docker-compose/compose.auth.yml`.
- `dc.sh` nạp layer này ngay sau `compose.core.yml` và trước ops/access/ninerouter.

## Services
### `litestream-restore`
- Image: `litestream/litestream:0.3.13`
- Profile: `litestream`
- Chạy one-shot trước `tinyauth`.
- Command: `/entrypoint.sh restore-only`.
- Nếu `LITESTREAM_INIT_MODE=false`, restore DB Tinyauth từ replica S3 rồi mới cho Tinyauth chạy.
- Nếu restore lỗi hoặc không có replica, exit `1` để chặn Tinyauth khởi động.

### `litestream`
- Image: `litestream/litestream:0.3.13`
- Profile: `litestream`
- Chạy nền `litestream replicate` sau khi restore thành công.
- Dùng config `services/litestream/litestream.yml` (chỉ block `tinyauth`).

## File cấu hình
- `services/litestream/litestream.yml`: khai báo SQLite DB (chỉ Tinyauth).
- `services/litestream/entrypoint.sh`: logic init/restore/replicate (chỉ Tinyauth).

DB hiện có:
- Tinyauth: `/data/tinyauth/${TINYAUTH_DB_FILE}` → `${LITESTREAM_TINYAUTH_S3_PATH}`.

## ENV bắt buộc
- `ENABLE_LITESTREAM`: `true|false`, bật profile Litestream trong `dc.sh`.
- `LITESTREAM_INIT_MODE`: `true|false`.
- `LITESTREAM_REPLICATE_DBS`: trong stack này set là `tinyauth`. **Không** thêm `app` (token đó đã bị bỏ — sẽ raise warning).
- `LITESTREAM_S3_ENDPOINT`: endpoint S3-compatible.
- `LITESTREAM_S3_BUCKET`: bucket chứa replica.
- `LITESTREAM_S3_ACCESS_KEY_ID`: access key.
- `LITESTREAM_S3_SECRET_ACCESS_KEY`: secret key.

## ENV per DB
- `LITESTREAM_TINYAUTH_S3_PATH`: object prefix/path cho DB Tinyauth.

## ENV tuning
- `LITESTREAM_SYNC_INTERVAL`: default `5s`, giảm mất dữ liệu tối đa khi crash.
- `LITESTREAM_SNAPSHOT_INTERVAL`: default `30m`, giảm thời gian replay WAL khi restore.
- `LITESTREAM_RETENTION`: default `48h`, giữ generation cũ trong 48 giờ.
- `LITESTREAM_RETENTION_CHECK_INTERVAL`: default `1h`.

## Cách thêm SQLite DB cho dịch vụ ops khác (nếu cần)
1. Mount data dịch vụ vào container đó và vào Litestream cùng một host path:

```yaml
volumes:
  - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/myservice:/data/myservice
```

2. Thêm DB vào `services/litestream/litestream.yml`:

```yaml
  - path: /data/myservice/${LITESTREAM_MYSERVICE_DB_FILE}
    replicas:
      - type: s3
        endpoint: ${LITESTREAM_S3_ENDPOINT}
        bucket: ${LITESTREAM_S3_BUCKET}
        path: ${LITESTREAM_MYSERVICE_S3_PATH}
        access-key-id: ${LITESTREAM_S3_ACCESS_KEY_ID}
        secret-access-key: ${LITESTREAM_S3_SECRET_ACCESS_KEY}
        sync-interval: ${LITESTREAM_SYNC_INTERVAL}
        snapshot-interval: ${LITESTREAM_SNAPSHOT_INTERVAL}
        retention: ${LITESTREAM_RETENTION}
        retention-check-interval: ${LITESTREAM_RETENTION_CHECK_INTERVAL}
```

3. Thêm env vào `.env.example` và `.env`:

```env
LITESTREAM_MYSERVICE_DB_FILE=myservice.db
LITESTREAM_MYSERVICE_S3_PATH=myservice/myservice.db
LITESTREAM_REPLICATE_DBS=tinyauth,myservice
```

4. Cập nhật `services/litestream/entrypoint.sh` để restore DB mới.
5. Nếu service cần restore trước khi start, thêm `depends_on.litestream-restore.condition=service_completed_successfully`.

> ⚠️ **KHÔNG** thêm 9router vào Litestream — dùng rclone (đã có). Việc này tránh chia 2 đường backup chồng chéo.

## Quy trình triển khai an toàn
### Lần đầu tạo DB mới (Tinyauth)
1. Set `LITESTREAM_INIT_MODE=true`.
2. Deploy stack.
3. Truy cập Tinyauth để tạo dữ liệu ban đầu.
4. Kiểm tra `litestream` đang replicate.
5. Đổi `LITESTREAM_INIT_MODE=false`.

### Các lần deploy bình thường
1. Giữ `LITESTREAM_INIT_MODE=false`.
2. `litestream-restore` bắt buộc restore replica trước.
3. Nếu không có backup hoặc restore lỗi, Tinyauth không chạy để tránh tạo DB rỗng.

## Vận hành
- Config check: `bash docker-compose/scripts/dc.sh config`.
- Logs restore/replicate: `bash docker-compose/scripts/dc.sh logs -f litestream litestream-restore`.
- Kiểm tra container: `bash docker-compose/scripts/dc.sh ps`.
- Không chạy `down -v` nếu chưa chắc replica S3 đã ổn.
