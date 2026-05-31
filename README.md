# dockerstack-ninerouter

Stack Docker Compose để triển khai **9router** ([decolua/9router](https://github.com/decolua/9router)) ở chế độ **đa phiên bản đồng thời** (multi-version), kèm đầy đủ lớp truy cập và vận hành:

- **App**: 9router (Next.js, port 20128) — hỗ trợ chạy **nhiều phiên bản song song** (ví dụ `latest` + `v0446`), mỗi phiên bản có dữ liệu / sub-domain / port riêng.
- **Core**: Caddy reverse proxy + Cloudflare Tunnel (mỗi phiên bản 9router map tới 1 sub-domain `<slug>.${DOMAIN}`).
- **Ops**: Dozzle (logs), Filebrowser (file manager), WebSSH (terminal qua trình duyệt), Deploy Code (self-deploy sidecar) — đều **được bảo vệ bằng Tinyauth forward_auth**.
- **Access**: Tailscale (truy cập nội bộ qua tailnet) + Keep-IP workflow.
- **Backup**: Litestream (chỉ replicate `tinyauth.db`) + **Rclone** (đồng bộ thư mục dữ liệu của 9router lên S3-compatible remote).

> ⚠️ **Khác biệt so với template gốc**: 9router **tự xử lý xác thực** (JWT cookie nội bộ), nên các route 9router **KHÔNG đi qua Tinyauth forward_auth**. Tinyauth chỉ bảo vệ các dịch vụ ops (dozzle/files/ttyd/deploy/auth).

---

## Tài liệu

- Hướng dẫn triển khai tổng quát: [`docs/DEPLOY.md`](docs/DEPLOY.md)
- Hướng dẫn thêm/đổi/gỡ phiên bản 9router: [`docs/services/ninerouter.md`](docs/services/ninerouter.md)
- Hướng dẫn thay thế app/service mới (lịch sử template): [`docs/deploy.new.md`](docs/deploy.new.md)
- Tài liệu chi tiết từng dịch vụ: thư mục [`docs/services/`](docs/services/)
- Tài liệu Deploy Code: [`docs/services/deploy-code.md`](docs/services/deploy-code.md)
- One-file handoff cho coding agent khi swap app: [`AGENT_APP_SWAP.md`](AGENT_APP_SWAP.md)

---

## Cấu trúc compose

| File | Vai trò |
|---|---|
| `docker-compose/compose.core.yml` | Caddy + Cloudflared |
| `docker-compose/compose.ops.yml` | Dozzle + Filebrowser + WebSSH |
| `docker-compose/compose.auth.yml` | Tinyauth + Litestream (sidecar) |
| `docker-compose/compose.rclone.yml` | Rclone backup (sync 9router data + tinyauth) |
| `docker-compose/compose.rclone-gate.yml` | Rclone restore gate cho Litestream |
| `docker-compose/compose.access.yml` | Tailscale |
| `docker-compose/compose.deploy.yml` | Deploy-code sidecar |
| **`compose.ninerouter.yml`** *(auto-generated)* | Toàn bộ services 9router (mỗi enabled `NINE_ROUTER_ENABLE_<KEY>=true` → 1 service) |
| **`compose.ninerouter-rclone-gate.yml`** *(auto-generated)* | Gate `depends_on: rclone-restore` cho từng phiên bản 9router |

Hai file `compose.ninerouter*.yml` được sinh tự động bởi [`docker-compose/scripts/render-ninerouter.js`](docker-compose/scripts/render-ninerouter.js); script được gọi mỗi khi chạy `dc.sh`. Tuyệt đối **không sửa tay** — sửa `.env` rồi rerender.

Scripts điều phối:

- `docker-compose/scripts/dc.sh` — tự bật profile theo `ENABLE_*`, tự rerender ninerouter trước mỗi lệnh compose.
- `docker-compose/scripts/validate-env.js` — validate env (bao gồm 9router multi-version) trước deploy.
- `docker-compose/scripts/render-ninerouter.js` — render `compose.ninerouter*.yml` từ `.env`.

---

## Bắt đầu nhanh

```bash
# 1. Cấu hình env
cp .env.example .env
# → mở .env, sửa: DOMAIN, NINE_ROUTER_JWT_SECRET, NINE_ROUTER_INITIAL_PASSWORD,
#                   ACME_EMAIL, CLOUDFLARED_TUNNEL_ID, …

# 2. Validate
npm run dockerapp-validate:all

# 3. Render compose.ninerouter*.yml từ .env (tuỳ chọn — dc.sh tự gọi)
npm run dockerapp-gen:ninerouter

# 4. Up
npm run dockerapp-exec:up
npm run dockerapp-exec:ps
npm run dockerapp-exec:logs:ninerouter:latest
```

Sau khi up:

- `https://latest.${DOMAIN}` → 9router phiên bản latest
- `https://v0446.${DOMAIN}` → 9router phiên bản v0446
- `https://logs.${DOMAIN}` / `https://files.${DOMAIN}` / `https://ttyd.${DOMAIN}` / `https://deploy.${DOMAIN}` → ops (Tinyauth)
- `https://auth.${DOMAIN}` → Tinyauth login portal

---

## Thêm / gỡ phiên bản 9router

Mỗi phiên bản 9router dùng cùng image gốc nhưng tag khác nhau, gắn 1 thư mục data và 1 sub-domain riêng. Các biến trong `.env` theo pattern:

```ini
# Mặc định dùng chung (per-version có thể override)
NINE_ROUTER_JWT_SECRET=...
NINE_ROUTER_INITIAL_PASSWORD=...
NINE_ROUTER_DATA_DIR=/app/data
NINE_ROUTER_PORT=20128

# Khai báo các phiên bản
NINE_ROUTER_VERSIONS=LATEST,V0446

# Phiên bản LATEST
NINE_ROUTER_ENABLE_LATEST=true
NINE_ROUTER_IMAGE_TAG_LATEST=latest
NINE_ROUTER_SUBDOMAIN_LATEST=latest
NINE_ROUTER_HOST_PORT_LATEST=20128

# Phiên bản V0446
NINE_ROUTER_ENABLE_V0446=true
NINE_ROUTER_IMAGE_TAG_V0446=0.4.46
NINE_ROUTER_SUBDOMAIN_V0446=v0446
NINE_ROUTER_HOST_PORT_V0446=20129
```

Để thêm phiên bản mới (ví dụ `v0500`):

```ini
NINE_ROUTER_VERSIONS=LATEST,V0446,V0500    # nối thêm KEY (tùy chọn — render script auto-discover)
NINE_ROUTER_ENABLE_V0500=true
NINE_ROUTER_IMAGE_TAG_V0500=0.5.0
NINE_ROUTER_SUBDOMAIN_V0500=v0500
NINE_ROUTER_HOST_PORT_V0500=20130
```

Sau đó:

```bash
npm run dockerapp-validate:env
npm run dockerapp-exec:up         # render + up; service mới ninerouter-v0500 được tạo
```

Và **tạo CNAME** `v0500.${DOMAIN}` → `<TUNNEL_ID>.cfargotunnel.com` trên Cloudflare, đồng thời thêm 1 ingress rule trong [`cloudflared/config.yml`](cloudflared/config.yml).

Chi tiết thêm trong [`docs/services/ninerouter.md`](docs/services/ninerouter.md).

---

## Lệnh thường dùng

```bash
# Validate + render
npm run dockerapp-validate:env
npm run dockerapp-validate:all
npm run dockerapp-gen:ninerouter
npm run dockerapp-gen:ninerouter:check     # check nếu compose.ninerouter*.yml stale

# Lifecycle
npm run dockerapp-exec:up
npm run dockerapp-exec:ps
npm run dockerapp-exec:down

# Logs / exec từng phiên bản
npm run dockerapp-exec:logs:ninerouter:latest
npm run dockerapp-exec:logs:ninerouter:v0446
npm run dockerapp-exec:exec:ninerouter:latest
npm run dockerapp-exec:restart:ninerouter:latest

# Image / cleanup
npm run dockerapp-exec:pull
npm run dockerapp-exec:prune
```

---

## Tiện ích clone stack

```bash
node scripts/clone-stack.js --output /path/deployments --name my-stack
# hoặc tương tác
node scripts/clone-stack.js
```

---

## Lưu ý dữ liệu & backup

- Mỗi phiên bản 9router: dữ liệu nằm tại `${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data/` (host) — chứa SQLite (`db/data.sqlite`) và các file phụ.
- **Rclone** đồng bộ toàn bộ `${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data/` lên S3-compatible remote (xem [`docs/services/rclone.md`](docs/services/rclone.md)).
- **Litestream** trong stack này **CHỈ replicate `tinyauth.db`**, không động vào dữ liệu 9router (vì đã có rclone).
