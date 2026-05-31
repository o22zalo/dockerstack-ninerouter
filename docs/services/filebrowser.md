# Filebrowser service (`docker-compose/compose.ops.yml`)

## Vai trò
- Duyệt file/log trên web.

## Kích hoạt
- `ENABLE_FILEBROWSER=true` -> profile `filebrowser`.

## Cấu hình
- Image: `filebrowser/filebrowser:v2.30.0`
- Command chạy `--noauth` (đã bảo vệ bên ngoài bằng Tinyauth qua Caddy `forward_auth`).
- Mount:
  - `.:/srv/workspace`
  - `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}:/srv/docker-volumes:ro`
  - `./logs:/srv/logs:ro`
  - `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/filebrowser/database:/database`

## ENV liên quan
- `ENABLE_FILEBROWSER`
- `DOCKER_VOLUMES_ROOT` (optional, default `./.docker-volumes`)
- `PROJECT_NAME`, `DOMAIN`, `TINYAUTH_PORT`

## Cảnh báo
- Vì mount toàn bộ project + runtime data nên cần kiểm soát chặt danh sách user trong Tinyauth.

## Truy cập qua Tailscale
- URL: `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${FILEBROWSER_HOST_PORT:-18081}`
- Cổng host: `FILEBROWSER_HOST_PORT` (default `18081`).
