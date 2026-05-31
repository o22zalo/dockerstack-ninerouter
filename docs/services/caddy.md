# Caddy service (`docker-compose/compose.core.yml`)

## Vai trò
- Reverse proxy động từ Docker labels.
- Gom route cho app + dịch vụ ops.

## Cấu hình chính
- Image: `lucaslorentz/caddy-docker-proxy:2.9.1-alpine`
- Port publish: `80:80`
- Volumes:
  - Docker socket read-only
  - `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/caddy/data:/data`
  - `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/caddy/config:/config`
- Label global:
  - `caddy.email=${CADDY_EMAIL}`
  - `caddy.auto_https=disable_redirects`

## ENV liên quan
- `CADDY_EMAIL` (**bắt buộc**): email đăng ký cert.
- `DOCKER_SOCK` (optional): override đường dẫn Docker socket.
- `DOCKER_VOLUMES_ROOT` (optional): root thư mục runtime data trên host.
- `PROJECT_NAME` (**bắt buộc**): dùng để định danh ingress network `${PROJECT_NAME}_net`.

## Lưu ý
- Public traffic hiện đi qua Cloudflare Tunnel nên upstream từ cloudflared vào Caddy bằng HTTP nội bộ.
- `caddy.auto_https=disable_redirects` giữ nguyên để tránh redirect HTTP↔HTTPS sai khi đi qua Cloudflared/Tailscale.
- Auth cho route service dùng `forward_auth` tới Tinyauth, không dùng Caddy Basic Auth.

## Auth labels chuẩn
```yaml
- "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
- "caddy.forward_auth.uri=/api/auth/caddy"
- "caddy.forward_auth.header_up=X-Forwarded-Proto https"
- "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
```
