# Tailscale services (`docker-compose/compose.access.yml`)

## Vai trò
- Truy cập riêng tư qua tailnet cho môi trường nội bộ.
- Kèm cơ chế keep-ip backup/restore state.
- Toàn bộ state/certs lưu trên host tại `${DOCKER_VOLUMES_ROOT:-./.docker-volumes}/tailscale/var-lib`.

## Kích hoạt
- `ENABLE_TAILSCALE=true`.
- Linux: `tailscale-linux` + keep-ip linux jobs + `tailscale-watchdog-linux`.
- Windows: `tailscale-windows` + keep-ip windows jobs + `tailscale-watchdog-windows`.

## ENV bắt buộc khi bật
- `TAILSCALE_AUTHKEY`
- `TAILSCALE_TAILNET_DOMAIN`

## ENV optional quan trọng
- `DOCKER_VOLUMES_ROOT` (default `./.docker-volumes`)
- `TAILSCALE_TAGS` (default `tag:container`)
- `TAILSCALE_ACCEPT_DNS` (`true|false`, default `false`)
- `TAILSCALE_KEEP_IP_ENABLE` (`true|false`)
- `TAILSCALE_KEEP_IP_FIREBASE_URL` (bắt buộc nếu keep-ip bật)
- `TAILSCALE_KEEP_IP_CERTS_DIR` (default `/var/lib/tailscale/certs`)
- `TAILSCALE_KEEP_IP_INTERVAL_SEC` (default 30)
- `TAILSCALE_KEEP_IP_REMOVE_HOSTNAME_ENABLE`
- `TAILSCALE_CLIENTID`
- `TAILSCALE_AUTHKEY` (dùng cho join tailnet + API token flow)
- `TAILSCALE_WATCHDOG_MODE` (`monitor|heal`, default compose `heal`)
- `TAILSCALE_WATCHDOG_INTERVAL_SEC` (default 30)
- `TAILSCALE_WATCHDOG_ALERT_EVERY` (default 5)
- `TAILSCALE_WATCHDOG_LOG_OK_EVERY` (default 10)
- `TAILSCALE_WATCHDOG_RECONNECT_MIN_SEC` (default 60)
- `TAILSCALE_WATCHDOG_HEAL_AFTER_STREAK` (default 2)
- `TAILSCALE_WATCHDOG_UP_ACCEPT_DNS` (`true|false`, default `false`)
- `TAILSCALE_SOCKET` (default `/tmp/tailscaled.sock`)

## Keep-IP logic
- `prepare`: khôi phục state/certs trước khi daemon chạy.
- `backup-loop`: định kỳ đẩy state/certs lên Firebase RTDB.
- Nếu bật `REMOVE_HOSTNAME`, script sẽ gọi API để dọn hostname cũ tránh conflict IP.

## Watchdog monitoring + auto-heal
- Script: `tailscale/tailscale-watchdog.js`
- Chay: `npm run tailscale-watchdog`
- Luu y: watchdog can truy cap duoc Tailscale local API socket (`TAILSCALE_SOCKET`, mac dinh `/tmp/tailscaled.sock`) trong runtime dang chay `tailscaled`.
- Watchdog sidecar build tu `tailscale/Dockerfile.watchdog` (co san `tailscale` CLI de auto-heal).
- Mac dinh compose: `TAILSCALE_WATCHDOG_MODE=heal` + `TAILSCALE_WATCHDOG_AUTO_RECONNECT=true`.
- Mac dinh reconnect dung `--accept-dns=false` de tranh loi ghi `/etc/resolv.conf` trong container.
- Log co ma su kien de grep nhanh root cause:
- `TSWD_SOCKET_UNREACHABLE`: khong noi duoc local API socket
- `TSWD_NOT_RUNNING`: `BackendState`/`Self.Online` dang loi, kem health + netcheck + DNS snapshot
- `TSWD_DNS_MAGIC_MISSING`: thieu `100.100.100.100` trong `resolv.conf`
- `TSWD_HEALTH_WARN`: canh bao tu `status.Health[]`
- `TSWD_SELF_IDENTITY`: node id/dns name/hostname hien tai de doi chieu dung record tren Tailscale admin
- `TSWD_RECONNECT_WAIT`: node dang loi nhung chua du streak de goi heal
- `TSWD_RECOVERED`: node quay lai trang thai online

## Kiểm tra
- Container tailscale chạy ổn định.
- Có thể resolve/truy cập `https://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}`.

## Hostname + port cho dịch vụ Ops
- Dozzle: `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${DOZZLE_HOST_PORT:-18080}`
- Filebrowser: `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${FILEBROWSER_HOST_PORT:-18081}`
- WebSSH: `http://${PROJECT_NAME}.${TAILSCALE_TAILNET_DOMAIN}:${WEBSSH_HOST_PORT:-17681}`
