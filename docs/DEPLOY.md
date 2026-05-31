# deploy.md

Tài liệu triển khai chuẩn cho stack `dockerstack-ninerouter` theo **codebase hiện tại**.

## 1) Luồng triển khai chuẩn

1. Chuẩn bị `.env` (không dựa mù quáng vào `.env.example`).
2. Cấu hình Cloudflare Tunnel (`cloudflared/config.yml` + `credentials.json`) — phải khai báo 1 ingress/CNAME cho **mỗi** sub-domain `<slug>.${DOMAIN}` của 9router enabled.
3. Validate môi trường bằng script `docker-compose/scripts/validate-env.js` (đã bao gồm 9router multi-version).
4. (Tuỳ chọn) Render trước `compose.ninerouter*.yml` để xem trước: `npm run dockerapp-gen:ninerouter`.
5. Deploy bằng `dc.sh` (qua npm scripts) — `dc.sh` tự rerender ninerouter trước mỗi compose command.
6. Kiểm tra health, logs, route công khai và route nội bộ.

## 2) Compose layers

### Core
- `docker-compose/compose.core.yml`
- Chứa `caddy` + `cloudflared`.
- Luôn được nạp.

### Auth
- `docker-compose/compose.auth.yml`
- `tinyauth`, `litestream-restore`, `litestream`.
- Tinyauth luôn cung cấp auth endpoint cho ops services; Litestream bật/tắt qua `ENABLE_LITESTREAM` (chỉ replicate `tinyauth.db`).

### Ops
- `docker-compose/compose.ops.yml`
- `dozzle`, `filebrowser`, `webssh`, `webssh-windows`.
- Bật/tắt qua `ENABLE_DOZZLE`, `ENABLE_FILEBROWSER`, `ENABLE_WEBSSH`.

### Access
- `docker-compose/compose.access.yml`
- `tailscale-linux`, `tailscale-windows`, keep-ip prepare/backup loops.
- Bật/tắt qua `ENABLE_TAILSCALE`.

### Deploy Code
- `docker-compose/compose.deploy.yml`
- `deploy-code` sidecar để Git/ZIP deploy và điều khiển service/container theo allowlist.
- Mặc định tắt, chỉ bật qua `DOCKER_DEPLOY_CODE_ENABLED=true`.

### 9router (multi-version, auto-generated)
- `compose.ninerouter.yml` — sinh từ `.env` bởi `docker-compose/scripts/render-ninerouter.js`.
- `compose.ninerouter-rclone-gate.yml` — sinh kèm khi `ENABLE_RCLONE=true`, chứa `depends_on: rclone-restore` cho mỗi service ninerouter.
- Mỗi `NINE_ROUTER_ENABLE_<KEY>=true` → 1 service `ninerouter-<slug>` (container `main-ninerouter-<slug>`).
- **KHÔNG sửa tay 2 file này.** Sửa `.env` rồi rerender.

### Rclone (backup)
- `docker-compose/compose.rclone.yml`
- Sync `${DOCKER_VOLUMES_ROOT}/ninerouter` (toàn bộ data 9router) lên S3-compatible remote.
- `docker-compose/compose.rclone-gate.yml` — restore-gate cho Litestream (đảm bảo restore replica trước khi `litestream-restore` chạy).

## 3) Các env bắt buộc (hard-stop)

Các biến dưới đây nếu thiếu/sai sẽ **dừng deploy** ở bước validate:

### Core
- `PROJECT_NAME` (mặc định `dockerstack-ninerouter`)
- `DOMAIN`
- `CADDY_EMAIL`

### Tinyauth (cho ops)
- `TINYAUTH_APP_URL` (= `https://auth.<domain>`)
- `TINYAUTH_PORT`
- `TINYAUTH_DB_FILE`
- `TINYAUTH_USERS` (bcrypt hash, **không** plain password)
- `TINYAUTH_COOKIE_SECURE`
- `TINYAUTH_TRUSTED_PROXIES`

### 9router (chung)
- `NINE_ROUTER_JWT_SECRET` (≥16 ký tự)
- `NINE_ROUTER_INITIAL_PASSWORD`
- `NINE_ROUTER_DATA_DIR` (mặc định `/app/data`)
- `NINE_ROUTER_PORT` (mặc định `20128`)

