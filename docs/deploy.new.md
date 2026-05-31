# deploy.new.md

Hướng dẫn 2 kịch bản trên stack `dockerstack-ninerouter`:

- **Kịch bản A**: thay 9router (app chính của stack) bằng app khác → clone stack rồi sửa.
- **Kịch bản B**: thay/đổi/thêm/gỡ **một phiên bản 9router** → chỉ cần sửa `.env`.

Mục tiêu chung:
- Thay app/version với rủi ro thấp nhất.
- Chỉ thay phần app mà không phá core/ops/access/auth.
- Chuẩn hóa dữ liệu runtime của container vào `./.docker-volumes`.
- Filebrowser xem được toàn bộ data runtime song song với `workspace`.

---

## Kịch bản B — Thay/đổi/thêm/gỡ phiên bản 9router (case phổ biến)

Đây là use-case **chính** của stack. Không clone, không sửa compose tay.

### B1. Sửa `.env`

Mỗi phiên bản dùng `<KEY>` (UPPERCASE) làm hậu tố:

```ini
# Khai báo (tùy chọn — render script auto-discover)
NINE_ROUTER_VERSIONS=LATEST,V0446,V0500

# Thêm phiên bản v0500
NINE_ROUTER_ENABLE_V0500=true
NINE_ROUTER_IMAGE_TAG_V0500=0.5.0
NINE_ROUTER_SUBDOMAIN_V0500=v0500
NINE_ROUTER_HOST_PORT_V0500=20130

# Tạm tắt v0446
NINE_ROUTER_ENABLE_V0446=false
```

Override per-version (nếu cần):

```ini
NINE_ROUTER_REQUIRE_API_KEY_V0500=true
NINE_ROUTER_OBSERVABILITY_ENABLED_V0500=true
```

### B2. Cập nhật Cloudflared cho version mới

Trong `cloudflared/config.yml`, thêm 1 ingress:

```yaml
- hostname: v0500.${DOMAIN}
  service: http://caddy:80
```

Tạo CNAME `v0500.<domain>` → `<TUNNEL_ID>.cfargotunnel.com` trên Cloudflare.

### B3. Validate + deploy

```bash
npm run dockerapp-validate:env
npm run dockerapp-exec:up                        # render + up; service mới được tạo
npm run dockerapp-exec:logs:ninerouter:v0500     # nếu đã thêm npm script
```

`dc.sh` tự gọi `render-ninerouter.js`, sinh lại `compose.ninerouter*.yml` từ `.env` trước mỗi lệnh compose.

### B4. Gỡ phiên bản

Set `NINE_ROUTER_ENABLE_<KEY>=false` rồi `dockerapp-exec:up`. Dữ liệu tại `${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data/` vẫn còn — xóa thủ công nếu cần.

---

## Kịch bản A — Thay 9router bằng app khác

Áp dụng khi cần fork stack này thành stack khác hẳn (không còn 9router multi-version).

### A1. Tạo workspace mới từ template

```bash
node scripts/clone-stack.js --output /opt/stacks --name service-b
```

Kết quả: `/opt/stacks/service-b` chứa bản sao repo (đã bỏ `.git`).

### A2. Xóa lớp 9router

- Xóa thư mục `services/9router/`.
- Xóa `docker-compose/scripts/render-ninerouter.js`.
- Trong `docker-compose/scripts/dc.sh`:
  - Bỏ block `prepare_docker_volume_dirs()` discover `NINE_ROUTER_ENABLE_*`.
  - Bỏ `render_ninerouter_compose()` và lệnh gọi nó.
  - Bỏ tham chiếu `compose.ninerouter*.yml` trong FILES array.
- Trong `.env.example`: xoá toàn bộ block `NINE_ROUTER_*` và per-version.
- Trong `validate-env.js`: xóa `validateNineRouter()` + `discoverNineRouterKeys()` + subdomain preview block ninerouter.
- Trong `cloudflared/config.yml`: xóa các ingress `<slug>.${DOMAIN}` cũ.
- Xóa các script `dockerapp-exec:*:ninerouter:*` trong `package.json`.
- Xóa `docs/services/ninerouter.md`.

### A3. Thêm app mới

#### Cách 1: tạo lại lớp `compose.apps.yml` đơn-app
- Tạo `compose.apps.yml` với 1 service `app` build từ `services/app/Dockerfile`.
- Mount data: `${DOCKER_VOLUMES_ROOT}/app/data:/path/in/container`.
- Thêm lại Caddy labels (reverse_proxy + forward_auth nếu muốn dùng Tinyauth).

#### Cách 2: dùng image có sẵn (không build)
- Trong `compose.apps.yml`, chỉ khai báo `image:` (bỏ `build:`).
- Map port + volumes + healthcheck cho phù hợp app.

