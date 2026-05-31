# WebSSH services (`docker-compose/compose.ops.yml`)

## Vai trò
- Terminal qua web để truy cập shell host.

## Kích hoạt
- `ENABLE_WEBSSH=true`.
- Linux: profile `webssh-linux`.
- Windows/WSL: profile `webssh-windows`.

## Linux variant (`webssh`)
- Build từ `services/webssh`.
- Dùng `ttyd` gọi `ssh` vào `host.docker.internal`.
- ENV liên quan:
  - `CUR_WHOAMI` (default runner)
  - `CUR_WORK_DIR` (default /home/runner)
  - `SHELL` (default /bin/bash)

## Windows variant (`webssh-windows`)
- Image `alpine/socat` bridge cổng 7681 vào host.
- Cần host có ttyd chạy sẵn.

## Route
- `ttyd.${PROJECT_NAME}.${DOMAIN}`

## Truy cập qua Tailscale
- URL: `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${WEBSSH_HOST_PORT:-17681}`
- Cổng host: `WEBSSH_HOST_PORT` (default `17681`).