### 9router (per-version, mỗi `<KEY>` trong `NINE_ROUTER_VERSIONS` hoặc `NINE_ROUTER_ENABLE_<KEY>=true`)
- `NINE_ROUTER_ENABLE_<KEY>`
- `NINE_ROUTER_IMAGE_TAG_<KEY>`
- `NINE_ROUTER_SUBDOMAIN_<KEY>` (slug DNS-safe)
- `NINE_ROUTER_HOST_PORT_<KEY>` (khuyến nghị set tường minh; nếu bỏ trống render script auto-tăng)
- Tối thiểu 1 phiên bản phải `ENABLE=true`.

### Cloudflared (mount bắt buộc)
- `cloudflared/config.yml` phải tồn tại.
- `cloudflared/credentials.json` phải tồn tại.
- Trong `cloudflared/config.yml` phải có 1 ingress/CNAME cho **mỗi** `<slug>.${DOMAIN}` enabled.

### Tailscale (nếu `ENABLE_TAILSCALE=true`)
- `TAILSCALE_AUTHKEY`
- `TAILSCALE_TAILNET_DOMAIN`

### Tailscale Keep-IP (nếu `TAILSCALE_KEEP_IP_ENABLE=true`)
- `TAILSCALE_KEEP_IP_FIREBASE_URL` (https + kết thúc `.json`).

### Tailscale Keep-IP Remove-Hostname (nếu enable)
- `TAILSCALE_CLIENTID`
- `TAILSCALE_AUTHKEY` theo format `tskey-client-...`

### Litestream (nếu `ENABLE_LITESTREAM=true`)
- `LITESTREAM_INIT_MODE`
- `LITESTREAM_REPLICATE_DBS` (chỉ `tinyauth` — token `app` đã bỏ)
- `LITESTREAM_S3_ENDPOINT`
- `LITESTREAM_S3_BUCKET`
- `LITESTREAM_S3_ACCESS_KEY_ID`
- `LITESTREAM_S3_SECRET_ACCESS_KEY`
- `LITESTREAM_TINYAUTH_S3_PATH`
- `LITESTREAM_SYNC_INTERVAL`
- `LITESTREAM_SNAPSHOT_INTERVAL`
- `LITESTREAM_RETENTION`
- `LITESTREAM_RETENTION_CHECK_INTERVAL`

### Rclone (nếu `ENABLE_RCLONE=true`)
- `RCLONE_S3_ENDPOINT`, `RCLONE_S3_BUCKET`, `RCLONE_S3_ACCESS_KEY_ID`, `RCLONE_S3_SECRET_ACCESS_KEY` — xem `docs/services/rclone.md`.

## 4) Các env optional nhưng nên cấu hình

### 9router optional (chung — có thể override per-version với suffix `_<KEY>`)
- `NINE_ROUTER_NODE_ENV` (default `production`)
- `NINE_ROUTER_API_KEY_SECRET`
- `NINE_ROUTER_MACHINE_ID_SALT`
- `NINE_ROUTER_ENABLE_REQUEST_LOGS` (default `false`)
- `NINE_ROUTER_OBSERVABILITY_ENABLED` (default `false`)
- `NINE_ROUTER_AUTH_COOKIE_SECURE` (default `true`)
- `NINE_ROUTER_REQUIRE_API_KEY` (default `false`)
- `NINE_ROUTER_CLOUD_URL`
- `NINE_ROUTER_HTTP_PROXY` / `NINE_ROUTER_HTTPS_PROXY` / `NINE_ROUTER_ALL_PROXY` / `NINE_ROUTER_NO_PROXY`

### Khác
- `DOCKER_SOCK`: đường dẫn docker socket nếu khác mặc định.
- `TAILSCALE_TAGS`: mặc định `tag:container`.
- `TAILSCALE_KEEP_IP_INTERVAL_SEC`: mặc định `30`.
- `CUR_WHOAMI`, `CUR_WORK_DIR`, `SHELL`: hỗ trợ webssh Linux thân thiện hơn.
- `DOZZLE_HOST_PORT` (default `18080`)
- `FILEBROWSER_HOST_PORT` (default `18081`)
- `WEBSSH_HOST_PORT` (default `17681`)
- `DOCKER_DEPLOY_CODE_ENABLED`
- `DOCKER_DEPLOY_CODE_HOST_PORT` (default `15399`)
- `DOCKER_DEPLOY_CODE_CADDY_HOSTS`, default `deploy.${DOMAIN}`.
- `DOCKER_DEPLOY_CODE_API_TOKEN` (khi `DOCKER_DEPLOY_CODE_REQUIRE_TOKEN=true`).

## 5) Cấu hình Cloudflare Tunnel