### A4. Chuẩn hoá data vào `.docker-volumes`

Mặc định stack dùng:

- `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}`

Quy ước bắt buộc:

1. Mọi dữ liệu cần persist của container phải map về host dưới:
   - `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/<service>/<du-lieu>:/path/in/container`
2. Không dùng named volume ẩn danh cho dữ liệu cần quan sát trên host.
3. Nếu service có nhiều dữ liệu, tách thư mục rõ ràng (`config`, `data`, `db`, `logs`, `state`...).

Ví dụ:

```yaml
services:
  myapp:
    image: ghcr.io/org/myapp:latest
    volumes:
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/myapp/data:/var/lib/myapp
      - ${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/myapp/config:/etc/myapp
```

Thư mục gợi ý nên tạo sẵn:

```bash
mkdir -p .docker-volumes/myapp/data .docker-volumes/myapp/config
mkdir -p .docker-volumes/tinyauth
mkdir -p .docker-volumes/caddy/data .docker-volumes/caddy/config
mkdir -p .docker-volumes/filebrowser/database
mkdir -p .docker-volumes/tailscale/var-lib
```

`dc.sh` đã tự `mkdir -p` các thư mục cơ bản. Tạo sẵn vẫn hữu ích để set quyền truy cập.

PowerShell:

```powershell
New-Item -ItemType Directory -Force `
  .docker-volumes/myapp/data, `
  .docker-volumes/myapp/config, `
  .docker-volumes/tinyauth, `
  .docker-volumes/caddy/data, `
  .docker-volumes/caddy/config, `
  .docker-volumes/filebrowser/database, `
  .docker-volumes/tailscale/var-lib | Out-Null
```

### A5. Cập nhật env

Tối thiểu:

- `PROJECT_NAME`
- `DOMAIN`
- `CADDY_EMAIL`
- `TINYAUTH_APP_URL`, `TINYAUTH_PORT`, `TINYAUTH_DB_FILE`, `TINYAUTH_USERS`
- `TINYAUTH_COOKIE_SECURE`, `TINYAUTH_TRUSTED_PROXIES`
- App-specific env (port, secrets, …).
- `LITESTREAM_*` nếu `ENABLE_LITESTREAM=true` (chỉ tinyauth).

Tuỳ chọn:

- `ENABLE_*` flags
- `DOCKER_VOLUMES_ROOT` (mặc định `./.docker-volumes`)
- Tailscale block nếu cần private access.

### A6. Cloudflare

- Cập nhật `cloudflared/config.yml` theo hostname mới.
- Đảm bảo DNS record trỏ đúng tunnel.

### A7. Validate trước khi chạy

```bash
npm run dockerapp-validate:env
npm run dockerapp-validate:compose
```

Nếu có lỗi `❌` → bắt buộc sửa trước khi deploy.

### A8. Deploy

```bash
npm run dockerapp-exec:up
npm run dockerapp-exec:ps
npm run dockerapp-exec:logs
```

### A9. Checklist hoàn thành

#### Lớp app
- `app` healthy.
- `http://127.0.0.1:${APP_HOST_PORT}` (nếu có publish).

#### Lớp public
- Host `${PROJECT_NAME}.${DOMAIN}` truy cập OK.
- Tinyauth forward_auth hoạt động (hoặc auth nội bộ của app, tuỳ thiết kế).
- `TINYAUTH_APP_URL` đúng `https://auth.<domain>`.
- `TINYAUTH_USERS` dùng bcrypt hash, không dùng plain password.

#### Lớp ops (nếu bật)
- `logs.*`, `files.*`, `ttyd.*` truy cập được.
- Trong filebrowser thấy được:
  - `/srv/workspace`
  - `/srv/docker-volumes`

#### Lớp access (nếu bật)
- Tailnet host nội bộ truy cập được.
- Keep-ip logs không báo lỗi Firebase/API.
- Truy cập ops bằng hostname+port qua tailnet (xem `docs/DEPLOY.md` mục “Truy cập Tailscale”).

---

## Tổng kết điểm cần đối khi thay dịch vụ

1. `compose.ninerouter.yml` (auto-generated) hoặc `compose.apps.yml` (manual) cho app layer.
2. `docker-compose/compose.auth.yml` cho Tinyauth/Litestream auth + backup layer.
3. Tất cả compose file có data volume: map vào `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/...`.
4. `.env` (identity + domain + Tinyauth + Litestream + port + flags + per-version 9router nếu giữ).
5. `cloudflared/config.yml` (ingress hostnames cho mỗi version/sub-domain).
6. Tuỳ chọn: script CI/CD để reflect tên stack mới.
