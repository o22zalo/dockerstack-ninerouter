# Tinyauth service (`docker-compose/compose.auth.yml`)

## Vai trò
- Là lớp xác thực chung cho các route Caddy qua `forward_auth`.
- Thay thế toàn bộ Caddy Basic Auth cũ.
- Dùng được cho app chính, ops services, deploy-code và app bổ sung sau này.

## Compose layer
- File: `docker-compose/compose.auth.yml`.
- `dc.sh` nạp layer này ngay sau `compose.core.yml` và trước ops/access/app.
- Service `tinyauth` không dùng `env_file`; compose chỉ map các biến Tinyauth v5 hợp lệ vào container để tránh container đọc nhầm biến template/deprecated.

## Cấu hình chính
- Service: `tinyauth`
- Container: `tinyauth`
- Image: `ghcr.io/steveiliop56/tinyauth:v5`
- Network: `app_net`
- Data volume: `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tinyauth:/data`
- DB runtime: `/data/${TINYAUTH_DB_FILE}`
- Public auth URL: `https://auth.${DOMAIN}`

Các label Caddy vẫn dùng `http://...` vì Cloudflared/Tailscale terminate HTTPS rồi proxy HTTP nội bộ vào Caddy. `TINYAUTH_APP_URL` phải là URL HTTPS public để cookie/redirect đúng scheme.

## Caddy integration
Các service cần bảo vệ thêm labels:

```yaml
- "caddy.forward_auth=tinyauth:${TINYAUTH_PORT:-3000}"
- "caddy.forward_auth.uri=/api/auth/caddy"
- "caddy.forward_auth.header_up=X-Forwarded-Proto https"
- "caddy.forward_auth.copy_headers=Remote-User Remote-Email Remote-Name Remote-Groups"
```

Giữ label `reverse_proxy` của service như cũ. Header `X-Forwarded-Proto https` giúp Tinyauth nhìn đúng scheme public khi request đi qua Cloudflared/Tailscale vào Caddy bằng HTTP nội bộ.

## ENV cần thiết
- `TINYAUTH_APP_URL`: public URL của Tinyauth, ví dụ `https://auth.${DOMAIN}`.
- `TINYAUTH_PORT`: port nội bộ Tinyauth, mặc định `3000`.
- `TINYAUTH_DB_FILE`: tên file SQLite trong volume Tinyauth, mặc định `tinyauth.db`.
- `TINYAUTH_USERS`: users tĩnh, comma-separated, bắt buộc dùng bcrypt: `username:bcrypt_hash[:totp]`.
- `TINYAUTH_COOKIE_SECURE`: `true|false`, giữ `true` khi đi qua HTTPS tunnel.
- `TINYAUTH_TRUSTED_PROXIES`: danh sách IP/CIDR của proxy tin cậy, mặc định nên gồm private Docker ranges.
- `TINYAUTH_LOG_LEVEL`: `trace|debug|info|warn|error`.

Mapping runtime v5:
- `TINYAUTH_APP_URL` -> `TINYAUTH_APPURL`
- `TINYAUTH_USERS` -> `TINYAUTH_AUTH_USERS`
- `TINYAUTH_COOKIE_SECURE` -> `TINYAUTH_AUTH_SECURECOOKIE`
- `TINYAUTH_TRUSTED_PROXIES` -> `TINYAUTH_AUTH_TRUSTEDPROXIES`
- `TINYAUTH_DB_FILE` -> `TINYAUTH_DATABASE_PATH=/data/<file>`

## Tạo bcrypt user

```bash
docker run -it --rm ghcr.io/steveiliop56/tinyauth:v5 user create --interactive
```

Chọn tùy chọn `format for Docker`, rồi đưa output vào `TINYAUTH_USERS`. Không dùng plain password như `admin:changeme`.

## OAuth ENV phổ biến
- `TINYAUTH_OAUTH_AUTO_REDIRECT`: `none`, `github`, `google`, `generic`, hoặc provider id khác.
- `TINYAUTH_OAUTH_WHITELIST`: whitelist email/domain/regex cho OAuth.
- Google:
  - `TINYAUTH_GOOGLE_CLIENT_ID`
  - `TINYAUTH_GOOGLE_CLIENT_SECRET`
  - Console: https://console.cloud.google.com/apis/credentials
- GitHub:
  - `TINYAUTH_GITHUB_CLIENT_ID`
  - `TINYAUTH_GITHUB_CLIENT_SECRET`
  - OAuth Apps: https://github.com/settings/developers
- Generic OAuth/OIDC:
  - `TINYAUTH_GENERIC_CLIENT_ID`
  - `TINYAUTH_GENERIC_CLIENT_SECRET`
  - `TINYAUTH_GENERIC_AUTH_URL`
  - `TINYAUTH_GENERIC_TOKEN_URL`
  - `TINYAUTH_GENERIC_USER_INFO_URL`
  - `TINYAUTH_GENERIC_SCOPES`
  - `TINYAUTH_GENERIC_REDIRECT_URL`
  - `TINYAUTH_GENERIC_NAME`

## Quy trình triển khai
1. Điền `TINYAUTH_APP_URL` bằng URL HTTPS public.
2. Generate bcrypt user riêng cho deployment và cập nhật `TINYAUTH_USERS`.
3. Giữ `TINYAUTH_COOKIE_SECURE=true` và cấu hình `TINYAUTH_TRUSTED_PROXIES`.
4. Đảm bảo `LITESTREAM_REPLICATE_DBS` có `tinyauth` nếu muốn backup DB auth.
5. Lần đầu deploy: `LITESTREAM_INIT_MODE=true`.
6. Sau khi login/config ổn: đổi `LITESTREAM_INIT_MODE=false` để các lần deploy sau bắt buộc restore.
7. Chạy: `bash docker-compose/scripts/dc.sh up -d --build --remove-orphans`.

## Vận hành
- Logs: `bash docker-compose/scripts/dc.sh logs -f tinyauth`.
- Restart: `bash docker-compose/scripts/dc.sh restart tinyauth`.
- DB nằm ở `${DOCKER_VOLUMES_ROOT}/tinyauth/${TINYAUTH_DB_FILE}`.
- Không xóa DB local khi `LITESTREAM_INIT_MODE=false` nếu chưa chắc replica S3 restore được.

## Legacy cần bỏ
- `TINYAUTH_SECRET`
- `TINYAUTH_DISABLE_CONTINUE`
- `TINYAUTH_TRUST_PROXY`
- `TINYAUTH_ALLOWED_USERS`
- `TINYAUTH_ALLOWED_DOMAINS`
- `TINYAUTH_ALLOWED_GROUPS`
- `TINYAUTH_OIDC_ISSUER`, `TINYAUTH_OIDC_CLIENT_ID`, `TINYAUTH_OIDC_CLIENT_SECRET`, `TINYAUTH_OIDC_SCOPES`