1. Tạo tunnel trên Cloudflare Zero Trust.
2. Tải `credentials.json` đặt tại `cloudflared/credentials.json`.
3. Cập nhật `cloudflared/config.yml`:
   - `tunnel`: tunnel id
   - `credentials-file`: `/etc/cloudflared/credentials.json`
   - `ingress`: 1 entry / mỗi sub-domain enabled (`<slug>.${DOMAIN}`, `logs.${DOMAIN}`, `files.${DOMAIN}`, `ttyd.${DOMAIN}`, `deploy.${DOMAIN}`, `auth.${DOMAIN}`) — tất cả route → `http://caddy:80`.
4. Trên DNS Cloudflare, mỗi hostname phải có CNAME `<TUNNEL_ID>.cfargotunnel.com`.

Mọi request public đi theo chuỗi:

`Internet → Cloudflare Edge → cloudflared → caddy → ninerouter-<slug> | ops service`

## 6) Caddy labels và routing

Routing dựa labels trong compose:

| Service | Hostname public |
|---|---|
| 9router (mỗi version) | `<slug>.${DOMAIN}` |
| Tinyauth | `auth.${DOMAIN}` |
| Dozzle | `logs.${DOMAIN}` |
| Filebrowser | `files.${DOMAIN}` |
| WebSSH | `ttyd.${DOMAIN}` |
| Deploy Code | `deploy.${DOMAIN}` (khi enabled) |

### Auth: Tinyauth forward_auth

Áp dụng cho **ops services** (dozzle/files/ttyd/deploy):

```yaml
- "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
- "caddy.forward_auth.uri=/api/auth/caddy"
- "caddy.forward_auth.header_up=X-Forwarded-Proto https"
- "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
```

**KHÔNG** áp dụng forward_auth cho 9router — 9router tự xử lý JWT cookie nội bộ. Đây là deviation đã được phê duyệt khỏi invariants `app-internal-auth` của template.

`TINYAUTH_APP_URL` phải là `https://auth.<domain>` và `TINYAUTH_USERS` phải dùng bcrypt hash.

## 7) Lệnh deploy đề xuất

```bash
npm run dockerapp-validate:env
npm run dockerapp-validate:compose
npm run dockerapp-gen:ninerouter         # render compose.ninerouter*.yml (dc.sh tự gọi)
npm run dockerapp-exec:up
npm run dockerapp-exec:ps
npm run dockerapp-exec:logs
```

## Truy cập dịch vụ qua Tailscale hostname + port

Khi `ENABLE_TAILSCALE=true`, dùng hostname tailnet của node:

- `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${DOZZLE_HOST_PORT:-18080}` → Dozzle
- `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${FILEBROWSER_HOST_PORT:-18081}` → Filebrowser
- `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${WEBSSH_HOST_PORT:-17681}` → WebSSH
- `http://${PROJECT_NAME_TAILSCALE}.${TAILSCALE_TAILNET_DOMAIN}:${DOCKER_DEPLOY_CODE_HOST_PORT:-15399}` → Deploy Code (nếu bật)
- `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${NINE_ROUTER_HOST_PORT_<KEY>}` → 9router phiên bản tương ứng

Ghi chú:
- Các cổng này bind `127.0.0.1` trên host; truy cập qua tailnet phụ thuộc cách bạn chạy Tailscale (container host-network Linux hay host-level trên Windows/WSL).
- Nếu không truy cập được qua tailnet, kiểm tra firewall host và trạng thái route/Tailscale.

## 8) Kiểm tra sau deploy

- `docker compose ps` tất cả service expected đều `running`/`healthy` (mỗi `ninerouter-<slug>`).
- Truy cập `https://<slug>.<domain>` qua tunnel cho mỗi version 9router.
- Kiểm tra endpoint health: `https://<slug>.<domain>/api/health` → `{"ok":true}` HTTP 200.
- Đăng nhập 9router lần đầu bằng `NINE_ROUTER_INITIAL_PASSWORD`.
- Nếu bật Tailscale: truy cập `https://<slug>.<TAILSCALE_TAILNET_DOMAIN>`.

## 9) Tài liệu từng dịch vụ

- `docs/services/caddy.md`
- `docs/services/cloudflared.md`
- `docs/services/ninerouter.md`
- `docs/services/tinyauth.md`
- `docs/services/dozzle.md`
- `docs/services/filebrowser.md`
- `docs/services/webssh.md`
- `docs/services/tailscale.md`
- `docs/services/deploy-code.md`
- `docs/services/litestream.md`
- `docs/services/rclone.md`
