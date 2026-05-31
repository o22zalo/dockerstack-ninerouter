# Dozzle service (`docker-compose/compose.ops.yml`)

## Vai trò
- Quan sát log realtime cho containers.

## Kích hoạt
- Bật khi `ENABLE_DOZZLE=true`.
- `dc.sh` sẽ thêm `--profile dozzle`.

## Cấu hình
- Image: `amir20/dozzle:latest`
- Mount docker socket read-only.
- Hostname route: `logs.${PROJECT_NAME}.${DOMAIN}`.

## ENV liên quan
- `ENABLE_DOZZLE`: bật/tắt.
- `DOCKER_SOCK`: đường dẫn socket.
- `PROJECT_NAME`, `DOMAIN`, `TINYAUTH_PORT`.

## Truy cập qua Tailscale
- URL: `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${DOZZLE_HOST_PORT:-18080}`
- Cổng host: `DOZZLE_HOST_PORT` (default `18080`).
