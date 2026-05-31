# 9router service (`compose.ninerouter.yml`)

> File `compose.ninerouter.yml` (và `compose.ninerouter-rclone-gate.yml` khi bật rclone) được **sinh tự động** bởi `docker-compose/scripts/render-ninerouter.js`. **Không sửa tay** — sửa `.env` rồi rerender (`npm run dockerapp-gen:ninerouter`).

## Vai trò

Triển khai [decolua/9router](https://github.com/decolua/9router) (Next.js) ở chế độ **đa phiên bản đồng thời**. Mỗi phiên bản (`<KEY>` trong env, ví dụ `LATEST`, `V0446`):

- Là **một service Docker riêng** (`ninerouter-<slug>`) chạy container `main-ninerouter-<slug>`.
- Build từ `services/9router/Dockerfile` với build-arg `NINE_ROUTER_VERSION_TAG=${NINE_ROUTER_IMAGE_TAG_<KEY>}` (wrapper trên `decolua/9router:<tag>`, chỉ thêm `wget`/`curl` để healthcheck).
- Có dữ liệu riêng tại `${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data/` (mount → `/app/data`).
- Có sub-domain riêng `<slug>.${DOMAIN}` (Caddy reverse_proxy).
- Có port host riêng `127.0.0.1:${NINE_ROUTER_HOST_PORT_<KEY>}:${NINE_ROUTER_PORT}` (mặc định 9router port = 20128).

> Naming: KEY (UPPERCASE, dùng làm hậu tố env) ↔ slug (lowercase, dùng làm tên service / sub-domain / tên thư mục data). Ví dụ: KEY `V0446` ↔ slug `v0446`.

---

## Cấu hình env

### 9router required (chung)

| Env | Mô tả |
|---|---|
| `NINE_ROUTER_JWT_SECRET` | secret cho JWT cookie nội bộ của 9router. **Bắt buộc thay** trước production. |
| `NINE_ROUTER_INITIAL_PASSWORD` | mật khẩu admin lần đầu. |
| `NINE_ROUTER_DATA_DIR` | đường dẫn data trong container. **Khuyến nghị giữ `/app/data`** (image upstream chown sẵn). |
| `NINE_ROUTER_PORT` | port app lắng nghe trong container (mặc định `20128`). |

### 9router optional / recommended (chung)

| Env | Default | Mô tả |
|---|---|---|
| `NINE_ROUTER_NODE_ENV` | `production` | bật optimize của Next.js. |
| `NINE_ROUTER_API_KEY_SECRET` | *(empty)* | secret tạo/verify API key. |
| `NINE_ROUTER_MACHINE_ID_SALT` | *(empty)* | salt cho machine-id. |
| `NINE_ROUTER_ENABLE_REQUEST_LOGS` | `false` | log từng request. |
| `NINE_ROUTER_OBSERVABILITY_ENABLED` | `false` | bật metrics endpoint. |
| `NINE_ROUTER_AUTH_COOKIE_SECURE` | `true` | `Secure` flag cho auth cookie (yêu cầu HTTPS). |
| `NINE_ROUTER_REQUIRE_API_KEY` | `false` | yêu cầu API key cho mọi request public. |
| `NINE_ROUTER_CLOUD_URL` | *(empty)* | endpoint của 9router-cloud (nếu có). |
| `NINE_ROUTER_HTTP_PROXY` / `NINE_ROUTER_HTTPS_PROXY` / `NINE_ROUTER_ALL_PROXY` / `NINE_ROUTER_NO_PROXY` | *(empty)* | outbound proxy (forward → `HTTP_PROXY`, …). |

> `BASE_URL` / `NEXT_PUBLIC_BASE_URL` được render script tự sinh từ `<slug>.${DOMAIN}` cho từng phiên bản.

### Per-version (1 block / phiên bản)

| Env | Bắt buộc | Mô tả |
|---|---|---|
| `NINE_ROUTER_ENABLE_<KEY>` | ✓ | `true` để bật, `false` để tắt. |
| `NINE_ROUTER_IMAGE_TAG_<KEY>` | ✓ | tag image (`latest`, `0.4.46`, `0.4.66`, …). |
| `NINE_ROUTER_SUBDOMAIN_<KEY>` | ✓ | slug DNS-safe, `[a-z0-9][a-z0-9-]*` (sẽ thành `<slug>.${DOMAIN}`). |
| `NINE_ROUTER_HOST_PORT_<KEY>` | ✗ (auto) | port localhost (mặc định auto-tăng từ `${NINE_ROUTER_PORT}`). Phải khác nhau giữa các phiên bản. |
| Bất kỳ `NINE_ROUTER_<VAR>_<KEY>` | ✗ | override per-version (fallback chain: per-version → shared → SHARED_DEFAULTS). Ví dụ `NINE_ROUTER_OBSERVABILITY_ENABLED_V0446=true`. |

### Khai báo danh sách phiên bản

```ini
NINE_ROUTER_VERSIONS=LATEST,V0446
```

Hoặc bỏ qua — render script auto-discover bằng cách scan tất cả `NINE_ROUTER_ENABLE_<KEY>` trong env.

---

## Volume & dữ liệu

- Mount: `${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data:/app/data`
- File quan trọng: `${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data/db/data.sqlite` (DB của 9router).
- `dc.sh` tự `mkdir -p` tất cả các thư mục data trước khi up (theo các KEY enabled).

### Backup

- **Rclone** (`compose.rclone.yml`) sync toàn bộ `${DOCKER_VOLUMES_ROOT}/ninerouter` lên S3 remote.
- **Litestream KHÔNG dùng cho 9router** — chỉ replicate `tinyauth.db`.

---

## Routing & Auth

- Public host: `<slug>.${DOMAIN}` → Caddy `reverse_proxy ninerouter-<slug>:${NINE_ROUTER_PORT}` với `flush_interval -1` (cho SSE/streaming).
- Internal HTTPS host: `<slug>.${TAILSCALE_TAILNET_DOMAIN}` (`tls internal`) qua `caddy_1` (nếu bật Tailscale).
- **KHÔNG có `forward_auth` từ Caddy đến Tinyauth** — 9router tự xử lý JWT cookie nội bộ. Đây là **deviation** đã được phê duyệt khỏi invariants `app-internal-auth` của template.
- Tinyauth vẫn bảo vệ `dozzle / files / ttyd / deploy / auth` như bình thường.

---

## Healthcheck

```yaml
test: ["CMD-SHELL", "wget -qO- http://localhost:${NINE_ROUTER_PORT}/api/health || exit 1"]
```

Endpoint `/api/health` của 9router trả `{"ok": true}` HTTP 200. Wrapper Dockerfile thêm `wget` (busybox) + `curl` để healthcheck hoạt động trên image gốc (chỉ có `node`).

---

## Thêm 1 phiên bản mới (ví dụ `v0500`)

1. Thêm vào `.env`:

   ```ini
   NINE_ROUTER_VERSIONS=LATEST,V0446,V0500       # tuỳ chọn
   NINE_ROUTER_ENABLE_V0500=true
   NINE_ROUTER_IMAGE_TAG_V0500=0.5.0
   NINE_ROUTER_SUBDOMAIN_V0500=v0500
   NINE_ROUTER_HOST_PORT_V0500=20130             # phải khác các port khác
   ```

2. Validate:

   ```bash
   npm run dockerapp-validate:env
   ```

3. (Tuỳ chọn) Override per-version:

   ```ini
   NINE_ROUTER_REQUIRE_API_KEY_V0500=true
   ```

4. Tạo CNAME `v0500.${DOMAIN}` → `<TUNNEL_ID>.cfargotunnel.com` (Cloudflare dashboard).

5. Thêm ingress rule trong `cloudflared/config.yml`:

   ```yaml
   - hostname: v0500.${DOMAIN}
     service: http://caddy:80
   ```

6. Up (render script tự gọi):

   ```bash
   npm run dockerapp-exec:up
   npm run dockerapp-exec:logs:ninerouter:v0500   # nếu đã thêm script vào package.json
   ```

## Gỡ 1 phiên bản

Set `NINE_ROUTER_ENABLE_<KEY>=false` rồi rerender + up. Dữ liệu tại `${DOCKER_VOLUMES_ROOT}/ninerouter/<slug>/data/` vẫn còn — xóa thủ công nếu cần.

---

## Wrapper Dockerfile (`services/9router/Dockerfile`)

Stack dùng image upstream `decolua/9router:<tag>` chứ **không clone source**. Dockerfile wrapper chỉ:

- `FROM decolua/9router:${NINE_ROUTER_VERSION_TAG}` (build-arg).
- `apk add --no-cache wget curl ca-certificates` (cần cho healthcheck + outbound debug).
- Giữ nguyên `entrypoint` / `CMD` / `USER` của upstream.

Build context: `./services/9router`. Image tag: `${PROJECT_NAME}-9router:<slug>`.
