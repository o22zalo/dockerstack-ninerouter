# Deploy Code service

`deploy-code` là sidecar tuỳ chọn để quản lý self-deploy cho stack này: kiểm tra Git, deploy theo branch, nhận ZIP source, rebuild đúng Compose service và điều khiển service/container theo allowlist.

## Trạng thái mặc định

- Compose layer: `docker-compose/compose.deploy.yml`
- Service: `deploy-code`
- Profile: `deploy-code`
- Mặc định tắt: `DOCKER_DEPLOY_CODE_ENABLED=false`
- UI/API public qua Caddy/Cloudflared: `http(s)://deploy.${DOMAIN}`
- UI/API Tailnet direct: `http://${PROJECT_NAME_TAILSCALE}.${TAILSCALE_TAILNET_DOMAIN}:${DOCKER_DEPLOY_CODE_HOST_PORT}`
- Logs: `${DOCKER_VOLUMES_ROOT}/deploy-code/logs/deploy-code.log`

Service chỉ được tạo khi bật `DOCKER_DEPLOY_CODE_ENABLED=true`, nên không ảnh hưởng app/core/ops/access khi chưa dùng.

## Development

Kiểm tra syntax backend:

```bash
cd services/deploy-code
npm run check
```

Chạy backend/UI local ngoài Docker:

```bash
cd services/deploy-code
DOCKER_DEPLOY_CODE_ENABLED=true \
DOCKER_DEPLOY_CODE_REQUIRE_TOKEN=false \
DOCKER_DEPLOY_CODE_REPO_DIR=../.. \
DOCKER_DEPLOY_CODE_LOG_DIR=../../.docker-volumes/deploy-code/local-logs \
DOCKER_DEPLOY_CODE_TEMP_DIR=../../.docker-volumes/deploy-code/local-tmp \
DOCKER_DEPLOY_CODE_BACKUP_DIR=../../.docker-volumes/deploy-code/local-backups \
npm start
```

Mở `http://127.0.0.1:53999`. Local mode phù hợp để sửa UI/API, nhưng các thao tác Docker deploy chỉ đầy đủ khi chạy trong compose vì cần Docker CLI/socket và mount workspace.

Chạy container riêng:

```bash
DOCKER_DEPLOY_CODE_ENABLED=true bash docker-compose/scripts/dc.sh up -d --build deploy-code
bash docker-compose/scripts/dc.sh logs -f --tail=100 deploy-code
```

## Deploy

1. Điền `.env`:

```env
DOCKER_DEPLOY_CODE_ENABLED=true
DOCKER_DEPLOY_CODE_API_TOKEN=<long-random-token>
DOCKER_DEPLOY_CODE_REQUIRE_TOKEN=true
DOCKER_DEPLOY_CODE_CADDY_HOSTS=deploy.${DOMAIN}
DOCKER_DEPLOY_CODE_DEPLOY_SERVICES=app
DOCKER_DEPLOY_CODE_SERVICE_ALLOWLIST=app
DOCKER_DEPLOY_CODE_CONTAINER_ALLOWLIST=main-app,deploy-code
```

2. Đảm bảo `cloudflared/config.yml` có ingress:

```yaml
- hostname: deploy.<your-domain>
  service: http://caddy:80
```

3. Validate và bật stack:

```bash
npm run dockerapp-validate:env
npm run dockerapp-validate:compose
npm run dockerapp-exec:up
```

4. Truy cập:

- Cloudflared/Caddy: `https://deploy.${DOMAIN}`
- Tailnet direct: `http://${PROJECT_NAME_TAILSCALE}.${TAILSCALE_TAILNET_DOMAIN}:${DOCKER_DEPLOY_CODE_HOST_PORT}`

## Vận hành

Các thao tác chính trong UI:

- `Check`: `git fetch` và so sánh local/remote commit.
- `Deploy`: reset workspace về `${DOCKER_DEPLOY_CODE_REMOTE}/${DOCKER_DEPLOY_CODE_BRANCH}` rồi rebuild service trong `DOCKER_DEPLOY_CODE_DEPLOY_SERVICES`.
- `Force`: deploy kể cả khi commit không đổi.
- `Upload ZIP`: apply ZIP vào workspace bằng `rsync`, mặc định không xoá file ngoài ZIP và backup trước khi apply.
- `Services/Containers`: start/stop/restart/rebuild/logs theo allowlist.

File `.http` để kiểm thử nhanh trong IDE:

- `docs/.http/deploy-code.cloudflared.http`: gọi qua `https://deploy.${DOMAIN}` và Tinyauth.
- `docs/.http/deploy-code.tailscale.http`: gọi direct qua `http://${PROJECT_NAME_TAILSCALE}.${TAILSCALE_TAILNET_DOMAIN}:${DOCKER_DEPLOY_CODE_HOST_PORT}`.

API direct tương ứng:

```text
GET  /status
GET  /logs
POST /check
POST /deploy
POST /upload-zip
GET  /services
GET  /containers
POST /containers/start
POST /containers/stop
POST /containers/restart
POST /containers/rebuild
POST /containers/logs
POST /containers/inspect
```

Khi `DOCKER_DEPLOY_CODE_REQUIRE_TOKEN=true`, gửi token bằng header:

```bash
curl -H "x-deploy-code-token: $DOCKER_DEPLOY_CODE_API_TOKEN" \
  https://deploy.<your-domain>/status
```

## Safety notes

- Service mount Docker socket, nên quyền rất cao. Chỉ bật khi cần và luôn dùng Tinyauth + API token nếu expose qua Cloudflared.
- `DOCKER_DEPLOY_CODE_CONTAINER_ALLOW_ALL=false` là mặc định an toàn. Chỉ thêm service/container cần vận hành vào allowlist.
- Git deploy có bước `git reset --hard <remote>/<branch>`. Trước khi dùng trên môi trường có thay đổi local chưa commit, hãy commit/stash/push trước.
- ZIP deploy mặc định exclude `.git`, `.env`, `.docker-volumes`, `node_modules`; giữ nguyên các exclude này trừ khi thật sự cần đổi.

## Tắt

```env
DOCKER_DEPLOY_CODE_ENABLED=false
```

Sau đó chạy:

```bash
npm run dockerapp-exec:up
```

Compose sẽ bỏ profile `deploy-code`; service không còn chạy, các phần còn lại của stack giữ nguyên.
